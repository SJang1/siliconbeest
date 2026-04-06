# SiliconBeest Fedify 마이그레이션 문서

> **참고:** 이 문서는 이전 분리 아키텍처(`siliconbeest-worker/`)를 기준으로 작성되었습니다. 현재는 `siliconbeest/server/worker/`에 해당합니다.

## 1. 개요

### 배경

SiliconBeest는 Cloudflare Workers 기반 ActivityPub(Mastodon 호환) 서버이다. 기존에는 HTTP Signature 서명/검증, ActivityPub 직렬화, WebFinger, NodeInfo 등을 모두 자체 구현으로 처리했으나, Fedify v2.1.0 프레임워크로 마이그레이션하여 이 복잡한 인프라를 대체했다.

### 사용 패키지

| 패키지 | 버전 | 용도 |
|---|---|---|
| `@fedify/fedify` | ^2.1.0 | Federation 코어, vocab 타입, inbox/dispatcher 추상화 |
| `@fedify/cfworkers` | ^2.1.0 | Cloudflare Workers 어댑터 (WorkersKvStore, WorkersMessageQueue) |
| `@fedify/hono` | ^2.1.0 | Hono 프레임워크 미들웨어 통합 (worker만 사용) |

### 이전/이후 비교

| 영역 | 이전 | 이후 |
|---|---|---|
| Actor 직렬화 | `actorSerializer.ts` (수동 JSON-LD) | Fedify `setActorDispatcher` + Person/Application/Service vocab |
| WebFinger | `endpoints/wellknown/webfinger.ts` | Fedify 자동 등록 (actor dispatcher에 연동) |
| NodeInfo | `endpoints/wellknown/nodeinfo.ts` (2.0만) | Fedify `setNodeInfoDispatcher` (2.1) + 기존 2.0 유지 |
| Inbox 수신 | 수동 HTTP Signature 검증 + JSON 파싱 | Fedify `setInboxListeners` (자동 서명 검증) |
| 발신 서명 | `httpSignatures.ts` (수동 draft-cavage) | Fedify `sendActivity()` (draft-cavage + RFC 9421 + OIP) |
| 발신 배달 | `deliveryManager.ts` + `enqueueDelivery/enqueueFanout` | Fedify `ctx.sendActivity()` + WorkersMessageQueue |
| Activity 빌더 | `activityBuilder.ts` (수동 JSON 구성) | `build-activity.ts` (Fedify vocab 타입 사용) |
| Collection | 수동 Hono 엔드포인트 | Fedify collection dispatchers |
| KV 저장소 | 자체 관리 | WorkersKvStore (FEDIFY_KV) |

---

## 2. 아키텍처

### Fedify 미들웨어 구조 (per-request Federation 생성)

Cloudflare Workers에서는 환경 바인딩(D1, KV, Queue 등)이 글로벌이 아닌 **요청별**로만 접근 가능하다. 따라서 Fedify Federation 인스턴스를 매 요청마다 새로 생성한다.

**핵심 파일:** `siliconbeest-worker/src/federation/fedify.ts`

```
createFed(env) → createFederation({
  kv: new WorkersKvStore(env.FEDIFY_KV),
  queue: new WorkersMessageQueue(env.QUEUE_FEDERATION),
})
```

### 요청 흐름 다이어그램

```
                       ┌──────────────────────────────────────┐
                       │         Cloudflare Workers           │
                       │                                      │
   HTTP Request ──────►│  Hono Global Middleware              │
                       │    (requestId, cors, contentNeg,     │
                       │     logger, errorHandler)            │
                       │                                      │
                       │  ┌────────────────────────────────┐  │
                       │  │ Fedify Middleware (per-request)│  │
                       │  │                                │  │
                       │  │  1. createFed(env)             │  │
                       │  │  2. setupActorDispatcher(fed)  │  │
                       │  │  3. setupNodeInfoDispatcher    │  │
                       │  │  4. setupCollectionDispatchers │  │
                       │  │  5. setupInboxListeners        │  │
                       │  │  6. c.set('federation', fed)   │  │
                       │  │  7. federation() middleware    │  │
                       │  └──────────┬─────────────────────┘  │
                       │             │                        │
                       │   Fedify가 처리?                       │
                       │     ├── YES → Fedify 직접 응답         │
                       │     │   (WebFinger, NodeInfo 2.1,    │
                       │     │    Actor, Inbox, Collections)  │
                       │     │                                │
                       │     └── NO → Hono 라우터로 fall-through│
                       │         (API v1/v2, OAuth, Media,    │
                       │          /actor, /users/x Tombstone) │
                       └──────────────────────────────────────┘
```

### 발신 Activity 흐름

