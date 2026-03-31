# SiliconBeest 개발 저널

> 이 문서는 SiliconBeest 개발 과정에서 발견한 문제, 내린 결정, 배운 교훈을 시간순으로 정리한 것입니다.
> 2026년 3월 23일부터 24일까지의 집중 개발 기간을 다룹니다.
>
> **참고:** 이 저널은 이전 분리 아키텍처(`siliconbeest-worker/` + `siliconbeest-vue/`)를 기준으로 작성되었습니다. 현재는 `siliconbeest/`로 통합되었습니다.

---

## 1. 프로젝트 탄생 배경

### 왜 만들었나
- Cloudflare의 **Wildebeest** 프로젝트가 중단됨 (https://github.com/cloudflare/wildebeest)
- Wildebeest의 아이디어(서버리스 연합우주)는 좋았지만 더 이상 작동하지 않음
- Cloudflare Workers의 현재 기능들(D1, R2, KV, Queues, Durable Objects)을 활용해서 재구현하기로 결정

### 핵심 설계 원칙
1. **Cloudflare Paid Plan 한도 안에서 작동** — Container 같은 추가 요금이 비싼 기능 사용하지 않음
2. **Mastodon API 호환** — 서드파티 앱(Ivory, Ice Cubes, Tusky 등)에서 사용 가능
3. **ActivityPub 표준 준수** — Mastodon, Misskey, Pleroma 등과 연합 가능
4. **TypeScript 전면 사용** — JavaScript 최소화
5. **확장 가능한 설계** — 사용자가 많아져도 대규모까지 확장 가능

### 참고한 프로젝트/문서
- Wildebeest README: https://raw.githubusercontent.com/cloudflare/wildebeest/refs/heads/main/README.md
- ActivityPub W3C 스펙: https://www.w3.org/TR/activitypub/
- Misskey 소스코드: https://github.com/misskey-dev/misskey
- Cloudflare Workers 문서: https://developers.cloudflare.com/workers/
- Fedify (TypeScript AP 프레임워크): https://github.com/fedify-dev/fedify

---

## 2. 아키텍처 결정들

### 3-Worker 구조를 선택한 이유
처음에는 단일 Worker로 시작할 수 있었지만, 역할 분리를 위해 3개로 나눔:

| Worker | 역할 | 이유 |
|--------|------|------|
| `siliconbeest-worker` | API + ActivityPub | 메인 로직, 요청/응답 처리 |
| `siliconbeest-queue-consumer` | 비동기 작업 | Federation 전달, 미디어 처리, 알림 등 CPU 집약 작업 분리 |
| `siliconbeest-vue` | 프론트엔드 SPA | Vue 3 + Vite, SPA 모드로 서빙 |

**Queue Consumer를 분리한 핵심 이유**: Cloudflare Workers는 요청당 CPU 시간 제한이 있음. HTTP Signature 계산, RSA/Ed25519 서명, 원격 서버 fetch 등은 CPU를 많이 소모하므로 Queue를 통해 비동기로 처리.

### Cloudflare 서비스 선택 근거

| 서비스 | 용도 | 대안 검토 |
|--------|------|----------|
| **D1** | 관계형 데이터 (계정, 글, 팔로우 등) | Hyperdrive+외부 PG 고려했으나 D1이 비용 효율적 |
| **R2** | 미디어 파일 저장 | S3 호환이라 이미지/동영상 저장에 적합 |
| **KV** | 캐시 + 세션 | WebFinger 캐시, 토큰 캐시, 속도 제한 등 |
| **Queues** | 비동기 작업 | Federation 전달을 동기로 하면 응답 지연 발생 |
| **Durable Objects** | WebSocket 스트리밍 | 유저별 WebSocket 연결 관리에 필요 |

### ID 전략: ULID
- UUID 대신 ULID (Universally Unique Lexicographically Sortable Identifier) 사용
- 시간순 정렬이 가능해서 `ORDER BY id DESC`로 최신순 정렬 가능
- **발견한 문제**: 로컬 글(`00MN...`)과 리모트 글(`01KM...`)의 ULID 생성기가 달라서 `ORDER BY id`가 시간순이 아님
- **해결**: 타임라인에서 `ORDER BY created_at DESC`로 변경

### 라우팅 구조
Cloudflare Workers의 Routes 기능으로 path별 Worker 분배:
```
siliconbeest.sjang.dev/api/*          → siliconbeest-worker
siliconbeest.sjang.dev/oauth/*        → siliconbeest-worker
siliconbeest.sjang.dev/.well-known/*  → siliconbeest-worker
siliconbeest.sjang.dev/users/*        → siliconbeest-worker
siliconbeest.sjang.dev/inbox          → siliconbeest-worker
siliconbeest.sjang.dev/media/*        → siliconbeest-worker
siliconbeest.sjang.dev/actor          → siliconbeest-worker
siliconbeest.sjang.dev (catch-all)    → siliconbeest-vue (SPA)
```

**주의**: `zone_name` 방식의 라우팅은 Cloudflare WAF/Bot Protection을 먼저 통과함. `/users/*` 경로가 Bot Fight Mode에 의해 403 차단되는 문제 발생 → WAF에서 Skip 규칙 추가 필요.

---

## 3. ActivityPub 구현에서 배운 것들

### HTTP Signature — 가장 어려웠던 부분

#### Draft-Cavage vs RFC 9421
- **Draft-Cavage** (레거시): 대부분의 기존 Fediverse 서버가 사용
- **RFC 9421** (신규): 표준화된 새 방식, Fedify 등에서 지원
- **해결: Double-Knock 전략**
  1. 캐시된 선호도 확인 (KV에 `sig-pref:{domain}` 키)
  2. 선호도 없으면 RFC 9421로 먼저 시도
  3. 401/403 응답이면 Draft-Cavage로 재시도
  4. 성공한 방식을 7일간 캐시

#### Signed Fetch 필요성
- Misskey 계열 서버(kokonect.link, serafuku.moe 등)는 actor document fetch에도 HTTP Signature 필요
- 일반 `fetch()`로는 401 응답
- **Instance Actor**(`/actor`)의 RSA 키로 서명해서 fetch해야 함
- `fetchRemoteActor()` 함수에 signed fetch 로직 추가

#### Content-Digest 형식
- RFC 9530 형식: `sha-256=:BASE64:` (콜론으로 감쌈)
- Draft-Cavage 형식: `SHA-256=BASE64` (콜론 없음)
- 서버에 따라 다르므로 양쪽 다 처리

### Object Integrity Proofs (FEP-8b32)
- Ed25519 키 생성 + Base58btc + Multicodec (`0xed01` prefix)
- JCS (JSON Canonicalization Scheme, RFC 8785) 구현 필요
- 증명 체인: SHA-256(proof_options) + SHA-256(document) → Ed25519 서명 → Base58btc

#### 발견한 버그: LD Signature 순서 문제
`createProof()`가 `@context`에 `data-integrity/v1`을 추가 → LD Signature가 수정된 document를 기반으로 계산되어야 하는데, 순서가 뒤바뀌어 있었음. **해결: Integrity Proof를 먼저 생성하고, 그 후에 LD Signature 생성.**

### WebFinger
```
GET /.well-known/webfinger?resource=acct:user@domain
```
- 반환에 3가지 link 포함: `self` (AP actor), `profile-page`, `subscribe` (OStatus 템플릿)
- Instance Actor도 WebFinger 지원 필요 — 일부 서버가 Instance Actor를 WebFinger로 검증

#### Instance Actor의 preferredUsername 문제
- 처음에 `preferredUsername`을 도메인 전체(`siliconbeest.sjang.dev`)로 설정
- 상대 서버가 WebFinger로 `acct:siliconbeest.sjang.dev@siliconbeest.sjang.dev` 조회 → 실패
- **해결**: `preferredUsername`을 `siliconbeest.sjang.dev`로 유지하되, WebFinger에서 해당 username을 instance actor로 매핑

### Conversation Threading
- AP 스펙에 공식 `conversation` 필드는 없지만, Mastodon이 사용하는 de facto 표준
- 형식: `tag:server,year:objectId=123:objectType=Conversation`
- **처음 구현**: 로컬에서만 `conversation_id` 관리, 리모트 글의 `conversation` 필드 무시
- **문제**: 같은 스레드인데 conversation이 다르게 설정됨 → 댓글이 context에서 안 보임
- **수정**: 인바운드 Note의 `conversation` 필드를 읽어서 DB의 `ap_uri` 컬럼에 저장, 매칭

### Activity Forwarding
- 리모트 사용자의 팔로워 컬렉션에 주소 지정된 activity를 다른 서버의 팔로워에게 전달
- **원본 HTTP Signature 보존** 필수 — 새로 서명하면 안 됨
- Queue 메시지에 원본 body + headers를 그대로 저장해서 전달

### Visibility (공개 범위)
| 공개 범위 | AP addressing | 홈 | 로컬 | 연합 |
|-----------|--------------|:--:|:--:|:--:|
| Public | `to: [Public], cc: [followers]` | ✅ | ✅ | ✅ |
| Unlisted | `to: [followers], cc: [Public]` | ✅ | ❌ | ❌ |
| Private | `to: [followers]` | ✅ | ❌ | ❌ |
| Direct | `to: [mentioned users]` | ❌ | ❌ | ❌ |

**팔로워 전용 글은 reblog 불가** — AP 스펙상 의도된 제한된 공개 범위를 무력화시키기 때문.

---

## 4. Mastodon API 호환성에서 배운 것들

### 서드파티 앱 호환을 위한 필수 사항

1. **`version` 필드에 `4.0.0` 유지**
   - 서드파티 앱이 version을 파싱해서 기능 지원 여부 결정
   - `4.0.0 (compatible; SiliconBeest 0.1.0)` 형식 사용
   - Pleroma도 `2.4.2 (compatible; Pleroma 2.6.0)` 패턴 사용

2. **`/api/v1/instance` 엔드포인트 필수**
   - v2만 구현했었는데 서드파티 앱이 v1을 먼저 호출
   - v1이 없으면 인증 실패

3. **`avatar_static`과 `header_static`이 `null`이면 앱 크래시**
   - Mastodon은 항상 URL 반환 (static이 없으면 원본 URL)
   - `null` 대신 원본 URL로 fallback 필수

4. **`filtered` 필드 필수**
   - `[]` (빈 배열)이라도 포함해야 함
   - 누락되면 일부 앱에서 파싱 에러

5. **`created_at` 밀리초 포함**
   - Mastodon: `2026-03-24T11:38:40.344Z`
   - 우리: `2026-03-24T10:25:52Z` (밀리초 없음)
   - `ensureISO8601WithMs()` 함수로 항상 `.000Z` 형식 보장

6. **`group_key` 필드** (Mastodon 4.3+)
   - 알림 그룹화용
   - `{type}-{status_id}-{account_id}` 형식
   - 미구현 시 `ungrouped-{id}`

### OAuth 흐름
- Authorization Code + PKCE (S256/plain) 지원
- Client Credentials 지원
- 2FA/TOTP: Google Authenticator 등과 호환
- **발견한 버그**: DB 스키마 컬럼명 불일치
  - `oauth_access_tokens`에서 `resource_owner_id` vs `user_id`
  - `oauth_authorization_codes`에서 `token` vs `code`
  - 테스트에서 발견하여 수정

### Streaming API
- Mastodon Streaming API 호환 WebSocket
- `GET /api/v1/streaming?stream=user&access_token=TOKEN`
- Durable Objects로 유저별 WebSocket 연결 관리
- **WebSocket Hibernation API** 사용 — 비용 절감 (DO가 idle 시 메모리 해제)
- **발견한 문제**: 처음에 hibernation 없이 구현 → Cloudflare 공식 문서 참고해서 `this.ctx.acceptWebSocket()` + `webSocketMessage()` 패턴으로 재구현

### URL Preview Cards
- 글 작성 시 URL 감지 → Queue로 OpenGraph metadata fetch
- `preview_cards` + `status_preview_cards` 테이블
- OG 파싱: `og:title`, `og:description`, `og:image`, fallback으로 `<title>`, `<meta name="description">`
- 이미지 로드 실패 시 (SVG 등) fallback 처리

---

## 5. Misskey 호환성

### Emoji Reactions
- Mastodon은 favourite(좋아요)만 지원
- Misskey는 커스텀 이모지 리액션 지원
- AP 형식: `Like` activity에 `_misskey_reaction` 필드 추가
- 또는 별도 `EmojiReact` activity type
- **양방향 구현**:
  - 인바운드: `Like`에 `_misskey_reaction`이 있으면 emoji_reactions 테이블에 저장
  - 아웃바운드: `buildEmojiReactActivity()`로 Like + `_misskey_reaction` + `content` 전달

### Custom Emoji Federation
- AP Note/Actor의 `tag` 배열에 `{ type: "Emoji", name: ":shortcode:", icon: { url: "..." } }` 포함
- **발견한 문제**: 이모지 저장 시 `domain`이 이미지 CDN 호스트(`cdn01.kurry.gallery`)로 설정됨
- **해결**: actor document의 `id`에서 서버 도메인 추출해서 사용
- **일괄 재처리**: 기존 잘못 저장된 이모지 전부 삭제 후, AP Note/Actor 재fetch해서 올바른 도메인으로 재저장

### Misskey Content Fields
- `_misskey_content`: 원본 MFM (Misskey Flavored Markdown) 텍스트
- `_misskey_summary`: CW 텍스트
- `_misskey_quote`: 인용 게시물 URI
- 인바운드에서 `content`가 없으면 `_misskey_content` fallback

---

## 6. 프론트엔드 개발에서 배운 것들

### vue-i18n `SyntaxError: 10`
- 가장 골치 아팠던 에러
- vue-i18n이 메시지 컴파일 시 특수 문자(`|`, `{`, `}` 등)에서 파싱 에러 발생
- `|` 는 vue-i18n에서 pluralization 구분자로 사용됨
- **해결**: 특수 문자를 이스케이프하거나 `{'|'}` 형식으로 감싸기

### 라우터 Hash 변경 시 페이지 이동 불가
- 코드 수정으로 빌드 해시가 변경되면 기존 chunk 404
- **해결**: Vue Router에서 `NavigationFailure` catch → `window.location.href` 로 강제 새로고침

### 모바일 네비게이션
- PC: 좌측 사이드바 (항상 보임)
- 모바일: 하단 탭바 (5개) + 햄버거 메뉴 (더보기)
- **발견한 누락**: 모바일에서 검색, About 페이지 접근 불가 → 더보기 메뉴에 추가

### 이모지 피커 위치 문제
- Composer 하단 툴바에 이모지 피커 열면 composer를 덮어서 입력 불가
- `absolute bottom-full`로는 뷰포트 밖으로 나감
- **해결**: `<Teleport to="body">` + `fixed` 포지션 + JS로 버튼 기준 위치 계산

### 테마 (다크/라이트)
- `useUiStore`에서 `setTheme()`
- `document.documentElement.classList.add/remove('dark')`
- Tailwind의 `dark:` variant 활용
- localStorage에 저장

---

## 7. 버그 수정 기록 (시간순)

### Phase 1-2 빌드 단계
- `CryptoKeyPair` 타입 캐스트 누락 → `as CryptoKeyPair` 추가
- `lookbehind` regex가 Workers 런타임에서 미지원 → non-capturing group으로 교체
- `spoiler_text` vs `content_warning` 컬럼명 불일치 (4곳)
- `fr.fr.id` 이중 접두어 — `buildPaginationQuery`에서 이미 qualified된 컬럼명에 `.replace()` 적용 → replace 제거

### Federation 버그들
- **ReadableStream is locked**: inbox에서 request body를 두 번 읽으려 함 → `const rawBody = await request.text()` 한 번만 읽고 재사용
- **팔로우 요청 처리 안 됨**: `processFollow`에서 로컬 계정 조회 실패 → username 추출 로직 수정
- **이미지 AP 미전달**: `serializeNote()` 호출 시 `attachments` 파라미터를 4곳에서 전달 안 함 → DB에서 fetch 후 전달
- **타임존 문제**: 일부 서버가 `+09:00` 오프셋 포함 timestamp 전달 → SQLite 문자열 비교에서 순서 꼬임 → `normalizeToUTC()` 함수로 inbox 수신 시 UTC 정규화

### 프론트엔드 버그들
- **로그인 폼 안 뜸**: `console.log`만 하고 실제 API 호출 없음 → auth store의 `login()` 연결
- **새 게시물 버튼 동작 이상**: 스크롤 최상단에서 auto-insert 후 버튼 사라짐 → scroll 위치 기반 로직 재설계
- **reblog 빈 카드**: streaming payload에 `reblog: null` 하드코딩 → 원글 DB fetch 후 포함
- **댓글 삭제 후 안 사라짐**: StatusDetailView에서 delete 이벤트 처리 누락 → descendants 배열에서 제거

---

## 8. 성능 최적화

### Batch 처리
- `enrichStatuses()`: 미디어, 좋아요/부스트/북마크 상태, 이모지를 **한 번의 batch 쿼리**로 처리
- 개별 status마다 5-6개 쿼리 대신 status ID 목록으로 `WHERE id IN (...)` 배치

### KV 캐시 전략
| 키 패턴 | TTL | 용도 |
|---------|-----|------|
| `token:{sha256}` | 5분 | OAuth 토큰 검증 |
| `remote_actor:{uri}` | 5분 | 리모트 actor document |
| `webfinger:{acct}` | 5분 | WebFinger 결과 |
| `sig-pref:{domain}` | 7일 | HTTP Signature 선호도 |
| `activity-seen:{id}` | 24시간 | Activity 중복 처리 방지 |
| `og:{url}` | 24시간 | URL preview card |
| `rl:{ip}:{endpoint}:{window}` | 5분 | Rate limiting |

### Smart Placement
- Worker에 `placement: { mode: "smart" }` 설정
- Cloudflare가 요청 패턴에 따라 최적의 데이터센터에 Worker 배치
- D1과 가까운 위치에서 실행되어 지연 감소

---

## 9. 운영에서 발견한 것들

### Cloudflare Bot Fight Mode 문제
- `/users/*` 경로로 오는 AP 요청이 403으로 차단됨
- 원인: Cloudflare Bot Fight Mode가 일반 HTTP 클라이언트(curl, Mastodon 서버)를 봇으로 감지
- **해결**: Cloudflare WAF에서 `/users/*`, `/inbox`, `/actor` 경로에 대한 Skip 규칙 추가

### D1 마이그레이션 관리
- `0001_initial_schema.sql` ~ `0016_account_migration.sql`까지 17개
- `wrangler d1 migrations apply` 사용
- **주의**: D1 마이그레이션은 되돌릴 수 없음 (rollback 불가)
- 테스트 helpers에서도 동일한 스키마 유지 필요 → `applyMigration()` 함수

### SMTP 이메일 전송
- `worker-mailer` 패키지 사용 (Cloudflare Workers 전용 SMTP 클라이언트)
- Gmail SMTP: `smtp.gmail.com:587`, `plain` 인증
- **발견한 문제**:
  - `auto` authType이 서버에 따라 작동 안 함 → 명시적으로 `['login', 'plain', 'cram-md5']` 배열 지정
  - SMTP username이 DB에 저장 안 됨 → `smtp_user` 키 이름 통일

### 도메인 변경 금지
- 서비스 시작 후 도메인 변경하면 모든 AP URI가 무효화됨
- 다른 서버에 저장된 actor URI, status URI가 전부 깨짐
- **README에 경고 추가**: "서비스 시작 후 INSTANCE_DOMAIN 변경 금지"

---

## 10. 테스트 전략

### 테스트 환경
- Vitest + `@cloudflare/vitest-pool-workers`
- D1, KV, R2를 로컬에서 에뮬레이션
- `applyMigration()`: 모든 테이블 + 인덱스 + 시드 데이터 생성
- `createTestUser()`: 계정, 유저, actor_keys, OAuth 토큰 한 번에 생성

### 테스트 카테고리
| 카테고리 | 파일 수 | 테스트 수 | 예시 |
|----------|:------:|:-------:|------|
| API 엔드포인트 | 25+ | 400+ | auth, statuses, timelines, notifications |
| Federation/AP | 10+ | 150+ | HTTP signatures, integrity proofs, LD signatures |
| 유틸리티 | 8+ | 100+ | pagination, sanitize, ULID, content parser |
| Vue 프론트 | 11 | 110+ | stores, components, router guards |

### 주요 교훈
- **테스트 스키마와 프로덕션 스키마 동기화 필수** — `test/helpers.ts`의 CREATE TABLE이 실제 migration과 달라서 테스트는 통과하는데 프로덕션에서 실패하는 경우 다수 발생
- **컬럼 추가 시 3곳 수정**: migration SQL, `types/db.ts` 타입, `test/helpers.ts` 스키마

---

## 11. 배포 프로세스

### 초기 설정
```bash
./scripts/setup.sh          # 대화형 — 도메인, 제목, 관리자 설정
./scripts/deploy.sh         # 3개 Worker 배포
./scripts/configure-domain.sh siliconbeest.sjang.dev  # 커스텀 도메인 라우트
```

### 업데이트 배포
```bash
git pull
./scripts/update.sh         # 타입체크 + 마이그레이션 + 배포
```

### 환경 동기화
```bash
./scripts/sync-config.sh           # Dry run — 현재 상태 확인
./scripts/sync-config.sh --apply   # wrangler.jsonc 재생성
```

### 리소스 이름 커스터마이징
- `config.sh`에서 `PROJECT_PREFIX` 변경하면 모든 리소스 이름 변경
- D1, R2, KV, Queue 이름이 자동으로 업데이트

---

## 12. 향후 과제

### 알려진 제한사항
1. **D1 쿼리 제한**: 복잡한 JOIN이 많으면 느려질 수 있음
2. **Workers CPU 시간**: 무거운 작업은 Queue로 분리했지만 한계 존재
3. **R2 이미지 변환**: 썸네일 생성 미구현 (Cloudflare Images 사용 고려)
4. **검색**: 현재 LIKE 기반 — 풀텍스트 검색 미지원
5. **투표(Poll)**: 기본 구조만 있고 실시간 업데이트 미구현

### 개선 방향
1. Cloudflare Images 통합으로 이미지 리사이징/최적화
2. 풀텍스트 검색 (D1의 FTS5 또는 외부 서비스)
3. 비디오/오디오 미디어 지원 강화
4. 더 많은 FEP (Fediverse Enhancement Proposals) 지원
5. 성능 모니터링 + 알림 (Sentry 통합 확장)

---

## 13. 기술 스택 요약

| 영역 | 기술 |
|------|------|
| **런타임** | Cloudflare Workers |
| **언어** | TypeScript |
| **프레임워크** | Hono (API), Vue 3 (Frontend) |
| **데이터베이스** | Cloudflare D1 (SQLite) |
| **스토리지** | Cloudflare R2 |
| **캐시** | Cloudflare KV |
| **큐** | Cloudflare Queues |
| **WebSocket** | Cloudflare Durable Objects |
| **프론트 빌드** | Vite |
| **스타일링** | Tailwind CSS 4 |
| **상태관리** | Pinia |
| **i18n** | vue-i18n |
| **테스트** | Vitest |
| **이메일** | worker-mailer |
| **모니터링** | Sentry (선택) |
| **암호화** | Web Crypto API (RSA, Ed25519, AES-GCM, ECDSA) |

---

## 14. 핵심 교훈 정리

1. **ActivityPub은 스펙보다 구현이 중요** — 실제 서버들의 동작이 스펙과 다른 경우가 많음. Mastodon이 de facto 표준.
2. **컬럼명 불일치는 치명적** — 코드와 DB 스키마 사이의 불일치가 가장 많은 버그 원인.
3. **null vs 빈 문자열 vs undefined** — API 응답에서 이 세 가지를 정확히 구분해야 서드파티 앱이 크래시하지 않음.
4. **Signed Fetch는 선택이 아닌 필수** — Misskey 계열 서버와 통신하려면 모든 outbound fetch에 HTTP Signature 필요.
5. **Queue 기반 비동기 처리** — Federation 전달을 동기로 하면 사용자 경험이 극도로 나빠짐.
6. **테스트 스키마 동기화** — 프로덕션 migration과 테스트 helpers의 스키마를 항상 동기화해야 함.
7. **Cloudflare의 보안 기능이 AP를 방해할 수 있음** — Bot Fight Mode, WAF 규칙 등이 서버간 통신을 차단.
8. **i18n은 처음부터** — 나중에 추가하면 모든 컴포넌트를 다시 수정해야 함.
9. **도메인은 절대 변경하지 말 것** — AP URI가 영구적이므로 도메인 변경 = 서비스 재시작.
10. **다른 서버의 버그도 우리가 대응해야** — 상대 서버가 잘못된 timestamp, 잘못된 content-type을 보내도 graceful하게 처리.
