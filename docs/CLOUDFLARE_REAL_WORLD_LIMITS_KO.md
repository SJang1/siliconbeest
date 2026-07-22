# SiliconBeest Cloudflare 실제 한도와 초과 대응

이 문서는 대규모 가입·ActivityPub 유입·실시간 스트림이 동시에 발생할 때 적용할 물리 한도와 운영 기준을 정의한다. 수치는 2026-07-22 기준 Cloudflare 공식 문서를 기준으로 하며, 계약으로 늘릴 수 있는 quota와 단일 isolate/단일 물리 DB의 구조적 한도를 구분한다.

공식 참고 문서:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects WebSocket API](https://developers.cloudflare.com/durable-objects/api/state/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)

`/inbox` 전용 계산식, 8-lane Queue, 브라우저 count-only backpressure는 [INBOX_CAPACITY_AND_TIMELINE_BACKPRESSURE_KO.md](./INBOX_CAPACITY_AND_TIMELINE_BACKPRESSURE_KO.md)를 따른다.

## 확정 한도

| 항목 | 공식 한도 | SiliconBeest 기준 |
|---|---:|---:|
| Worker/DO isolate memory | 128MB | 정상 P99 64MB 이하, 96MB 경보 |
| 단일 DO 처리량 | soft 1,000 requests/s | leaf당 최대 400 WebSocket |
| DO WebSocket | 최대 32,768/DO | public 연결을 여러 leaf로 분산 |
| 동시 outgoing connection | invocation당 6 | fanout branch factor 최대 5 |
| Queue/Cron/DO alarm wall time | 15분 | consumer가 55초에 자발적으로 yield |
| Queue message | 128KB | streaming event 96KB 이하 |
| Queue batch | 최대 100 | DB/가입 workload 최대 32 |
| D1 물리 DB | 10,000,000,000 bytes | META 50%, 나머지 90%에서 epoch 전환 |
| D1 동시 연결 | invocation당 6 | feed partition read 최대 4, source 보충 포함 최대 6 |
| D1 binding | Worker당 약 5,000 | 4,000에서 shard gateway 분할 |

일반 DO RPC/HTTP는 호출자가 연결을 유지하는 동안 고정 15분 wall-time 제한이 없다. 15분 제한은 Queue consumer, Cron, DO alarm에 적용된다. CPU 시간과 wall time은 별도이며 CPU quota를 올려도 단일 DO가 single-threaded라는 사실은 바뀌지 않는다.

## 실시간 스트림 구조

기존 `__public__` 단일 StreamingDO는 사용하지 않는다. 기본 topology는 다음과 같다.

```text
stateless publish
  ├─ branch 0 ─ 5 children ─ 25 public leaves
  ├─ branch 1 ─ 5 children ─ 25 public leaves
  ├─ branch 2 ─ 5 children ─ 25 public leaves
  ├─ branch 3 ─ 5 children ─ 25 public leaves
  └─ branch 4 ─ 5 children ─ 25 public leaves
```

branch factor 5, depth 3이므로 public leaf는 125개다. leaf당 400소켓 기준 약 50,000개 public WebSocket을 수용한다. 특정 사용자는 stable hash로 같은 leaf에 연결되며, 해당 leaf가 포화되면 인접 leaf를 최대 2개 더 시도한다. 개인 stream은 계속 사용자별 DO를 사용한다.

한 leaf는 다음 보호 장치를 적용한다.

- 연결 400개를 넘으면 `503 Retry-After`를 반환한다.
- client send buffer가 262,144 bytes를 넘으면 1013으로 종료한다.
- event envelope가 98,304 bytes를 넘으면 live event를 버리고 REST timeline 재동기화에 맡긴다.
- ping/pong은 WebSocket Hibernation auto-response로 처리한다.

50,000개보다 많은 동시 public 연결이 필요하면 기존 연결을 유지한 상태에서 topology 값을 임의 변경하지 않는다. 새 deployment version에 depth 4 topology를 추가하고, 구 topology와 신 topology에 일정 시간 dual-publish한 뒤 클라이언트를 순차 reconnect해야 한다. branch factor 5, depth 4는 625 leaf이며 leaf당 400개 기준 250,000개 연결을 수용한다.

## 최신 timeline index

단건 entity 조회와 timeline 조회는 경로가 다르다.

- format 1 ID는 20-bit physical ordinal을 decode하고 generated binding manifest에서 바로 D1을 선택한다. control DB에서 shard를 찾는 query는 하지 않는다.
- legacy ID는 randomness를 해석하지 않고 META의 `entity_routes`를 조회한다. 따라서 cold path는 route 1회 + target 1회이며, 아직 이동하지 않은 ordinal 0 row는 legacy DB에서 끝난다.
- timeline은 entity ID를 하나씩 route하지 않는다. 사용자/public/tag별 SEARCH_FEED snapshot이 `source_ordinal`을 포함하므로 후보를 ordinal별로 묶어 source를 조회한다. D1의 100 bound-parameter 제한 때문에 한 query의 ID는 80개 이하로 유지한다.

모든 과거 POSTS/REMOTE_POSTS shard에 시간순 query를 보내지 않는다. `RealtimeFeedIndexDO`가 feed별 최신 후보를 SQLite ring으로 최대 512개 유지한다.

- home feed는 사용자별 DO 한 개를 사용한다.
- public/all·local·remote 계열은 entity hash 기준 4개 partition을 사용한다. media/tag projector가 준비되기 전에는 해당 feed를 D1에서 읽는다.
- read는 최대 4개 DO를 병렬 조회한 뒤 `(sort_at_ms DESC, entity_id DESC)`로 merge한다.
- DO index는 cache/read accelerator이며 D1 SEARCH_FEED가 source of truth다. DO isolate의 eviction, hibernation, 재배치는 같은 object ID의 SQLite storage를 삭제하지 않는다. 따라서 재기동은 빈 메모리 cache로 시작할 수 있어도 최신 512개 SQLite row는 다시 읽을 수 있다.
- source version이 낮은 update는 무시한다. tombstone row 자체를 보존하므로 Delete보다 늦게 도착한 과거 Create도 후보를 되살리지 못한다.
- DO RPC timeout, 빈 index, page underfill 또는 projection 누락이 의심되면 SEARCH_FEED snapshot으로 fallback하고 reconciliation으로 ring을 복구한다. API 요청 중 POSTS/REMOTE_POSTS 전체를 재스캔해 DO를 복구하지 않는다.

이 구조는 정상적인 최근 페이지에서 수백·수천 개 POSTS/REMOTE_POSTS binding을 순회하는 문제를 제거한다. `readRealtimeFeed()`는 DO가 실패하거나 필요한 개수보다 적게 반환하면 배포 manifest에 있는 해당 cohort의 SEARCH_FEED D1을 읽고, source version이 가장 큰 row와 tombstone을 우선한 뒤 전역 tuple로 merge한다. 한 wave의 동시 D1 연결은 6개 이하이며 correctness fallback의 D1 read는 replica lag로 committed row가 사라져 보이지 않도록 Sessions API의 `first-primary` session을 사용한다.

`SEARCH_FEED_READS=true` canary에서는 home/public 최신 첫 페이지가 DO에서 최대 `limit × 4`개의 후보 ID만 얻는다. 실제 응답 전에는 D1에서 visibility, block/mute, suspension, delete 상태를 다시 확인하며, 필터 후 결과가 부족하면 D1 feed index와 source query를 사용한다. 서명 cursor가 있는 과거 페이지도 같은 tuple을 D1 SEARCH_FEED fallback에 전달한다.

조회 비용은 다음과 같다.

| 상황 | 후보 index 조회 | source/권한 확인 |
|---|---:|---:|
| 정상 home 최신 | DO 1회 | shard ordinal별 묶음 query |
| 정상 public 최신 | DO 4회 병렬 | shard ordinal별 묶음 query |
| DO 재기동/timeout, legacy만 존재 | D1 1회 | legacy D1 query |
| DO 실패, SEARCH_FEED epoch `E`개 | D1 `E`회, 최대 6개씩 | 후보의 source ordinal별 query |

마지막 행은 결과 누락을 피하는 재해복구 경로이므로 모든 readable SEARCH_FEED epoch를 확인한다. 동시 연결은 6개로 제한되지만 총 query 수는 `E`에 비례한다. 이것을 정상 경로로 사용하면 안 된다. epoch가 많아질 때도 D1 fallback을 상수 비용으로 만들려면 feed를 `sort_at_ms` time segment로 배치하고, cursor가 segment→ordinal을 직접 찾는 영속 2단 directory를 먼저 배포해야 한다. 그 전에는 `SEARCH_FEED_READS`를 canary로 유지하고 DO fallback wave 수와 latency를 경보한다. 즉 현재 구현은 **primary 기준 read, 전역 정렬·version/tombstone 병합, 6-connection 한도는 보장하지만, DO 전체 장애 시 epoch 수와 무관한 O(1) query까지 보장한다고 주장하지 않는다.**

## 초기 배포와 자동 family 분리

새 인스턴스는 family별 D1을 여덟 개 만드는 대신 물리 legacy D1 하나로 시작한다. `DB_META_C000` binding 하나를 META, POSTS, GRAPH, INBOX, REMOTE_ACTORS, REMOTE_POSTS, SEARCH_FEED, OPS의 `cohort=0/epoch=0/ordinal=0` alias로 등록한다. Queue consumer 수와 DO object 수는 트래픽에 따라 자동 생성되지만 D1 물리 DB는 이 한 개에서 시작한다.

일일 `D1 Shard Capacity` workflow는 물리 legacy DB를 한 번만 측정하고 다음 순서에서 아직 분리되지 않은 family 하나만 처리한다.

```text
POSTS → REMOTE_POSTS → SEARCH_FEED → GRAPH → INBOX → REMOTE_ACTORS → OPS
```

`config/d1-family-rollout.default.json`과 production의 `D1_FAMILY_ROLLOUT_JSON`이 순서, 준비 완료 family, 실행당 최대 분리 수를 결정한다. 기본값은 `maxLegacySplitsPerRun=1`, `readyFamilies=[]`인 fail-closed 상태다. canary가 끝난 family를 production variable에 순서대로 추가해야 CI가 증설한다. 한 family가 `precreated → binding 배포 → smoke test → CAS active`를 마치기 전에는 다음 family를 만들지 않는다. 배포 후 control catalog 상태를 다음 reconcile에서 manifest에 동기화하므로 workflow 재실행은 멱등이다. META 신규 cohort는 모든 필수 family와 가입 경로가 검증된 뒤 마지막에 별도로 늘린다.

수동 workflow 실행은 행사 전 prewarm 용도이며 같은 규칙을 우회하지 않는다. 따라서 legacy DB가 40%에 도달했다고 family D1 일곱 개가 동시에 생기지 않는다.

## D1 50%·90% 정책

D1의 10GB는 decimal byte 기준이며 더 늘릴 수 없는 물리 상한이다. `GiB` 숫자로 9를 입력하면 약 9.66GB가 되어 의도한 90%보다 높아지므로 lifecycle 설정은 byte와 ratio로 계산한다.

| family | precreate | 신규 write 전환 | hard stop |
|---|---:|---:|---:|
| META | 40% / 4GB | 50% / 5GB | 85% / 8.5GB |
| 기타 family | 80% / 8GB | 90% / 9GB | 97% / 9.7GB |

90%에 도달하면 새 entity는 다음 epoch에 기록한다. 기존 entity의 update/delete는 ID ordinal이 가리키는 draining shard에서 계속 수행한다. 97%에서는 크기가 증가할 수 있는 mutation을 거절하고 명시적으로 `neutral` 또는 `reclaim`으로 분류된 작업만 허용한다.

100%까지 채우면 다음 문제가 발생한다.

- 길이가 증가하는 UPDATE는 새 SQLite page가 필요해 실패할 수 있다.
- DELETE는 row를 제거해도 파일 크기를 자동으로 줄이지 않는다.
- index rebuild나 VACUUM에도 임시 작업 공간이 필요할 수 있다.
- tombstone/outbox/applied-operation 기록조차 추가 page를 요구할 수 있다.

따라서 100%는 사용 가능한 운영 상태가 아니다. hard stop 97%에 도달하면 신규 write를 즉시 차단하고, outbox 정리·만료 데이터 삭제·별도 DB로의 archive/rebuild를 실행한다. META는 계정 상태·키·directory update 여유가 중요하므로 50%에서 신규 계정을 다음 cohort로 전환하고 15% 이상의 비상 여유를 유지한다.

legacy DB는 여러 family가 한 물리 DB를 공유하므로 가장 보수적인 META threshold를 물리 DB에 한 번 적용한다. 임계치에 도달해도 rollout 순서의 family 하나만 사전 생성·활성화하며, 이미 분리된 비legacy family DB부터는 자신의 80/90/97% 정책을 독립 적용한다. 신규 family shard가 활성화되기 전에 legacy DB를 50% 이상 성장시키면 안 된다.

## D1 binding 최대치 계산

공식 문서상 Worker script metadata는 최대 1,000,000 bytes이고 resource binding 하나는 약 150 bytes다. 다른 metadata가 전혀 없다면 단순 계산은 약 6,666개지만, Cloudflare가 명시한 D1 binding 상한은 약 5,000개다.

SiliconBeest는 250,000 bytes를 Worker·queue·secret·service binding metadata 여유로 예약한다.

```text
floor((1,000,000 - 250,000) / 150) = 5,000
documented limit                         = 5,000
calculated single-Worker maximum         = 5,000
operational soft limit                   = 4,000
```

현재 D1 기본 account 한도는 50,000개이므로 전부 사용하려면 최대 4,000개씩 최소 13개 shard gateway Worker가 필요하다. account storage 기본 한도 1TB가 먼저 적용되며 이 quota는 별도 증설 대상이다. 개별 D1의 10GB 한도는 증설할 수 없다.

## **이 최대치가 넘어가려 하면 대처법**

1. CI가 D1 binding 4,000개에서 신규 shard manifest 생성을 중단한다. 5,000개까지 억지로 채우지 않는다.
2. `.github/scripts/plan-d1-binding-gateways.mjs`로 ordinal range를 최대 4,000개 단위 gateway manifest로 나눈다.
3. main Worker와 queue consumer에는 모든 D1을 직접 binding하지 않고 소수의 shard gateway service binding만 둔다.
4. 각 gateway Worker는 자신의 ordinal range에 속한 D1만 binding하고 `execute(command)`/`query(readPlan)` RPC만 노출한다.
5. format 1 ID의 20-bit ordinal을 `gateway manifest → local binding` 순서로 해석한다. runtime control-DB lookup은 사용하지 않는다.
6. 기존 direct-binding 경로와 gateway 경로를 shadow 실행해 checksum과 row 결과가 일치하는지 확인한다.
7. canary ordinal부터 gateway를 active로 전환하고 direct binding을 제거한다.
8. gateway 하나가 80%인 3,200 binding에 도달하면 다음 gateway Worker를 미리 배포한다.
9. D1 account 50,000개 또는 account storage 1TB에 접근하면 Cloudflare limit increase를 먼저 승인받는다. 승인 전에는 새 cohort를 accepting 상태로 만들지 않는다.
10. 20-bit ordinal 1,048,575에 접근하는 것은 binding 문제가 아니라 ID format 소진이다. 그 전에 format version 2와 더 큰 route directory를 설계한다.

현재 구현은 4,000개에서 CI를 fail-closed하고 gateway 분할 manifest를 생성하는 단계까지 포함한다. 실제 gateway Worker와 main Worker의 gateway RPC 전환이 배포되기 전에는 4,001번째 binding을 추가하면 안 된다. gateway 분리는 binding ceiling을 해결하지만 단일 D1의 write 직렬화나 10GB 상한을 해결하지 않으므로 데이터 분포와 epoch rotation은 계속 필요하다.

## 메모리와 Queue 실행 예산

- request body는 Worker entry에서 TransformStream으로 전달하며 ActivityPub inbox는 96KiB, 일반 JSON/API는 2MB, import는 8MB, media는 32MB로 제한한다.
- TransformStream만으로 JSON을 의미 단위로 parse할 수는 없다. 현재 ActivityPub JSON은 2MB hard envelope 안에서 parse하며, 이를 초과하는 객체는 413/stream abort로 격리한다.
- 외부 응답은 Content-Length를 검증하고 필요한 byte까지만 읽는다. 전체 thread/collection을 한 번에 materialize하지 않는다.
- Queue DB/registration batch는 32개 이하로 유지한다.
- 일반 Queue consumer는 55초 wall budget에 도달하면 남은 message를 1초 delay retry하고 invocation을 종료한다.
- operation ID, aggregate/source version, `applied_operations` 때문에 이 yield와 재배달은 중복 mutation을 만들지 않는다.

## read-after-write

D1 replica에 즉시 read하면 이전 상태를 볼 수 있으므로 mutation 응답에 새 상태 또는 pending overlay를 직접 포함한다. 후속 read는 다음 순서로 일관성을 보장한다.

1. 동일 operation의 Journal overlay
2. D1 Sessions API bookmark를 사용한 replica read
3. commit outbox가 만든 SEARCH_FEED/RealtimeFeedIndex projection

RealtimeFeedIndexDO는 D1 commit을 대신하지 않으며, DO에만 존재하는 write를 성공 응답으로 간주하지 않는다.