```
  Hono Route Handler
    │
    ├── const fed = c.get('federation')
    ├── Fedify vocab 객체 생성 (Follow, Like, Create 등)
    ├── sendToFollowers(fed, env, username, activity)
    │   └── ctx.sendActivity({ identifier }, "followers", activity)
    │       └── WorkersMessageQueue.send() → QUEUE_FEDERATION
    │
    └── sendToRecipient(fed, env, username, recipientUri, activity)
        └── ctx.sendActivity({ identifier }, new URL(recipientUri), activity)
            └── WorkersMessageQueue.send() → QUEUE_FEDERATION

  Queue Consumer (siliconbeest-queue-consumer)
    │
    ├── isFedifyMessage(body)?
    │   ├── YES → fed.processQueuedTask(body, { env })
    │   │         (Fedify가 키 조회, HTTP Signature 서명, 배달 수행)
    │   └── NO  → switch(legacyMsg.type) { ... }
    │             (deliver_activity, timeline_fanout, 등 기존 핸들러)
    └──
```

### Hono와 Fedify의 역할 분담

- **Fedify 담당**: WebFinger, NodeInfo 2.1, Actor 문서, Inbox (서명 검증 포함), Collections, 발신 서명/배달
- **Hono 담당**: Mastodon API v1/v2, OAuth, 미디어, Tombstone (HTTP 410), 인스턴스 액터 (/actor), NodeInfo 2.0, host-meta, 스트리밍

---

## 3. Fedify가 처리하는 것

### Actor Dispatcher (`/users/{identifier}`)

**파일:** `siliconbeest-worker/src/federation/dispatchers/actor.ts`

- `setActorDispatcher('/users/{identifier}', ...)` + `setKeyPairsDispatcher(...)`
- Person / Application / Service 타입 반환
- 프로필 필드 (`PropertyValue`), 커스텀 이모지 (`Emoji` 태그), 아바타/헤더 (`Image`)
- Endpoints (sharedInbox), 팔로워/팔로잉/아웃박스/featured/featuredTags 컬렉션 URI 설정
- `manuallyApprovesFollowers` (locked 계정), `discoverable`, `memorial`
- WebFinger 추가 링크: `http://webfinger.net/rel/profile-page`, `self` (application/activity+json)
- **Suspended 계정**: `null` 반환하여 Hono의 Tombstone 핸들러로 fall-through

**KeyPairs Dispatcher:**
- `actor_keys` 테이블에서 RSA + Ed25519 키쌍 로드
- RSA: RSASSA-PKCS1-v1_5 SHA-256 (draft-cavage HTTP Signatures)
- Ed25519: Object Integrity Proofs (FEP-8b32) + RFC 9421

### WebFinger (자동)

Fedify의 `setActorDispatcher` 등록 시 `/.well-known/webfinger` 자동 제공. 별도 코드 없음.

### NodeInfo 2.1

**파일:** `siliconbeest-worker/src/federation/dispatchers/nodeinfo.ts`

- `setNodeInfoDispatcher('/nodeinfo/2.1', ...)`
- Fedify가 `/.well-known/nodeinfo` (JRD 링크 문서)와 `/nodeinfo/2.1` (실제 데이터) 모두 처리
- 통계 캐싱: KV (`nodeinfo:stats:fedify`) + 1시간 TTL
- 기존 `/nodeinfo/2.0` 엔드포인트는 Hono에서 별도 유지 (호환성)

### Inbox Listeners (13개 Activity Type)

**파일:** `siliconbeest-worker/src/federation/listeners/inbox.ts`

`setInboxListeners('/users/{identifier}/inbox', '/inbox')` 호출로 개인 inbox + 공유 inbox 모두 등록.

| # | Activity 타입 | 프로세서 |
|---|---|---|
| 1 | Follow | `processFollow` |
| 2 | Create | `processCreate` |
| 3 | Accept | `processAccept` |
| 4 | Reject | `processReject` |
| 5 | Like | `processLike` (또는 `processEmojiReact` - Misskey 분기) |
| 6 | Announce | `processAnnounce` |
| 7 | Delete | `processDelete` |
| 8 | Update | `processUpdate` |
| 9 | Undo | `processUndo` |
| 10 | Block | `processBlock` |
| 11 | Move | `processMove` |
| 12 | Flag | `processFlag` |
| 13 | EmojiReact | `processEmojiReact` |

**처리 패턴:**
1. Fedify가 HTTP Signature 검증 완료
2. 리스너가 `activity.toJsonLd()` 호출
3. `adaptJsonLdToAPActivity()` (activity-adapter.ts)로 APActivity 포맷 변환
4. `resolveRecipientAccountId()`로 수신자 account_id 조회
5. 기존 프로세서 함수 호출

**Like → EmojiReact 분기 로직:**
Like 리스너에서 `isEmojiReaction(raw)` 검사. `_misskey_reaction` 또는 `content` 필드가 존재하면 `processEmojiReact`로 라우팅.

### Collection Dispatchers

**파일:** `siliconbeest-worker/src/federation/dispatchers/collections.ts`

