# `endpoints/activitypub/` — Fedify가 처리하지 않는 ActivityPub 엔드포인트

## 개요

이 폴더에는 **Fedify 미들웨어가 구조적으로 처리할 수 없는** ActivityPub 엔드포인트만 Hono 라우트로 남아 있다. SiliconBeest의 ActivityPub 구현은 Fedify를 최대한 활용하되, Fedify의 타입 시스템이나 라우팅 구조가 커버하지 못하는 두 가지 특수 케이스를 이 폴더에서 처리한다.

---

## 왜 이 파일들이 남아있는가

Fedify는 ActivityPub 서버 구현의 대부분을 dispatcher/listener 패턴으로 추상화한다. 하지만 다음 두 가지 경우는 Fedify의 설계 범위 밖이다:

1. **Tombstone 응답** — Fedify의 actor dispatcher는 `Actor | null`만 반환할 수 있어, `Tombstone` 타입 + HTTP 410을 표현할 방법이 없다.
2. **인스턴스 액터** — Fedify의 `setActorDispatcher`는 단일 경로 패턴(`/users/{identifier}`)만 등록하므로, `/actor` 경로를 처리할 수 없다.

Fedify 미들웨어가 먼저 요청을 처리하고, 자신이 핸들링하지 않는 요청만 Hono 라우터로 fall through 시키는 구조이므로, 이 두 파일은 Fedify와 충돌 없이 공존한다.

---

## `actor.ts` — Suspended 계정의 Tombstone 응답 (HTTP 410)

### 문제

ActivityPub 표준에서 삭제/정지된 계정은 HTTP 410 Gone과 함께 `Tombstone` 객체를 반환해야 한다. 이는 원격 서버들이 해당 계정의 캐시를 무효화하고, 더 이상 배달을 시도하지 않도록 하는 중요한 시그널이다.

### Fedify의 한계

Fedify의 `setActorDispatcher`는 `/users/{identifier}` 패턴으로 등록되며, 콜백의 반환 타입은 `Actor | null`이다:

- `Actor` 반환 시 → HTTP 200 + Actor JSON-LD
- `null` 반환 시 → Fedify가 처리하지 않고 다음 미들웨어로 전달

`Tombstone`은 `Actor` 타입이 아니므로 dispatcher에서 반환할 수 없다. HTTP 상태 코드를 410으로 지정할 방법도 없다.

### 동작 흐름

```
요청: GET /users/suspended_user (Accept: application/activity+json)
  │
  ├─ Fedify actor dispatcher 실행
  │   └─ suspended_at이 있는 계정 → null 반환
  │
  ├─ Fedify가 null을 받으면 요청을 처리하지 않음 → Hono로 fall through
  │
  └─ actor.ts (Hono 라우트) 실행
      ├─ DB에서 계정 조회
      ├─ suspended_at 존재 → HTTP 410 + Tombstone JSON-LD 반환
      └─ suspended_at 없음 → 404 (Fedify에서 처리됐어야 하는 비정상 케이스)
```

### 반환하는 Tombstone 형식

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams"],
  "id": "https://siliconbeest.sjang.dev/users/username",
  "type": "Tombstone",
  "formerType": "Person",
  "deleted": "2024-01-15T00:00:00.000Z"
}
```

- `formerType: "Person"` — 원래 Person 타입 액터였음을 명시
- `deleted` — 정지 시점 타임스탬프 (Mastodon 등 원격 서버가 캐시 무효화에 사용)

---

## `instanceActor.ts` — 인스턴스 레벨 Application 액터

### 역할

`GET /actor` 경로에서 인스턴스 전체를 대표하는 `Application` 타입 액터를 반환한다. 이 액터는 다음 용도로 사용된다:

- **릴레이 구독** — ActivityPub 릴레이 서버와의 Follow/Accept 교환
- **인스턴스 간 통신** — 특정 사용자가 아닌 인스턴스 자체가 주체인 활동
- **HTTP Signature 서명** — 인스턴스 레벨 요청의 서명 키 제공

### Fedify에서 처리할 수 없는 이유

Fedify의 `setActorDispatcher`는 **하나의 경로 패턴**만 받는다. SiliconBeest에서는 `/users/{identifier}`로 등록되어 있다.

`/actor` 경로는 `/users/{identifier}` 패턴에 매칭되지 않으므로, Fedify의 actor dispatcher가 이 요청을 가로채지 않는다.

### `/users/__instance__`로 옮기면 안 되는 이유

이론적으로 인스턴스 액터를 `/users/__instance__`로 이동하면 Fedify dispatcher에서 처리할 수 있다. 하지만 다음 이유로 불가능하다:

1. **연합된 릴레이의 actor URI가 깨진다** — 이미 `https://siliconbeest.sjang.dev/actor`로 릴레이들과 연합(Follow/Accept)이 완료된 상태다. URI가 변경되면 릴레이가 이 인스턴스를 인식하지 못한다.

