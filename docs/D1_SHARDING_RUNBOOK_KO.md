# D1 샤딩·비동기 쓰기 운영 Runbook

이 문서는 Issue 60·61·62 구현을 운영 환경에서 안전하게 활성화하고 장애를 복구하는 절차를 정의한다. 기존 D1은 `cohort=0`, `epoch=0`, `ordinal=0`인 legacy shard로 유지하며 물리 이름, UUID, row, 공개 ID를 변경하지 않는다.

Cloudflare 물리 한도, 90% rotation, 실시간 fanout tree와 binding gateway 절차는 [CLOUDFLARE_REAL_WORLD_LIMITS_KO.md](./CLOUDFLARE_REAL_WORLD_LIMITS_KO.md)를 함께 적용한다.

## 활성화 전 필수 조건

1. `D1_SHARD_LIMITS_GIB_JSON`에 모든 family의 `maxBytes`, `precreateRatio`, `activateRatio`, `hardStopRatio`를 지정하고 `precreate <= activate < hardStop < 1`인지 확인한다. 이름은 호환성을 위해 유지하지만 ratio mode는 GiB로 환산하지 않는다.
2. 용량 workflow가 만든 binding manifest 변경을 검토한다. 동일 legacy D1을 공유하는 family는 `sharedPhysicalDatabase`로 한 번만 계산되어야 한다.
   `D1_FAMILY_ROLLOUT_JSON`은 `config/d1-family-rollout.default.json`과 같은 schema를 사용하며, 실행당 legacy family 분리는 기본 한 개다. 실제 write/read canary가 끝나지 않은 family는 `readyFamilies`에서 제거한다.
3. 신규 shard에 family migration을 적용하고 catalog의 `schema_checksum`과 실제 schema checksum이 같은지 확인한다.
4. main Worker, queue consumer, email sender를 동일 manifest로 배포한다.
5. 비활성 shard에 read/write smoke test를 실행한다.
6. `.github/scripts/activate-d1-shards.mjs`의 compare-and-set 활성화가 성공한 뒤에만 이전 epoch를 `draining`으로 전환한다.

위 조건 중 하나라도 실패하면 shard를 `active`로 바꾸지 않는다. `unavailable` 또는 `precreated` 상태로 두고 원인을 제거한 후 동일 workflow를 재실행한다.

## 기능 게이트 순서

초기 배포에서는 다음 값을 유지한다.

```text
ASYNC_STATUS_WRITES=false
ASYNC_REGISTRATION_WRITES=false
SEARCH_FEED_READS=false
```

다음 순서로 canary cohort에서만 활성화한다.

1. typed command, `applied_operations`, transactional outbox, DLQ replay를 검증한다.
2. `ASYNC_REGISTRATION_WRITES`를 켜고 예약 충돌, 202 polling, pending login을 검증한다.
3. POSTS dual-write와 SEARCH_FEED shadow-read 결과를 legacy 응답과 비교한다.
4. cursor 중복과 권한 누락이 없음을 확인한 후 `SEARCH_FEED_READS`를 켠다.
5. 마지막으로 `ASYNC_STATUS_WRITES`를 켠다.

cohort가 가입을 받으려면 META, POSTS, GRAPH, INBOX, SEARCH_FEED, OPS 활성 shard와 `registration_v1` capability가 모두 필요하다. 사용 가능한 accepting cohort가 없으면 가입 요청을 journal에 저장하지 않고 `503 Retry-After`로 거절한다.

## 장애 대응

### 가입 backlog 또는 shard hard-stop

- accepting cohort에서 `sealed`, `unavailable`, hard-stop shard를 즉시 제외한다.
- 다른 준비된 cohort의 weight를 올린다. 준비된 cohort가 없다면 신규 가입을 503으로 제한한다.
- 이미 `202`를 반환한 operation은 RegistrationJournalDO와 registration saga를 기준으로 재개한다. 비밀번호 원문은 어느 저장소에도 없어야 한다.

### Queue/DLQ 장애

- operation ID와 대상 ordinal로 `applied_operations`를 먼저 확인한다.
- 적용되지 않은 operation만 journal 또는 outbox 원본에서 재발행한다.
- constraint 오류는 ShardWriterDO의 이분 분할 결과로 poison operation만 격리한다.
- 장기 실패는 OPS parking row의 body hash, error class, target shard를 대조한 뒤 retry 또는 discard한다.
- D1 commit 뒤 outbox가 남아 있으면 dispatcher를 재실행한다. source mutation을 직접 반복하지 않는다.

### 타임라인 partial response

- SEARCH_FEED epoch별 오류와 D1 connection 수를 확인한다. 한 invocation에서 동시에 여는 D1 연결은 6개를 넘기지 않는다.
- DO isolate가 재기동됐다는 이유만으로 POSTS shard를 스캔하지 않는다. 같은 object ID의 DO SQLite를 먼저 읽고, 비어 있거나 underfill이면 D1 SEARCH_FEED를 source of truth로 사용한다.
- fallback wave가 1회를 넘기기 시작하면 SEARCH_FEED epoch 수, projection lag, DO timeout을 경보한다. 총 D1 query는 epoch 수에 비례하므로 상시 fallback은 장애 상태다.
- public entry는 가용 shard 결과로 부분 응답할 수 있지만 metric을 남긴다.
- private/direct entry의 최신 GRAPH 권한 확인에 실패하면 해당 entry를 노출하지 않는다.
- 원격 미래 시각, invalid date 보정 증가는 도메인별로 확인하고 필요하면 REMOTE_INGEST를 격리한다.

## 복구 확인

- backlog가 지속적으로 감소하고 새 operation의 commit p95가 정상 범위로 돌아왔는지 확인한다.
- `accepted` operation 유실, `applied_operations` 중복, outbox 누락이 0인지 reconciliation을 실행한다.
- timeline을 `(sort_at_ms DESC, entity_id DESC)` cursor로 여러 페이지 조회해 중복을 확인한다.
- 삭제 saga가 META, POSTS/REMOTE_POSTS, GRAPH, INBOX, SEARCH_FEED, OPS에 tombstone을 모두 전파했는지 확인한다.
- 복구 직후에는 cohort weight와 feature flag를 한 번에 원복하지 말고 canary부터 단계적으로 복원한다.