| 컬렉션 | 경로 | 페이지 크기 |
|---|---|---|
| Followers | `/users/{identifier}/followers` | 40 |
| Following | `/users/{identifier}/following` | 40 |
| Outbox | `/users/{identifier}/outbox` | 20 |
| Featured | `/users/{identifier}/collections/featured` | 20 |
| Featured Tags | `/users/{identifier}/collections/tags` | 20 |

Fedify가 OrderedCollection / OrderedCollectionPage 래퍼, `@context`, 콘텐츠 네고시에이션을 자동 처리.

Outbox dispatcher 내부에서 StatusRow를 Fedify `Note` 객체로 변환하는 `buildNoteFromStatusRow()` 헬퍼 함수 사용 (collections.ts 599행 부근).

### Key Pairs Dispatcher (RSA + Ed25519)

**Worker:** `siliconbeest-worker/src/federation/dispatchers/actor.ts` 내 `.setKeyPairsDispatcher(...)`
**Queue Consumer:** `siliconbeest-queue-consumer/src/dispatchers.ts` (슬림 버전)

두 곳 모두 동일한 `actor_keys` 테이블에서 키를 로드하며:
- RSA 키쌍: PEM → `importRsaKeyPairFromPem()` (key-utils.ts)
- Ed25519 키쌍 (선택): base64url → `importEd25519KeyPairFromBase64url()` (key-utils.ts)

### 발신 Activity (sendActivity via WorkersMessageQueue)

**파일:** `siliconbeest-worker/src/federation/helpers/send.ts`

- `getFedifyContext(federation, env)` — Federation에서 Context 생성
- `sendToFollowers(federation, env, username, activity)` — 팔로워 전체 팬아웃
- `sendToRecipient(federation, env, username, recipientUri, activity)` — 특정 수신자 배달

Fedify 내부에서 WorkersMessageQueue를 통해 QUEUE_FEDERATION으로 메시지를 비동기 전송하고, Queue Consumer가 `processQueuedTask()`로 실제 HTTP 배달 수행.

---

## 4. Fedify로 교체된 파일 목록

### 삭제된 파일 (현재 main에 존재하지 않음, 이전 worktree에만 잔존)

| 삭제된 파일 | 대체된 Fedify 기능 |
|---|---|
| `federation/actorSerializer.ts` | `dispatchers/actor.ts` — Fedify `setActorDispatcher` |
| `federation/activityBuilder.ts` | `helpers/build-activity.ts` — Fedify vocab 타입 사용 |
| `federation/deliveryManager.ts` | `helpers/send.ts` — Fedify `ctx.sendActivity()` |
| `federation/noteSerializer.ts` | `dispatchers/collections.ts` 내 `buildNoteFromStatusRow()` + `statuses/create.ts`, `statuses/edit.ts`에서 직접 Fedify `Note` 사용 |
| `endpoints/wellknown/webfinger.ts` | Fedify 자동 등록 |
| `endpoints/activitypub/inbox.ts` | `listeners/inbox.ts` — Fedify `setInboxListeners` |
| `endpoints/activitypub/outbox.ts` | `dispatchers/collections.ts` — Fedify outbox collection dispatcher |
| `endpoints/activitypub/followers.ts` | `dispatchers/collections.ts` — Fedify followers collection dispatcher |
| `endpoints/activitypub/following.ts` | `dispatchers/collections.ts` — Fedify following collection dispatcher |
| `endpoints/activitypub/featured.ts` | `dispatchers/collections.ts` — Fedify featured collection dispatcher |

### 수정된 주요 파일

| 파일 | 변경 내용 |
|---|---|
| `siliconbeest-worker/src/index.ts` | Fedify 미들웨어 등록, per-request Federation 생성 패턴 |
| `siliconbeest-worker/src/env.ts` | `FEDIFY_KV: KVNamespace`, `QUEUE_FEDERATION: Queue`, `federation: Federation<FedifyContextData>` 추가 |
| `siliconbeest-queue-consumer/src/index.ts` | `isFedifyMessage()` 분기, `processQueuedTask()` 호출 |
| `statuses/create.ts` | Fedify `Note`, `Create`, `Mention`, `Hashtag` vocab 사용 + `sendToFollowers/sendToRecipient` |
| `statuses/edit.ts` | Fedify `Note`, `Update` vocab 사용 + `sendToFollowers` |
| `statuses/delete.ts` | `sendToFollowers` + Fedify `Delete` / `Tombstone` vocab |
| `statuses/favourite.ts` / `unfavourite.ts` | `sendToRecipient` + Fedify `Like` / `Undo` vocab |
| `statuses/reblog.ts` / `unreblog.ts` | `sendToFollowers` + Fedify `Announce` / `Undo` vocab |
| `statuses/reactions.ts` | `sendToRecipient` + Fedify `Like` + Misskey extension 주입 |
| `accounts/follow.ts` / `unfollow.ts` / `block.ts` / `unblock.ts` | `sendToRecipient` + Fedify vocab |
| `accounts/migration.ts` | `sendToFollowers` + Fedify `Move` + `lookupWebFinger`/`lookupObject` |
| `accounts/lookup.ts` | `lookupWebFinger`/`lookupObject` 사용 |
| `accounts/aliases.ts` | `lookupWebFinger` 사용 |
| `followRequests.ts` | `sendToRecipient` + Fedify `Accept`/`Reject` vocab |
| `reports.ts` | `ctx.sendActivity()` 직접 호출 + Fedify `Flag` vocab |
| `api/v2/search.ts` | `lookupWebFinger`/`lookupObject` 사용 |
| `api/v1/admin/relays.ts` | `buildFollowActivity`/`buildUndoActivity` (build-activity.ts) |