2. **ActivityPub에서 `id`가 곧 identity** — ActivityPub 객체의 `id` (URI)는 해당 객체의 고유 식별자다. URI가 바뀌면 원격 서버는 이를 완전히 다른 액터로 취급한다. 기존의 Follow 관계, 메시지 이력이 모두 단절된다.

3. **HTTP Signature `keyId` 변경** — 인스턴스 액터의 `keyId`는 `https://siliconbeest.sjang.dev/actor#main-key`로 설정되어 있다. 경로가 바뀌면 keyId도 바뀌고, 원격 서버가 기존 keyId로 서명을 검증하려 할 때 실패한다.

4. **301 Redirect의 한계** — 이론적으로 `/actor` → `/users/__instance__`로 리다이렉트할 수 있지만, 모든 ActivityPub 구현체가 HTTP Signature 검증 시 리다이렉트를 따르지 않는다. 특히 Mastodon은 서명 검증 과정에서 리다이렉트를 따르지 않으므로, 리다이렉트 후 서명 검증이 실패한다.

### Lazy Key Generation

인스턴스 액터의 RSA 키쌍은 **최초 요청 시점에 생성**된다 (lazy init):

1. `actor_keys` 테이블에서 `account_id = '__instance__'`인 레코드를 조회
2. 없으면 RSA 2048-bit 키쌍을 Web Crypto API로 생성
3. `accounts` 테이블에 `__instance__` 계정이 없으면 생성 (FK 제약조건 충족)
4. 생성된 키를 `actor_keys`에 저장

이 방식은 배포 시 별도의 키 생성 스크립트가 필요 없고, 첫 번째 릴레이 구독 시점에 자동으로 키가 준비된다.

### Ed25519 Multikey 지원

`actor_keys.ed25519_public_key`가 존재하면 `assertionMethod` 필드에 Ed25519 Multikey를 포함한다. 이는 HTTP Message Signatures (새로운 서명 표준)에서 사용되며, 기존 RSA `publicKey`와 함께 두 가지 서명 방식을 모두 지원한다.

---

## Fedify가 처리하는 것 (이 폴더에 없는 것)

다음 엔드포인트들은 모두 Fedify의 dispatcher/listener로 등록되어 있으며, 이 폴더에 별도 구현이 없다:

| 경로 | Fedify 메서드 | 설명 |
|---|---|---|
| `/.well-known/webfinger` | `setActorDispatcher` 자동 등록 | WebFinger 프로토콜 |
| `/.well-known/nodeinfo` | `setNodeInfoDispatcher` | NodeInfo 디스커버리 |
| `/nodeinfo/2.1` | `setNodeInfoDispatcher` | NodeInfo 상세 정보 |
| `/users/{username}` (정상 액터) | `setActorDispatcher` | Person 타입 액터 반환 |
| `/users/{username}/inbox` | `setInboxListeners` | 개인 inbox |
| `/inbox` | `setInboxListeners` (shared inbox) | 공유 inbox |
| `/users/{username}/followers` | Collection dispatcher | 팔로워 목록 |
| `/users/{username}/following` | Collection dispatcher | 팔로잉 목록 |
| `/users/{username}/outbox` | Collection dispatcher | 활동 기록 |
| `/users/{username}/collections/featured` | Collection dispatcher | 고정 게시물 |
| `/users/{username}/collections/tags` | Collection dispatcher | 추천 해시태그 |

---

## 이 구조가 문제없는 이유

### 1. 미들웨어 실행 순서가 보장된다

