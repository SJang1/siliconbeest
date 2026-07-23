# `/inbox` 폭주 한도와 타임라인 backpressure

이 문서는 ActivityPub `/inbox` 유입과 그 결과로 발생하는 타임라인 갱신의 수용 한도를 정의한다. “Enterprise이면 무제한”을 전제로 하지 않으며, 공식 quota와 실제 부하 시험에서 측정한 drain rate 중 작은 값을 운영 한도로 사용한다.

공식 기준은 다음과 같다.

- Cloudflare Queue 하나의 생산 속도는 초당 5,000 message다. 초과 시 producer `send()`/`sendBatch()`가 오류를 반환한다.
- Queue 하나의 backlog는 25GB, message 하나는 128KB다.
- push consumer는 Queue 하나당 최대 250개 invocation까지 autoscale된다. 순서를 보장하지 않는다.
- Queue consumer wall time은 최대 15분이지만 SiliconBeest는 55초에 남은 message를 재시도해 retry feedback loop를 막는다.
- Worker/DO isolate memory는 128MB이며 invocation당 동시 outgoing connection은 6개다.

참고: [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

## 구현된 ingress 구조

```text
remote server
  → /inbox (request body 최대 96 KiB)
  → Fedify signature/auth + idempotence
  → QUEUE_INBOX (inbound 목적 단일 Queue)
  → autoscaling consumer (batch 10, timeout 1초, retry 5)
  → QUEUE_INBOX_DLQ (inbound 목적 단일 DLQ)
  → persistent parking table

local outbound federation
  → 별도 QUEUE_FEDERATION
```

inbox Queue의 **producer hard ceiling은 5,000 Activity/s**다. 목적별 Queue를 반드시 하나만 유지하므로 Queue 복제로 이 값을 곱하지 않는다. 한 HTTP delivery가 한 Queue message가 되고 serialized envelope가 128KB 미만이라는 조건에서만 성립한다. `/inbox` body를 96KiB로 제한한 이유는 Fedify wrapper와 metadata가 들어갈 여유를 확보하기 위해서다.

Queue 자체 순서는 신뢰하지 않는다. Fedify ordering key lock과 RemoteObjectJournalDO의 activity ID, source version, tombstone으로 동일 object의 중복과 역전을 무해하게 만든다. inbound와 outbound는 서로 다른 목적이므로 `QUEUE_INBOX`와 `QUEUE_FEDERATION`을 각각 하나씩 유지한다. 따라서 inbound 폭주가 Accept나 로컬 게시물의 외부 전달 Queue를 직접 점유하지 않는다.

## “이 리밋을 넘으면 더 처리하지 못한다”의 정확한 기준

5,000/s는 burst enqueue 상한이지 지속 처리량이 아니다. 지속 한도는 다음 식으로 매 배포 전 계산한다.

```text
hardProducerRps = 5,000
measuredDrainRps = effectiveConsumerConcurrency × 1,000 / p95MessageProcessMs
sustainableRps = min(hardProducerRps, measuredDrainRps)
safeAdmissionRps = floor(sustainableRps × 0.8)
```

다음 중 하나면 “현재 구성에서 처리 불가”다.

1. 순간 유입이 5,000/s를 넘는다. producer가 enqueue하지 못하므로 `/inbox`는 성공으로 위장하지 말고 재시도 가능한 5xx를 반환해야 한다.
2. 5분 이동평균 유입이 `safeAdmissionRps`를 넘는다. Queue를 더 만들었더라도 consumer/D1 drain보다 빨리 backlog가 증가한다.
3. `oldest_message_age`가 retention의 25%를 넘거나 backlog가 70%를 넘는다. 신규 도메인을 rate-limit하고 우선순위가 낮은 projection을 지연한다.
4. backlog가 25GB에 도달한다. 새 message는 Queue에 저장될 수 없다.
5. legacy `DB_META_C000` write saturation으로 measured drain이 목표보다 낮다. 목적별 Queue는 하나로 고정하므로 consumer profile과 REMOTE_ACTORS/REMOTE_POSTS/SEARCH_FEED shard routing을 개선해야 한다.

backlog가 가득 차는 예상 시간은 다음과 같다.

```text
estimatedMessages = 25,000,000,000 / averageSerializedMessageBytes
secondsToFull = estimatedMessages / (arrivalRps - measuredDrainRps)
```

`arrivalRps <= measuredDrainRps`이면 backlog는 지속적으로 증가하지 않는다. 계산은 실제 production load test 결과로 실행한다.

```bash
INBOX_CAPACITY_P95_PROCESS_MS=80 \
INBOX_CAPACITY_EFFECTIVE_CONCURRENCY=250 \
INBOX_CAPACITY_TARGET_RPS=2000 \
INBOX_CAPACITY_BURST_RPS=5000 \
INBOX_CAPACITY_AVG_MESSAGE_BYTES=16384 \
node .github/scripts/calculate-inbox-capacity.mjs
```

예시 값은 성능 보장이 아니다. CI의 target을 통과하려면 동일 payload mix(Create/Update/Delete/Follow/Like/Announce), 외부 actor cache miss, D1 timeout, duplicate delivery를 포함한 측정값을 넣어야 한다. target이 단일 Queue의 safe admission을 넘으면 accepting traffic을 늘리지 않는다.

## overload 단계

- 60% safe admission: 관측만 한다.
- 80%: media preview, trend, recommendation 같은 비필수 파생 작업을 늦춘다.
- 100%: domain별 공정성 제한을 적용하고 `Retry-After`가 있는 재시도 응답을 사용한다. 이미 Queue에 저장된 message를 버리지 않는다.
- backlog 70% 또는 retention 25% age: incident 상태로 전환하고 신규 relay/대량 backfill을 중단한다.
- Queue enqueue 실패: 202/200을 반환하지 않는다. 성공 응답 뒤 유실되는 것보다 원격 서버 재전송이 안전하다.
- DLQ 증가: 원문 body hash, actor/object, error class를 parking table에 보관한다. poison activity 하나가 batch 전체를 무한 재시도하게 두지 않는다.

## 기존 다중 Queue 배포의 단일 Queue 전환

이미 numbered inbox Queue가 배포된 환경에서는 binding만 먼저 제거하면 남은 backlog가 고립될 수 있다. 외부 Queue를 자동 삭제하지 않으며 다음 maintenance 절차로 전환한다.

1. `/inbox` admission을 일시적으로 닫고 `Retry-After`가 있는 503을 반환한다. 원격 서버가 Activity를 재전송하게 하며 성공으로 응답한 뒤 유실시키지 않는다.
2. 기존 inbox Queue의 backlog와 in-flight message가 모두 0인지 확인한다. DLQ는 재처리하거나 OPS parking table로 옮겨 소유자를 명확히 한다.
3. main Worker와 consumer를 함께 배포해 producer, consumer, DLQ를 각각 `QUEUE_INBOX`, `QUEUE_INBOX_DLQ` 하나로 교체한다.
4. smoke Activity가 단일 Queue를 거쳐 commit되고 timeline projection까지 도달하는지 확인한 뒤 admission을 연다.
5. 관측 기간 후 기존 numbered Queue가 계속 비어 있음을 다시 확인하고 별도 승인된 운영 작업으로 retire한다.

무중단 전환이 반드시 필요하면 이전 producer와 consumer를 잠시 병행해야 하므로 전환 구간에는 “목적별 정확히 하나” 제약을 만족할 수 없다. 이 프로젝트는 제약을 우선하여 짧은 재시도 가능 maintenance를 기본 전환 방식으로 사용한다.

## 브라우저 타임라인 메모리와 count-only mode

모든 mounted view가 해당 stream의 최신 위치에서 벗어나면 연결을 종료하지 않고 다음 control frame을 전송한다.

```json
{ "type": "pause_content", "stream": "public" }
```

StreamingDO는 `update` 본문을 socket마다 반복 전송하지 않고 1초 동안 합쳐 다음처럼 보낸다.

```json
{
  "event": "new_items",
  "payload": "{\"count\":381,\"streams\":{\"public\":381}}",
  "stream": ["public"]
}
```

클라이언트는 소리를 최대 초당 한 번만 재생하고 개수만 누적한다. 현재 제한은 다음과 같다.

- timeline ID 300개
- 아직 화면에 합치지 않은 WebSocket status body 50개
- status cache 5,000개 (boost 원문 포함)
- account cache 2,500개

50개 대기를 넘으면 client도 `pause_content`를 보내므로 scroll 감지가 실패해도 메모리가 무한 증가하지 않는다. “새 글 보기”를 누를 때 count-only 구간은 WebSocket payload로 복원하지 않고 REST API를 새로 호출한다. API read가 성공한 다음에만 `resume_content`를 보낸다.

## 최신 글 API 조회 순서

1. 첫 페이지는 feed별 RealtimeFeedIndexDO의 최대 512개 ring에서 `(sort_at_ms, entity_id)` 후보를 얻는다.
2. 후보를 source ordinal별로 묶고 D1에서 delete/suspension/visibility/block/mute를 재검증한다.
3. DO가 비어 있거나 필터 후 개수가 부족하면 SEARCH_FEED D1 read model로 fallback한다.
4. 오래된 페이지는 DO를 사용하지 않고 signed cursor의 tuple보다 작은 row만 keyset query한다.
5. epoch가 여러 개면 최대 6개 D1 연결씩 같은 tuple 조건으로 읽어 k-way merge한다. 모든 POSTS DB를 scan하지 않는다.

```sql
SELECT entity_id, sort_at_ms, source_ordinal,
       author_summary_json, entity_summary_json, visibility, audience_json
FROM feed_entries
WHERE feed_key = ?1
  AND (sort_at_ms < ?2 OR (sort_at_ms = ?2 AND entity_id < ?3))
  AND tombstoned_at IS NULL
ORDER BY sort_at_ms DESC, entity_id DESC
LIMIT ?4;
```

DO ring은 cache이며 source of truth가 아니다. 오래된 글, 재접속 gap, 권한 판단은 D1 SEARCH_FEED snapshot이 담당한다. client cursor에는 `(sortAtMs, entityId, catalogVersion)`을 HMAC 서명해 shard cutover 중에도 offset drift와 중복을 피한다.

## 단일 Queue 운영 한도를 올리기 위한 조건

목적별 단일 Queue 정책에서는 `/inbox`가 5,000 Activity/s producer ceiling을 넘을 수 없다. 따라서 별도 quota 조정 없이 “10,000 Activity/s 지속 처리 가능”으로 표시하지 않는다. 또한 현재 legacy row가 하나의 `DB_META_C000`에 남아 있는 동안 sustained drain은 해당 D1 primary write 처리량에도 묶인다. 다음 항목을 production canary에서 통과해야 운영 한도를 올릴 수 있다.

- REMOTE_ACTORS, REMOTE_POSTS, GRAPH, SEARCH_FEED의 여러 active shard로 실제 write routing
- 기본 quota에서는 4,000/s(5,000/s의 80%) 30분 + 5,000/s 5분 burst에서 accepted loss 0, duplicate mutation 0
- burst 종료 후 backlog 감소, oldest age가 retention 10% 이내
- Queue retry/DLQ가 정상 범위이고 outbound federation p95가 악화되지 않음
- timeline API와 WebSocket count-only 전환 중 브라우저 heap이 설정 상한에서 안정화

이 조건을 넘지 못해도 같은 목적의 Queue를 추가하지 않는다. processor profile, consumer autoscaling, D1 physical ordinal 분포, remote fetch cache miss를 먼저 분리 측정한 뒤 storage shard 수나 consumer 처리 효율을 늘린다. 단일 Queue의 5,000/s producer 한도 자체를 넘어야 한다면 Cloudflare가 해당 Queue의 quota를 명시적으로 조정하기 전에는 요구사항과 동시에 달성할 수 없으므로 admission control로 5xx/Retry-After를 반환한다. quota가 조정된 환경의 부하 시험 목표는 승인된 단일 Queue quota의 80% sustained와 100% burst로 다시 계산한다.