### 새로 생성된 파일

| 파일 | 용도 |
|---|---|
| `federation/fedify.ts` | createFed() 팩토리 + FedifyContextData 인터페이스 |
| `federation/dispatchers/actor.ts` | Actor dispatcher + KeyPairs dispatcher |
| `federation/dispatchers/nodeinfo.ts` | NodeInfo 2.1 dispatcher |
| `federation/dispatchers/collections.ts` | 5개 컬렉션 dispatcher |
| `federation/listeners/inbox.ts` | 13개 inbox listener |
| `federation/helpers/send.ts` | sendToFollowers, sendToRecipient, getFedifyContext |
| `federation/helpers/build-activity.ts` | Fedify vocab 기반 Activity 빌더 (13개 함수) |
| `federation/helpers/misskey-compat.ts` | Misskey/Pleroma 벤더 확장 주입/추출 |
| `federation/helpers/key-utils.ts` | PEM/base64url → CryptoKey 변환 |
| `federation/helpers/activity-adapter.ts` | JSON-LD → APActivity 어댑터 |
| `endpoints/activitypub/README.md` | Fedify로 못 옮긴 파일에 대한 상세 설명 |
| `siliconbeest-queue-consumer/src/fedify.ts` | Queue Consumer용 createFed() |
| `siliconbeest-queue-consumer/src/dispatchers.ts` | Queue Consumer용 actor/keyPairs dispatcher |

---

## 5. 유지된 레거시 파일과 이유

### `endpoints/activitypub/actor.ts` — Tombstone 폴백 (HTTP 410)

**이유:** Fedify의 `setActorDispatcher`는 `Actor | null`만 반환 가능. `Tombstone` 타입은 `Actor`가 아니므로 반환할 수 없고, HTTP 상태 코드를 410으로 지정할 방법도 없다.

**동작:** Fedify actor dispatcher가 suspended 계정에 대해 `null` 반환 → Hono로 fall-through → 이 라우트가 DB에서 `suspended_at` 확인 → HTTP 410 + Tombstone JSON-LD 응답.

### `endpoints/activitypub/instanceActor.ts` — 인스턴스 액터 (/actor 경로)

**이유:** Fedify의 `setActorDispatcher`는 단일 경로 패턴(`/users/{identifier}`)만 등록 가능. `/actor` 경로는 이 패턴에 매칭되지 않는다.

**추가 이유:**
- 이미 `https://domain/actor`로 릴레이들과 연합 완료 → URI 변경 불가
- `keyId`가 `https://domain/actor#main-key`로 고정 → 원격 서버 서명 검증 깨짐
- HTTP Redirect는 Mastodon의 서명 검증에서 미지원

**특이사항:** Lazy key generation 패턴 — 첫 요청 시 RSA 2048-bit 키쌍 자동 생성, `actor_keys` 테이블에 `account_id = '__instance__'`로 저장.

### `federation/httpSignatures.ts` — HTTP Signature 구현

**현재 상태:** 파일 존재하지만 **아무 곳에서도 import하지 않는다**. Fedify가 수신 서명 검증과 발신 서명을 모두 처리하므로 사실상 dead code.

**유지 이유:** 릴레이 관련 레거시 deliver_activity 핸들러가 Queue Consumer에서 아직 사용 중일 수 있음 (인스턴스 액터 서명 필요). 완전 제거는 릴레이 발신을 Fedify `sendActivity`로 전환한 후 가능.

### `federation/resolveRemoteAccount.ts` — 원격 계정 해석

**현재 상태:** 7개 inbox processor + `statuses/create.ts` + `accounts/migration.ts`에서 사용 중.

**역할:** 원격 actor URI를 받아 accounts 테이블에서 조회하거나, 없으면 actor document를 fetch하여 upsert. Fedify의 `lookupObject`와는 다른 역할 (DB upsert 포함).

### `federation/inboxProcessors/` 디렉토리 — 14개 프로세서