Fedify는 Hono 미들웨어로 등록되어 있으므로, 모든 요청이 Fedify를 먼저 통과한다. Fedify가 처리할 수 있는 요청은 Fedify가 응답하고, 처리하지 않는 요청만 Hono 라우터로 전달된다. 따라서 동일한 경로에 대해 Fedify와 Hono가 충돌할 가능성이 없다.

### 2. 두 파일 모두 Fedify가 구조적으로 지원하지 않는 케이스만 처리한다

- `actor.ts` — Fedify의 반환 타입 제약 (`Actor | null`에 `Tombstone`이 포함되지 않음)
- `instanceActor.ts` — Fedify의 단일 경로 패턴 제약 (`/users/{identifier}` 외 경로 불가)

이것은 Fedify의 버그가 아니라 설계상의 trade-off다. Fedify는 일반적인 ActivityPub 서버 구현에 필요한 기능을 잘 추상화하고 있으며, 이 두 가지는 그 추상화 범위 밖의 특수 요구사항이다.

### 3. ActivityPub 표준을 100% 준수한다

- Tombstone 응답은 [ActivityPub 표준 Section 6.2](https://www.w3.org/TR/activitypub/)에서 정의하는 삭제/정지 시그널이다.
- 인스턴스 액터는 Mastodon을 포함한 주요 구현체에서 사용하는 사실상의 표준이다.
- 두 파일 모두 올바른 `Content-Type` (`application/activity+json`)과 `@context`를 포함한다.

---

## `index.ts`의 Activity wrapper 라우트 — `/users/{identifier}/statuses/{id}/activity`

### 역할

`GET /users/{identifier}/statuses/{id}/activity` 경로에서 해당 status가 일반 글인지 부스트(reblog)인지에 따라 **`Create(Note)`** 또는 **`Announce`** Activity를 반환한다. 이 라우트는 `federation/dispatchers/objects.ts`의 `handleActivityRequest()` 함수를 호출하며, content negotiation을 통해 ActivityPub 요청이 아닌 경우 HTML 페이지로 리다이렉트한다.

### Fedify의 `setObjectDispatcher`가 아닌 Hono 라우트인 이유

1. **Fedify의 `setObjectDispatcher`는 하나의 경로 패턴에 하나의 타입만 허용** — 같은 `/users/{identifier}/statuses/{id}/activity` 경로에 `Create`와 `Announce` 두 개를 등록하면 `"Inserted route is the same as other route"` 에러가 발생한다.

2. **부스트(reblog)와 일반 글이 같은 URI 패턴을 공유** — reblog의 URI는 `/users/{username}/statuses/{id}/activity`이고, 일반 글의 Create activity도 같은 패턴이다. 하나의 요청에서 DB 조회 후 `reblog_of_id` 유무로 `Create`/`Announce`를 분기해야 한다.

3. **`Activity` 기반 클래스로 등록하는 것도 불가** — Fedify의 object dispatcher는 구체적인 타입(`Create`, `Announce`)을 요구하며, 부모 클래스 `Activity`로 등록해도 적절한 JSON-LD `@context`가 생성되지 않는다.

### 동작 흐름

```
요청: GET /users/{username}/statuses/{id}/activity (Accept: application/activity+json)
  │
  ├─ Fedify 미들웨어 → 이 경로에 대한 dispatcher가 없으므로 Hono로 fall through
  │
  └─ index.ts (Hono 라우트) 실행
      ├─ handleActivityRequest() 호출
      ├─ DB에서 status 조회
      ├─ reblog_of_id 존재 → Announce Activity 반환
      └─ reblog_of_id 없음 → Create(Note) Activity 반환
```

### Note 객체 디스패처와의 관계

`/users/{identifier}/statuses/{id}` 경로의 **Note** 객체는 Fedify의 `setObjectDispatcher(Note, ...)` 로 정상 등록되어 있다. Note는 항상 하나의 타입이므로 Fedify의 dispatcher 구조에 문제없이 들어맞는다.

| 경로 | 처리 방식 | 이유 |
|---|---|---|
| `/users/{id}/statuses/{id}` | Fedify `setObjectDispatcher(Note)` | 항상 Note 타입 하나만 반환 |
| `/users/{id}/statuses/{id}/activity` | Hono 라우트 → `handleActivityRequest()` | Create 또는 Announce를 동적으로 분기해야 함 |