모든 inbox processor (`create.ts`, `follow.ts`, `like.ts`, `announce.ts`, `delete.ts`, `update.ts`, `undo.ts`, `block.ts`, `move.ts`, `flag.ts`, `accept.ts`, `reject.ts`, `emojiReact.ts`, `index.ts`)는 유지됨. Fedify inbox listener가 이 프로세서들을 호출하는 구조이므로, 비즈니스 로직은 그대로 유지.

---

## 6. Queue Consumer 마이그레이션

### QUEUE_FEDERATION에서 Fedify/Legacy 메시지 자동 분기

**파일:** `siliconbeest-queue-consumer/src/index.ts`

Queue Consumer는 `QUEUE_FEDERATION` 큐를 소비하며, 메시지가 Fedify 메시지인지 레거시 메시지인지 자동 판별한다:

```
isFedifyMessage(body): boolean
  - body에 type 필드가 없거나
  - type이 LEGACY_MESSAGE_TYPES 집합에 없으면
  → Fedify 메시지로 판정
```

`LEGACY_MESSAGE_TYPES` 집합:
- `deliver_activity`, `deliver_activity_fanout`, `timeline_fanout`, `create_notification`
- `process_media`, `fetch_remote_account`, `fetch_remote_status`, `send_web_push`
- `cleanup_expired_tokens`, `update_trends`, `fetch_preview_card`, `forward_activity`
- `deliver_report`, `update_instance_info`, `import_item`

### processQueuedTask 처리

Fedify 메시지 감지 시:
1. `createFed(env)` — Federation 인스턴스 생성
2. `setupActorDispatcher(fed)` — KeyPairs dispatcher 등록 (서명 키 조회 필요)
3. `fed.processQueuedTask(body, { env })` — Fedify가 활동 배달 수행
4. `msg.ack()` — 처리 완료

### dispatchers.ts (키쌍 로딩)

**파일:** `siliconbeest-queue-consumer/src/dispatchers.ts`

Worker의 actor dispatcher와 동일한 로직이지만 슬림 버전:
- Actor dispatcher는 항상 `null` 반환 (HTTP 응답 불필요)
- KeyPairs dispatcher만 실제 작동: `actor_keys` 테이블에서 RSA + Ed25519 키 로드
- PEM/base64url → CryptoKey 변환 헬퍼 자체 포함 (worker와 코드 공유 없이 독립)

### 기존 핸들러 유지

레거시 메시지 타입별 핸들러 모두 유지:
- `handleDeliverActivity` — 직접 HTTP 배달 (릴레이 등 인스턴스 액터 발신용)
- `handleDeliverActivityFanout` — 팔로워 일괄 배달 (레거시)
- `handleTimelineFanout` — 홈 타임라인 팬아웃
- `handleCreateNotification` — 알림 생성
- `handleProcessMedia` — 미디어 처리
- `handleFetchRemoteAccount` / `handleFetchRemoteStatus` — 원격 데이터 fetch
- `handleSendWebPush` — Web Push 알림
- `handleFetchPreviewCard` — 링크 프리뷰 카드
- `handleForwardActivity` — 활동 전달
- `handleImportItem` — CSV 가져오기 항목 처리

---

## 7. Fedify sendActivity 전환 상태

### 완전 전환된 엔드포인트

다음 엔드포인트들은 Fedify `sendToFollowers()` 또는 `sendToRecipient()`를 사용하여 Activity를 직접 Fedify vocab 객체로 구성하고 발신한다:

| # | 엔드포인트 | Activity 타입 | 발신 방식 |
|---|---|---|---|
| 1 | `statuses/create.ts` | Create(Note) | sendToFollowers + sendToRecipient |
| 2 | `statuses/edit.ts` | Update(Note) | sendToFollowers |
| 3 | `statuses/delete.ts` | Delete(Tombstone) | sendToFollowers |
| 4 | `statuses/favourite.ts` | Like | sendToRecipient |
| 5 | `statuses/unfavourite.ts` | Undo(Like) | sendToRecipient |
| 6 | `statuses/reblog.ts` | Announce | sendToFollowers |
| 7 | `statuses/unreblog.ts` | Undo(Announce) | sendToFollowers |
| 8 | `statuses/reactions.ts` | Like (+_misskey_reaction) / Undo(Like) | sendToRecipient |
| 9 | `accounts/follow.ts` | Follow | sendToRecipient |
| 10 | `accounts/unfollow.ts` | Undo(Follow/Block) | sendToRecipient |
| 11 | `accounts/block.ts` | Block | sendToRecipient |
| 12 | `accounts/unblock.ts` | Undo(Block) | sendToRecipient |
| 13 | `followRequests.ts` | Accept / Reject | sendToRecipient |
| 14 | `reports.ts` | Flag | ctx.sendActivity() 직접 호출 |
| 15 | `accounts/migration.ts` | Move | sendToFollowers |

### 미전환 엔드포인트

| 엔드포인트 | 이유 |
|---|---|
| `admin/relays.ts` | 인스턴스 액터(`/actor`)로 발신해야 하므로 Fedify의 `/users/{identifier}` 패턴 사용 불가. `buildFollowActivity`/`buildUndoActivity`로 JSON 생성 후 `QUEUE_FEDERATION.send({ type: 'deliver_activity' })` 레거시 경로 사용. |

### build-activity.ts vs 직접 Fedify vocab 구성

**`helpers/build-activity.ts`** — JSON 문자열을 반환하는 빌더 함수 (13개). 레거시 파이프라인(`deliver_activity` 큐 메시지)과 호환을 위해 유지. 릴레이 발신 등에 사용.

**직접 Fedify vocab 사용** — `statuses/create.ts`, `statuses/edit.ts` 등은 Fedify `Note`, `Create`, `Update` 등의 vocab 객체를 직접 생성하여 `sendToFollowers()`에 전달. 이것이 완전 전환된 패턴.

---

## 8. Misskey/Pleroma 호환성

### 벤더 확장 처리 방식

**파일:** `siliconbeest-worker/src/federation/helpers/misskey-compat.ts`

Fedify의 vocab 타입은 `_misskey_*` 필드를 네이티브로 지원하지 않으므로, 직렬화 후 JSON 수준에서 주입/추출하는 전략을 사용한다.

#### 발신 (Outbound)

`injectMisskeyNoteExtensions(noteJsonLd, options)`:
- `_misskey_content`: MFM 소스 텍스트
- `_misskey_summary`: CW 텍스트
- `_misskey_quote` + `quoteUri` (FEP-e232): 인용 게시물 URI

`injectMisskeyReaction(likeJsonLd, emoji)`:
- `_misskey_reaction`: 이모지 문자열
- `content`: 이모지 문자열

#### 수신 (Inbound)

`extractMisskeyExtensions(activity)`:
- `_misskey_content`, `_misskey_summary`, `_misskey_quote`/`quoteUri`, `_misskey_reaction` 추출

`isEmojiReaction(activity)`:
- `type === 'EmojiReact'` 이거나
- `type === 'Like'` + (`_misskey_reaction` 또는 `content` 존재) → true

### 커스텀 이모지 리액션 발신

`statuses/reactions.ts`에서 커스텀 이모지 리액션 발신 시:
1. Fedify `Like` 객체 생성 (`buildEmojiReactActivity` via build-activity.ts)
2. `toJsonLd()` 후 `injectMisskeyReaction()`으로 `_misskey_reaction`, `content` 주입
3. 커스텀 이모지인 경우 `Emoji` 태그 포함 (리모트 서버가 이모지 이미지를 fetch할 수 있도록)

### sendActivity 사용 시 벤더 확장 제한사항

Fedify `sendActivity()`에 전달하는 Activity 객체는 Fedify vocab 타입이므로, `_misskey_*` 필드를 직접 설정할 수 없다. 대안:
1. `statuses/create.ts`에서는 Fedify `Note` vocab을 직접 사용하므로 `_misskey_content` 등을 주입할 기회가 없음 — 현재 이 필드는 create.ts에서 누락된 상태
2. `statuses/reactions.ts`에서는 Like vocab + 후처리 방식 사용

---

## 9. WebFinger/Remote Actor 조회

### Fedify lookupWebFinger(), lookupObject() 사용

Fedify Context 객체의 메서드를 사용하여 원격 서버 조회:

```typescript
const fed = c.get('federation');
const ctx = getFedifyContext(fed);
const wfResult = await ctx.lookupWebFinger(`acct:user@domain`);
const actorObject = await ctx.lookupObject(actorUri);
```

### 사용 위치

| 파일 | 사용 메서드 | 용도 |
|---|---|---|
| `api/v2/search.ts` | `lookupWebFinger` + `lookupObject` | 원격 계정/게시물 검색 |
| `statuses/create.ts` | `lookupWebFinger` | 멘션된 원격 사용자 resolve |
| `accounts/migration.ts` | `lookupWebFinger` + `lookupObject` | 마이그레이션 대상 계정 확인 |
| `accounts/aliases.ts` | `lookupWebFinger` | 별칭 등록 시 원격 계정 확인 |
| `accounts/lookup.ts` | `lookupWebFinger` + `lookupObject` | 원격 계정 조회 |
| `inboxProcessors/move.ts` | `lookupObject` | 마이그레이션 수신 시 새 계정 확인 |

### 교체된 파일

기존에는 `resolveRemoteAccount.ts` 내부에서 직접 fetch + User-Agent 설정으로 actor document를 가져왔으나, WebFinger 단계와 actor document fetch 단계는 Fedify의 `lookupWebFinger`/`lookupObject`로 대체되었다. `resolveRemoteAccount.ts` 자체는 DB upsert 로직 때문에 여전히 사용 중.

---

## 10. 테스트

### 현재 테스트 상태

- 테스트 파일 수: **51개** (`siliconbeest-worker/test/` 디렉토리)
- 주요 테스트 카테고리: accounts, activity-idempotency, activitypub, actor-serializer, admin, auth, blocks-mutes, bookmarks-favourites, collection-pagination, content-parser, conversations, custom-emojis, discovery, ed25519-crypto, email, statuses, streaming, timelines, visibility-permissions 등

### activity-idempotency 테스트 변경

**파일:** `siliconbeest-worker/test/activity-idempotency.test.ts`

기존에는 HTTP 요청을 보내 inbox 엔드포인트를 직접 호출하는 방식이었으나, Fedify 전환 후 inbox가 Fedify 미들웨어 뒤에 있어 HTTP Signature 검증이 필요해졌다.

**해결:** inbox processor 함수(`processLike`, `processFollow` 등)를 직접 import하여 호출하는 방식으로 변경.

```typescript
import { processLike } from '../src/federation/inboxProcessors/like';
import { processFollow } from '../src/federation/inboxProcessors/follow';
```

이 접근의 장점: Fedify의 서명 검증 없이 프로세서 로직만 단위 테스트 가능.

### Fedify 환경에서의 테스트 제한사항

- **DNS 해석 불가:** 테스트에서 `remote.example.com` 같은 가상 도메인은 실제 DNS에서 해석되지 않으므로, Fedify의 `lookupWebFinger()`/`lookupObject()` 호출이 포함된 코드 경로는 통합 테스트로 커버 불가. Processor 직접 호출 방식으로 우회.
- **HTTP Signature 테스트:** Fedify가 서명 검증을 자동 처리하므로, 수동 서명 생성이 필요한 테스트는 Fedify 미들웨어를 우회해야 함.

---

## 11. 커스텀 이모지 리액션

### custom_emoji_id 컬럼 활용

`status_reactions` 테이블에 `custom_emoji_id` 컬럼이 있어, 커스텀 이모지 리액션 시 해당 이모지의 DB ID를 저장한다.

### 원격 이모지 `/proxy?url=` 처리

원격 서버에서 수신한 커스텀 이모지 이미지는 `/proxy?url=` 엔드포인트를 통해 프록시된다. 이는 R2 버킷에 캐싱하여 CORS 이슈 및 원격 서버 부하를 방지한다.

### 발신 시 Emoji 태그 포함

커스텀 이모지 리액션 발신 시 (`statuses/reactions.ts`):
1. `Like` activity에 `Emoji` 태그를 포함하여 원격 서버가 이모지 이미지를 resolve할 수 있도록 함
2. `_misskey_reaction` 필드에 `:shortcode:` 형식으로 이모지 shortcode 설정
3. `content` 필드에도 동일한 shortcode 설정

### shortcode 유효성 검증

이모지 shortcode는 `[a-zA-Z0-9_]` 패턴만 허용. 발신 전 유효성 검증을 거침.

---

## 12. WebPush

### Admin 설정

Admin API (`/api/v1/admin/`)를 통해 Web Push 활성화/비활성화 가능. VAPID 키쌍은 환경 변수로 설정:
- `VAPID_PUBLIC_KEY` — 공개 키 (클라이언트에 전달)
- `VAPID_PRIVATE_KEY` — 비밀 키 (서버 서명용)

### 사용자 Push 알림 설정

Mastodon API 호환 엔드포인트 `/api/v1/push/subscription`으로 구독/해지/수정:
- 사용자별 알림 유형 필터링 (mention, favourite, reblog, follow, poll 등)
- Queue Consumer의 `handleSendWebPush` 핸들러가 실제 Push 전송

### iOS PWA

Web Push는 iOS 16.4+ Safari PWA (홈 화면 추가)에서 지원. 사용자에게 홈 화면 추가를 안내하면 Push 수신 가능.

---

## 13. 배포 스크립트

### setup.sh 변경사항

**파일:** `scripts/setup.sh`

- `FEDIFY_KV` KV 네임스페이스 생성 (199행)
- `QUEUE_FEDERATION` 큐 생성 (219행)
- wrangler.jsonc에 FEDIFY_KV ID 자동 업데이트 (281-293행)

### sync-config.sh 변경사항

**파일:** `scripts/sync-config.sh`

- `KV_FEDIFY_TITLE` 변수 (기본값: `${PROJECT_PREFIX}-FEDIFY_KV`)
- `QUEUE_FEDERATION` 변수 (기본값: `${PROJECT_PREFIX}-federation`)
- Worker와 Queue Consumer 모두의 wrangler.jsonc에 바인딩 자동 설정:
  - `FEDIFY_KV` KV 바인딩
  - `QUEUE_FEDERATION` 큐 바인딩 (producer/consumer 양쪽)

### wrangler.jsonc 바인딩

Worker (`siliconbeest-worker/wrangler.jsonc`):
- `FEDIFY_KV`: KV 네임스페이스 바인딩
- `QUEUE_FEDERATION`: Queue producer 바인딩

Queue Consumer (`siliconbeest-queue-consumer/wrangler.jsonc`):
- `FEDIFY_KV`: KV 네임스페이스 바인딩
- `QUEUE_FEDERATION`: Queue producer (재전송용) + consumer 바인딩

---

## 14. 향후 작업

### 1. noteSerializer.ts → Fedify Note 완전 전환 (완료됨)

`noteSerializer.ts`는 이미 삭제되었고, `statuses/create.ts`와 `statuses/edit.ts`에서 Fedify `Note` vocab을 직접 사용한다. `dispatchers/collections.ts`의 outbox에서도 `buildNoteFromStatusRow()`로 Fedify Note를 직접 구성한다.

다만 `_misskey_content` 등의 벤더 확장 주입이 `create.ts`/`edit.ts`에서 누락된 상태이므로, Misskey 호환성을 위해 추가 필요.

### 2. deliveryManager.ts 완전 제거 (완료됨)

이미 삭제됨. `sendToFollowers`/`sendToRecipient` (send.ts)로 대체.

### 3. httpSignatures.ts 제거

현재 아무 곳에서도 import하지 않으므로 삭제 가능. 다만 Queue Consumer의 `handleDeliverActivity` 핸들러에서 인스턴스 액터 서명에 아직 자체 구현을 사용할 수 있으므로 확인 필요.

### 4. 릴레이 발신 Fedify 전환

`admin/relays.ts`가 아직 `buildFollowActivity` + 레거시 `deliver_activity` 큐 메시지를 사용. 인스턴스 액터를 Fedify dispatcher에 통합하거나, 별도의 Fedify Context를 구성하여 `sendActivity()`로 전환 가능.

### 5. 인스턴스 액터 Fedify 통합 가능성 검토

Fedify가 향후 다중 경로 패턴을 지원하거나, `Tombstone` 반환을 허용하는 경우 통합 가능. 현재 구조에서는 `/actor` 경로를 Fedify에 넘길 수 없으므로 Hono 라우트 유지가 필수.

### 6. Queue Consumer에서 레거시 deliver_activity 핸들러 제거 시점

모든 발신이 Fedify `sendActivity()`를 통하게 된 후에만 가능. 현재 릴레이 발신이 레거시 경로를 사용하므로, 릴레이 전환이 선행되어야 한다.

---

## 부록: 파일 구조 요약

```
siliconbeest-worker/src/
├── index.ts                          # Fedify 미들웨어 등록 (131-156행)
├── env.ts                            # FEDIFY_KV, QUEUE_FEDERATION, federation 변수
├── federation/
│   ├── fedify.ts                     # createFed() 팩토리
│   ├── httpSignatures.ts             # [레거시, 미사용] 수동 HTTP Signature
│   ├── resolveRemoteAccount.ts       # 원격 계정 DB upsert (유지)
│   ├── dispatchers/
│   │   ├── actor.ts                  # Actor + KeyPairs dispatcher
│   │   ├── nodeinfo.ts               # NodeInfo 2.1 dispatcher
│   │   └── collections.ts           # 5개 컬렉션 dispatcher
│   ├── listeners/
│   │   └── inbox.ts                  # 13개 inbox listener
│   ├── helpers/
│   │   ├── send.ts                   # sendToFollowers, sendToRecipient
│   │   ├── build-activity.ts         # Fedify vocab Activity 빌더
│   │   ├── activity-adapter.ts       # JSON-LD → APActivity 변환
│   │   ├── misskey-compat.ts         # Misskey 벤더 확장 주입/추출
│   │   └── key-utils.ts             # PEM/base64url → CryptoKey
│   └── inboxProcessors/             # 14개 파일 (비즈니스 로직 유지)
│       ├── index.ts                  # 타입별 디스패치 (레거시용)
│       ├── create.ts, follow.ts, accept.ts, reject.ts
│       ├── like.ts, announce.ts, delete.ts, update.ts
│       ├── undo.ts, block.ts, move.ts, flag.ts
│       └── emojiReact.ts
├── endpoints/
│   └── activitypub/
│       ├── README.md                 # Fedify 미처리 엔드포인트 상세 문서
│       ├── actor.ts                  # Tombstone 폴백 전용
│       └── instanceActor.ts         # /actor 인스턴스 액터

siliconbeest-queue-consumer/src/
├── index.ts                          # Fedify/레거시 메시지 분기 (isFedifyMessage)
├── fedify.ts                         # Queue Consumer용 createFed()
├── dispatchers.ts                    # KeyPairs dispatcher (서명 키 로딩)
└── handlers/                         # 레거시 핸들러 유지
```
