# SiliconBeest 아키텍처 문서

> SiliconBeest 프로젝트의 종합적인 기술 문서입니다.
> 최종 업데이트: 2026-03-25
>
> **참고:** 이 문서는 이전 분리 아키텍처(`siliconbeest-worker/` + `siliconbeest-vue/`)를 기준으로 작성되었습니다. 현재는 `siliconbeest/` 단일 디렉토리로 통합되었습니다. 마이그레이션 방법은 [UPGRADE.md](../UPGRADE.md)를 참조하세요. API 서버는 `siliconbeest/server/`에, Vue 프론트엔드는 `siliconbeest/src/`에 있습니다.

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [아키텍처](#2-아키텍처)
3. [프로젝트 구조](#3-프로젝트-구조)
4. [데이터베이스 스키마](#4-데이터베이스-스키마)
5. [ActivityPub 구현](#5-activitypub-구현)
6. [Mastodon API 호환성](#6-mastodon-api-호환성)
7. [Misskey 호환성](#7-misskey-호환성)
8. [큐 시스템](#8-큐-시스템)
9. [프론트엔드 (Vue 3)](#9-프론트엔드-vue-3)
10. [관리자 기능](#10-관리자-기능)
11. [보안](#11-보안)
12. [스크립트 및 배포](#12-스크립트-및-배포)
13. [테스트](#13-테스트)
14. [알려진 제한사항 및 향후 계획](#14-알려진-제한사항-및-향후-계획)
15. [설정 레퍼런스](#15-설정-레퍼런스)

---

## 1. 프로젝트 개요

### SiliconBeest란?

SiliconBeest는 Cloudflare 개발자 플랫폼(Workers, D1, R2, KV, Queues, Durable Objects)을 기반으로 구축된 **완전 서버리스 페디버스 플랫폼**입니다. **Mastodon REST API**와 **ActivityPub** 서버 간 프로토콜을 구현하여, Mastodon, Misskey, Pleroma, Akkoma, Firefish, GoToSocial 등 페디버스의 다른 서버들과 연합할 수 있습니다.

- **GitHub 저장소**: https://github.com/SJang1/siliconbeest
- **라이선스**: GNU Affero General Public License v3.0 (AGPL-3.0)

### 영감

SiliconBeest는 Cloudflare의 공식 서버리스 페디버스 서버였던 [Cloudflare Wildebeest](https://github.com/cloudflare/wildebeest)에서 영감을 받았습니다. Wildebeest는 현재 Cloudflare에 의해 **중단**되었습니다. SiliconBeest는 이 개념을 더욱 발전시켜 완전히 새로 작성했으며 다음 기능을 제공합니다:

- 완전한 Mastodon API v1/v2 호환성 (100개 이상의 엔드포인트)
- 최신 HTTP 서명 표준을 포함한 포괄적인 연합
- 안정성을 위한 큐 기반 비동기 처리
- 국제화를 지원하는 커스텀 Vue 3 프론트엔드
- 인스턴스 관리를 위한 관리자 대시보드
- 680개 이상의 테스트를 포함한 테스트 스위트

### 설계 목표

| 목표 | 접근 방식 |
|------|----------|
| **서버 인프라 불필요** | Cloudflare 엣지 네트워크에서 완전히 실행 |
| **저비용** | Cloudflare Workers Paid 플랜($5/월) 범위 내에서 운영 설계 |
| **완전한 호환성** | 기존 Mastodon 클라이언트와 호환 (Tusky, Elk, Ice Cubes, Ivory, Mona) |
| **연합 우선** | ActivityPub, WebFinger, NodeInfo, HTTP Signatures, LD Signatures, Object Integrity Proofs 구현 |
| **보안** | OAuth 2.0 + PKCE, TOTP 2FA, bcrypt 비밀번호 해싱, 속도 제한 |
| **국제화** | 지연 로딩을 지원하는 12개 언어 팩 |

---

## 2. 아키텍처

### 3-Worker 모델

SiliconBeest는 공유 데이터 저장소와 큐를 통해 협력하는 3개의 독립적인 Cloudflare Worker로 구성됩니다:

```
                        클라이언트 (Mastodon 앱, 웹 브라우저)
                                       |
                                       v
                         +---------------------------+
                         |    Cloudflare CDN / 엣지   |
                         +---------------------------+
                                       |
                      +----------------+----------------+
                      |                                 |
                      v                                 v
         +------------------------+        +------------------------+
         |   siliconbeest-worker  |        |   siliconbeest-vue     |
         |   (Hono API 서버)      |        |   (Vue 3 SPA 프론트엔드)|
         |                        |        |                        |
         |  - Mastodon API v1/v2  |        |  - Tailwind CSS 4      |
         |  - OAuth 2.0 + 2FA     |        |  - Headless UI         |
         |  - ActivityPub S2S     |        |  - Pinia 스토어        |
         |  - Admin API           |        |  - vue-i18n            |
         |  - WebSocket 스트리밍   |        |  - Sentry (선택사항)   |
         +------------------------+        +------------------------+
               |     |      |
               v     v      v
         +-----+ +----+ +--------+    +----------------------------+
         |  D1 | | R2 | |   KV   |    | siliconbeest-queue-consumer|
         | SQL | |블롭 | |캐시/   |    |                            |
         | DB  | |저장소| |세션    |    |  - 연합 배달               |
         +-----+ +----+ +--------+    |  - 타임라인 팬아웃          |
                                       |  - 알림                    |
         +------------------+         |  - 미디어 처리             |
         |   Durable Objects |         |  - Web Push 전송           |
         |   (StreamingDO)   |         +----------------------------+
         |   WebSocket 라이브 |               |            |
         +------------------+         +------+     +------+
                                       | 큐    |     | 큐    |
                                       | 연합  |     | 내부  |
                                       +------+     +------+
```

### Worker 1: `siliconbeest-worker` (API 서버)

모든 HTTP 요청을 처리하는 주요 Worker입니다. **Hono** 웹 프레임워크로 구축되었습니다.

**담당 기능:**
- Mastodon REST API v1/v2 (계정, 게시물, 타임라인, 알림 등)
- OAuth 2.0 인증 서버 (인증 코드 + PKCE + client_credentials)
- ActivityPub 서버 간 엔드포인트 (actor, inbox, outbox, followers, following, featured)
- Well-known 디스커버리 (WebFinger, NodeInfo, host-meta)
- Durable Objects를 통한 WebSocket 스트리밍
- R2에서의 미디어 제공
- 관리자 API

**주요 바인딩:**
- `DB` (D1) -- 주 데이터베이스
- `MEDIA_BUCKET` (R2) -- 미디어 저장소
- `CACHE` (KV) -- 캐싱, 속도 제한, 활동 중복 제거, 서명 선호도 캐싱
- `SESSIONS` (KV) -- OAuth 세션 관리
- `QUEUE_FEDERATION` (Queue) -- 연합 작업 큐잉
- `QUEUE_INTERNAL` (Queue) -- 내부 작업 큐잉
- `STREAMING_DO` (Durable Object) -- WebSocket 스트리밍

**설정:**
- `placement.mode: "smart"` -- Cloudflare Smart Placement가 D1 데이터베이스 근처에 Worker를 최적 배치
- 커스텀 도메인의 zone_name 기반 라우팅으로 경로 설정

### Worker 2: `siliconbeest-queue-consumer` (큐 소비자)

두 큐의 메시지를 소비하고 비동기적으로 처리하는 전용 Worker입니다.

**담당 기능:**
- 원격 인박스로의 연합 활동 배달 (HTTP 서명 포함)
- 모든 팔로워 인박스로의 활동 팬아웃
- 타임라인 팬아웃 (홈 타임라인에 게시물 삽입)
- 알림 생성 및 Web Push 전송
- 원격 계정 및 게시물 가져오기
- 미디어 썸네일 처리
- 미리보기 카드 (OpenGraph) 가져오기
- 원본 서명 보존한 활동 전달
- CSV 가져오기 처리 (팔로우, 차단, 뮤트)

**주요 바인딩:**
- `DB` (D1), `MEDIA_BUCKET` (R2), `CACHE` (KV) -- API Worker와 동일한 리소스
- `QUEUE_FEDERATION` + `QUEUE_INTERNAL` -- 소비자와 생산자 모두 (재큐잉 용)
- `WORKER` (서비스 바인딩) -- Durable Object 접근을 위해 API Worker 호출

**큐 설정:**
- 연합 큐: 최대 5회 재시도, Dead Letter Queue (`siliconbeest-federation-dlq`)
- 내부 큐: 최대 3회 재시도, DLQ 없음

### Worker 3: `siliconbeest-vue` (프론트엔드)

Cloudflare Workers Sites로 제공되는 정적 Vue 3 Single Page Application입니다.

**설정:**
- `assets.directory: "./dist/client"` -- 빌드된 Vue 앱 제공
- `assets.not_found_handling: "single-page-application"` -- 클라이언트 사이드 라우팅을 위해 알 수 없는 경로에 `index.html` 제공
- `custom_domain: true` 라우팅으로 catch-all 패턴 사용
- `server/index.ts` -- Workers Sites용 최소 서버 진입점

### 사용된 Cloudflare 서비스

| 서비스 | 용도 | 선택 이유 |
|--------|------|----------|
| **Workers** | HTTP 요청 처리, API 서버 | 글로벌 엣지 배포, 0ms 콜드 스타트, 30초 CPU 시간 |
| **D1** | SQLite 데이터베이스 | 설정 불필요한 서버리스 SQL, 자동 복제 |
| **R2** | 객체 저장소 (미디어, 이모지) | S3 호환, 이그레스 비용 없음, Workers와 통합 |
| **KV** | 키-값 캐시 | 밀리초 이하 읽기, 글로벌 분배, TTL 지원 |
| **Queues** | 비동기 작업 처리 | 보장된 전달, DLQ 지원, 배칭 |
| **Durable Objects** | WebSocket 스트리밍 | 영속적 연결, 하이버네이션 지원, 사용자별 상태 |

### 요청 라우팅

API Worker는 `zone_name` 기반 Workers Routes를 사용하여 특정 경로 패턴을 가로챕니다:

| 라우트 패턴 | Worker | 용도 |
|------------|--------|------|
| `domain/api/*` | API Worker | Mastodon REST API |
| `domain/oauth/*` | API Worker | OAuth 2.0 흐름 |
| `domain/.well-known/*` | API Worker | WebFinger, NodeInfo, host-meta |
| `domain/users/*` | API Worker | ActivityPub actor 엔드포인트 |
| `domain/inbox` | API Worker | ActivityPub 공유 인박스 |
| `domain/nodeinfo/*` | API Worker | NodeInfo 2.0/2.1 |
| `domain/media/*` | API Worker | R2 미디어 제공 |
| `domain/actor` | API Worker | 인스턴스 actor |
| `domain/authorize_interaction*` | API Worker | 원격 팔로우 |
| `domain/healthz` | API Worker | 헬스 체크 |
| `domain/thumbnail.png` | API Worker | 인스턴스 썸네일 |
| `domain/favicon.ico` | API Worker | 파비콘 |
| `domain` (catch-all) | Vue 프론트엔드 | SPA catch-all |

### Smart Placement

API Worker와 큐 소비자 모두 `placement.mode: "smart"`를 사용합니다. Cloudflare가 자동으로 D1 데이터베이스 근처에 Worker를 배치하여 데이터베이스 작업의 지연 시간을 최소화합니다. 각 API 요청이 일반적으로 여러 D1 쿼리를 포함하므로 이는 매우 중요합니다.

### 비용 고려사항

SiliconBeest는 Cloudflare Workers Paid 플랜 ($5/월 기본) 내에서 운영되도록 설계되었습니다:

| 리소스 | 100명 사용자/월 | 1000명 사용자/월 |
|--------|----------------|-----------------|
| Workers 요청 | ~150만 (포함) | ~1500만 ($1.50) |
| D1 읽기 | ~30만 (포함) | ~300만 (포함) |
| D1 쓰기 | ~3만 (포함) | ~30만 (포함) |
| R2 저장소 | ~1 GB ($0.02) | ~10 GB ($0.15) |
| KV 작업 | ~50만 (포함) | ~500만 (포함) |
| DO 요청 | ~30만 (포함) | ~300만 ($0.30) |
| Queues | ~10만 (포함) | ~100만 (포함) |
| **합계** | **~$5/월** | **~$7/월** |

---

## 3. 프로젝트 구조

### 루트 디렉터리

```
siliconbeest/
  .gitignore
  FEDERATION.md              # FEP-67ff 연합 기능 문서
  README.md                  # 프로젝트 README 및 빠른 시작 가이드
  wrangler.jsonc             # 루트 wrangler 설정 (레거시)
  scripts/                   # 설치, 배포 및 유지보수 스크립트
  siliconbeest-worker/       # API 서버 (Hono on Workers)
  siliconbeest-queue-consumer/ # 비동기 작업 처리기 (Queues 소비자)
  siliconbeest-vue/          # 웹 프론트엔드 (Vue 3 SPA)
```

### siliconbeest-worker/ (API 서버)

```
siliconbeest-worker/
  wrangler.jsonc                    # Worker 설정 및 바인딩
  package.json                      # 의존성: hono, chanfana, zod, bcryptjs, ulid, worker-mailer
  vitest.config.mts                 # @cloudflare/vitest-pool-workers 테스트 설정
  src/
    index.ts                        # Hono 앱 진입점, 모든 라우트 마운트
    env.ts                          # Env 바인딩 및 앱 변수 TypeScript 인터페이스
    types/
      activitypub.ts                # ActivityPub/ActivityStreams 타입 정의
      mastodon.ts                   # Mastodon REST API 엔티티 타입
      queue.ts                      # 큐 메시지 판별 합집합 (15가지 타입)
      db.ts                         # 데이터베이스 행 타입
    endpoints/
      activitypub/
        actor.ts                    # GET /users/:username (AP actor 문서)
        inbox.ts                    # POST /users/:username/inbox (개인 인박스)
        sharedInbox.ts              # POST /inbox (공유 인박스)
        outbox.ts                   # GET /users/:username/outbox (페이지네이션)
        followers.ts                # GET /users/:username/followers (페이지네이션)
        following.ts                # GET /users/:username/following (페이지네이션)
        featured.ts                 # GET /users/:username/featured (고정 게시물)
        featuredTags.ts             # GET /users/:username/featured_tags
        instanceActor.ts            # GET /actor (인스턴스 actor)
      api/v1/
        accounts/                   # 계정 관련 엔드포인트 (생성, 조회, 수정, 팔로우 등)
        statuses/                   # 게시물 관련 엔드포인트 (생성, 조회, 삭제, 좋아요 등)
        timelines/                  # 타임라인 (홈, 공개, 해시태그, 리스트)
        notifications/              # 알림 (목록, 삭제, 읽음)
        conversations/              # 대화 (DM)
        polls/                      # 투표
        lists/                      # 리스트 관리
        push/                       # Web Push 구독
        filters/                    # 콘텐츠 필터
        admin/                      # 관리자 API
          accounts/                 # 계정 관리 (승인, 거부, 정지, 역할)
          reports/                  # 신고 관리
          domainBlocks.ts           # 도메인 차단
          domainAllows.ts           # 도메인 허용
          ipBlocks.ts               # IP 차단
          emailDomainBlocks.ts      # 이메일 도메인 차단
          rules.ts                  # 인스턴스 규칙
          announcements.ts          # 공지사항
          customEmojis.ts           # 커스텀 이모지
          settings.ts               # 인스턴스 설정
          relays.ts                 # 릴레이 관리
          federation.ts             # 연합 모니터링
          email.ts                  # SMTP 이메일 설정
          measures.ts               # 측정/분석
        trends/                     # 트렌딩 태그/게시물
        instance/                   # 인스턴스 정보
        apps.ts                     # 클라이언트 앱 등록
        (기타 엔드포인트...)
      api/v2/
        instance.ts                 # 향상된 인스턴스 정보
        search.ts                   # 검색 (계정, 게시물, 해시태그)
        media.ts                    # 비동기 미디어 업로드
      oauth/                        # OAuth 2.0 흐름
      wellknown/                    # WebFinger, NodeInfo, host-meta
      media.ts                      # R2 미디어 제공
    federation/
      actorSerializer.ts            # 로컬 계정을 AP Actor 문서로 직렬화
      noteSerializer.ts             # 게시물을 AP Note 객체로 직렬화
      activityBuilder.ts            # AP 활동 생성 (Create, Update, Delete 등)
      deliveryManager.ts            # 원격 인박스로의 활동 배달 관리
      httpSignatures.ts             # HTTP 서명 생성 + 검증 (draft-cavage + RFC 9421)
      ldSignatures.ts               # Linked Data 서명 생성 + 검증
      integrityProofs.ts            # Object Integrity Proofs (FEP-8b32, ed25519-jcs-2022)
      activityForwarder.ts          # 원본 서명 보존 활동 전달
      resolveRemoteAccount.ts       # 원격 AP actor를 로컬 계정 레코드로 해석
      webfinger.ts                  # 원격 계정 조회용 WebFinger 클라이언트
      inboxProcessors/              # 수신 활동 타입별 처리기 (13가지 이상)
    middleware/
      auth.ts                       # Bearer 토큰 인증 (KV 캐시 + D1 폴백)
      contentNegotiation.ts         # ActivityPub 콘텐츠 타입 감지
      cors.ts                       # CORS 설정
      errorHandler.ts               # 전역 에러 핸들러
      rateLimit.ts                  # KV 기반 슬라이딩 윈도우 속도 제한
      requestId.ts                  # X-Request-ID 생성
    repositories/                   # 데이터 접근 계층 (account, status, follow 등)
    services/                       # 비즈니스 로직 계층
    utils/                          # 유틸리티 (contentParser, crypto, sanitize, ulid 등)
    webpush/                        # Web Push (dispatch, encrypt, vapid)
    durableObjects/
      streaming.ts                  # StreamingDO -- Hibernatable WebSocket Durable Object
  migrations/                       # D1 데이터베이스 마이그레이션 (0001~0016)
  test/                             # 49개 테스트 파일
```

### siliconbeest-queue-consumer/ (큐 소비자)

```
siliconbeest-queue-consumer/
  wrangler.jsonc                    # 소비자 + 생산자 바인딩이 있는 Worker 설정
  package.json                      # 최소 의존성: typescript, wrangler
  src/
    index.ts                        # 메시지 디스패치가 있는 큐 배치 핸들러
    env.ts                          # 환경 바인딩 인터페이스
    handlers/
      deliverActivity.ts            # 원격 인박스에 단일 활동 배달
      deliverActivityFanout.ts      # 모든 팔로워 인박스에 활동 팬아웃
      timelineFanout.ts             # 팔로워의 홈 타임라인에 게시물 삽입
      createNotification.ts         # 알림 생성 + Web Push 큐잉
      processMedia.ts               # 미디어 썸네일 처리
      fetchRemoteAccount.ts         # 원격 AP actor 가져오기 및 캐싱
      fetchRemoteStatus.ts          # 원격 AP 객체 가져오기 및 캐싱
      sendWebPush.ts                # Web Push 알림 암호화 및 전송
      fetchPreviewCard.ts           # URL 카드용 OpenGraph 메타데이터 가져오기
      forwardActivity.ts            # 원본 HTTP 헤더 보존 활동 전달
      importItem.ts                 # CSV 가져오기 항목 처리 (팔로우/차단/뮤트)
      integrityProofs.ts            # 아웃바운드 활동용 Object Integrity Proofs 생성
      ldSignatures.ts               # 릴레이 활동용 LD 서명 생성
    shared/
      types/queue.ts                # 공유 큐 메시지 타입 정의
      webpush.ts                    # 공유 Web Push 유틸리티
```

### siliconbeest-vue/ (프론트엔드)

```
siliconbeest-vue/
  wrangler.jsonc                    # Workers Sites 설정
  package.json                      # Vue 3, Pinia, vue-i18n, Tailwind CSS 4 등
  src/
    main.ts                         # Vue 앱 부트스트랩
    App.vue                         # 루트 컴포넌트
    api/
      client.ts                     # 인증 인터셉터가 있는 API 클라이언트
      streaming.ts                  # 자동 재연결 WebSocket 스트리밍 클라이언트
      mastodon/                     # 도메인별 API 메서드
    components/
      layout/                       # 앱 셸, 사이드바, 모바일 네비게이션, 관리자 레이아웃
      status/                       # 게시물 카드, 컨텐츠, 액션, 작성기, 미디어 갤러리
      account/                      # 계정 카드, 헤더, 팔로우 버튼
      common/                       # 아바타, 이모지 피커, 이미지 뷰어, 무한 스크롤 등
      notification/                 # 알림 항목
      auth/                         # 로그인, 가입, 2FA 폼
      settings/                     # 언어 선택기
      timeline/                     # 타임라인 피드
    composables/
      useEmojis.ts                  # 이모지 자동완성 컴포저블
    stores/                         # Pinia 스토어 (auth, accounts, statuses, timelines 등)
    router/
      index.ts                      # Vue Router 설정 (30개 이상 라우트)
      guards.ts                     # 네비게이션 가드
    views/                          # 뷰 컴포넌트 (35개 이상)
    i18n/
      index.ts                      # 지연 로딩 i18n 설정
      locales/                      # 언어 파일 (en, ko + 10개 추가)
    types/
      mastodon.ts                   # 프론트엔드 Mastodon 엔티티 타입
  test/                             # 11개 테스트 파일
```

### scripts/

```
scripts/
  config.sh                 # 공유 설정 (PROJECT_PREFIX, 리소스 이름, 색상)
  config.env.example        # 영구 설정 오버라이드 예시
  setup.sh                  # 대화형 초기 설정
  deploy.sh                 # 3개 Worker 모두 빌드 및 배포
  update.sh                 # 풀, 테스트, 마이그레이션, 재배포 (프로덕션 업데이트)
  configure-domain.sh       # 커스텀 도메인 Workers Routes 설정
  generate-vapid-keys.sh    # VAPID 키 쌍 생성 (ECDSA P-256)
  seed-admin.sh             # 관리자 사용자 계정 생성
  migrate.sh                # D1 데이터베이스 마이그레이션 적용
  backup.sh                 # D1 + R2 데이터 백업
  delete-account.sh         # AP 호환 계정 삭제
  sync-config.sh            # Cloudflare 리소스 ID를 wrangler.jsonc에 동기화
  README.md                 # 스크립트 문서
```

---

## 4. 데이터베이스 스키마

SiliconBeest는 Cloudflare D1 (SQLite)을 주 데이터베이스로 사용합니다. 스키마는 16개의 마이그레이션 파일로 관리됩니다.

### ID 전략: ULID

모든 기본 키는 **ULID** (Universally Unique Lexicographically Sortable Identifier)를 사용합니다:

- 26자의 Crockford Base32
- 시간 정렬 가능 (처음 48비트가 밀리초 타임스탬프)
- 조율 없이 전역적으로 고유
- SQLite TEXT 컬럼과 호환

이는 대부분의 쿼리에서 `ORDER BY id`가 `ORDER BY created_at`과 동일하며, ID를 페이지네이션 커서로 사용할 수 있음을 의미합니다.

### 타임스탬프

모든 타임스탬프는 ISO 8601 형식의 `TEXT`로 저장됩니다 (예: `2026-03-25T12:00:00.000Z`).

### 핵심 테이블

#### `accounts` -- 계정

로컬 및 원격 actor 프로필을 나타내는 중심 엔티티입니다.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT (PK, ULID) | 기본 키 |
| `username` | TEXT | 사용자명 (예: `admin`) |
| `domain` | TEXT | 로컬 계정은 NULL, 원격은 도메인 |
| `display_name` | TEXT | 표시 이름 |
| `note` | TEXT | 자기소개 (HTML) |
| `uri` | TEXT (UNIQUE) | ActivityPub actor URI |
| `url` | TEXT | 프로필 페이지 URL |
| `avatar_url` | TEXT | 아바타 이미지 URL |
| `header_url` | TEXT | 헤더 이미지 URL |
| `locked` | INTEGER | 수동 팔로우 승인 필요 |
| `bot` | INTEGER | 봇 계정 플래그 |
| `discoverable` | INTEGER | 디렉터리에서 발견 가능 |
| `statuses_count` | INTEGER | 캐시된 게시물 수 |
| `followers_count` | INTEGER | 캐시된 팔로워 수 |
| `following_count` | INTEGER | 캐시된 팔로잉 수 |
| `suspended_at` | TEXT | 정지 타임스탬프 |
| `silenced_at` | TEXT | 사일런스 타임스탬프 |
| `moved_to_account_id` | TEXT | 이전 대상 계정 |
| `inbox_url` | TEXT | AP 인박스 URL (마이그레이션 0007) |
| `shared_inbox_url` | TEXT | AP 공유 인박스 URL (마이그레이션 0007) |
| `fields` | TEXT | JSON 프로필 메타데이터 필드 (마이그레이션 0009) |
| `also_known_as` | TEXT | JSON 별칭 URI 배열 (마이그레이션 0016) |
| `moved_at` | TEXT | 이전 타임스탬프 (마이그레이션 0016) |

**인덱스:** `idx_accounts_uri`, `idx_accounts_domain`, `idx_accounts_username_domain`

#### `users` -- 사용자

로컬 인증 레코드. 로컬 사용자의 `accounts`와 1:1 관계입니다.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT (PK, ULID) | 기본 키 |
| `account_id` | TEXT (UNIQUE, FK) | accounts(id) 참조 |
| `email` | TEXT (UNIQUE) | 이메일 주소 |
| `encrypted_password` | TEXT | bcrypt 해시 |
| `locale` | TEXT | 선호 언어 |
| `otp_secret` | TEXT | AES-GCM 암호화된 TOTP 비밀 |
| `otp_enabled` | INTEGER | 2FA 활성화 플래그 |
| `otp_backup_codes` | TEXT | JSON 해시된 백업 코드 배열 |
| `role` | TEXT | 역할: user/moderator/admin |
| `approved` | INTEGER | 로그인 승인됨 |
| `disabled` | INTEGER | 계정 비활성화 플래그 |

#### `actor_keys` -- actor 키

연합 서명용 RSA 및 Ed25519 키 쌍.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT (PK, ULID) | 기본 키 |
| `account_id` | TEXT (UNIQUE, FK) | accounts(id) 참조 |
| `public_key` | TEXT | RSA-2048 공개 키 (PEM) |
| `private_key` | TEXT | RSA-2048 개인 키 (PEM) |
| `key_id` | TEXT | 키 ID URI (예: `{actor_uri}#main-key`) |
| `ed25519_public_key` | TEXT | Ed25519 공개 키 (마이그레이션 0012) |
| `ed25519_private_key` | TEXT | Ed25519 개인 키 (마이그레이션 0012) |

#### `statuses` -- 게시물

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT (PK, ULID) | 기본 키 |
| `uri` | TEXT (UNIQUE) | ActivityPub 객체 URI |
| `account_id` | TEXT (FK) | 작성자 계정 |
| `in_reply_to_id` | TEXT | 부모 게시물 ID |
| `reblog_of_id` | TEXT | 리블로그인 경우 원본 게시물 ID |
| `text` | TEXT | 소스 텍스트 (편집용) |
| `content` | TEXT | 렌더링된 HTML |
| `content_warning` | TEXT | 스포일러 텍스트 |
| `visibility` | TEXT | public/unlisted/private/direct |
| `sensitive` | INTEGER | 민감한 콘텐츠 플래그 |
| `language` | TEXT | 콘텐츠 언어 코드 |
| `conversation_id` | TEXT | 대화 스레드 ID |
| `poll_id` | TEXT | 연관된 투표 ID |
| `quote_id` | TEXT | 인용된 게시물 ID (마이그레이션 0013) |

**인덱스:** `idx_statuses_account_id`, `idx_statuses_uri`, `idx_statuses_in_reply_to`, `idx_statuses_reblog_of`, `idx_statuses_account_created`, `idx_statuses_visibility_created`, `idx_statuses_local_created`, `idx_statuses_conversation`, `idx_statuses_quote`

#### `media_attachments` -- 미디어 첨부파일

R2에 저장된 미디어 파일.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT (PK, ULID) | 기본 키 |
| `status_id` | TEXT | 연관 게시물 (첨부 전에는 nullable) |
| `account_id` | TEXT (FK) | 소유자 계정 |
| `file_key` | TEXT | R2 객체 키 |
| `file_content_type` | TEXT | MIME 타입 |
| `file_size` | INTEGER | 파일 크기 (바이트) |
| `thumbnail_key` | TEXT | 썸네일 R2 키 |
| `remote_url` | TEXT | 원본 원격 URL |
| `description` | TEXT | 대체 텍스트 (alt text) |
| `blurhash` | TEXT | 플레이스홀더용 BlurHash |
| `width` | INTEGER | 이미지 너비 |
| `height` | INTEGER | 이미지 높이 |
| `type` | TEXT | image/video/gifv/audio |
| `created_at` | TEXT | 생성 타임스탬프 |
| `updated_at` | TEXT | 업데이트 타임스탬프 |

#### `polls` -- 투표

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT (PK, ULID) | 기본 키 |
| `status_id` | TEXT (UNIQUE, FK) | 연관 게시물 |
| `expires_at` | TEXT | 만료 타임스탬프 |
| `multiple` | INTEGER | 복수 선택 허용 |
| `votes_count` | INTEGER | 총 투표 수 |
| `voters_count` | INTEGER | 총 투표자 수 |
| `options` | TEXT | JSON 배열: `[{title, votes_count}]` |
| `created_at` | TEXT | 생성 타임스탬프 |

#### `poll_votes` -- 투표 참여

개별 투표로 `UNIQUE(poll_id, account_id, choice)` 제약 조건이 있습니다.

#### `preview_cards` -- 미리보기 카드 (마이그레이션 0008)

OpenGraph 메타데이터를 통한 URL 미리보기.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT (PK, ULID) | 기본 키 |
| `url` | TEXT (UNIQUE) | 소스 URL |
| `title` | TEXT | 페이지 제목 |
| `description` | TEXT | 페이지 설명 |
| `type` | TEXT | link/photo/video/rich |
| `author_name` | TEXT | 저자 이름 |
| `author_url` | TEXT | 저자 URL |
| `provider_name` | TEXT | 제공자 이름 |
| `provider_url` | TEXT | 제공자 URL |
| `image_url` | TEXT | 미리보기 이미지 URL |
| `width` | INTEGER | 이미지 너비 |
| `height` | INTEGER | 이미지 높이 |
| `html` | TEXT | 임베드 HTML |
| `embed_url` | TEXT | 임베드 URL |
| `blurhash` | TEXT | 이미지 플레이스홀더 |
| `created_at` | TEXT | 타임스탬프 |
| `updated_at` | TEXT | 타임스탬프 |

`status_preview_cards`는 `status_id` + `preview_card_id` 조인 테이블입니다.

#### `web_push_subscriptions` -- Web Push 구독

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT (PK, ULID) | 기본 키 |
| `user_id` | TEXT (FK) | 구독 사용자 |
| `access_token_id` | TEXT (FK) | 연관 OAuth 토큰 |
| `endpoint` | TEXT | Push 서비스 엔드포인트 |
| `key_p256dh` | TEXT | 클라이언트 공개 키 |
| `key_auth` | TEXT | 클라이언트 인증 비밀 |
| `alert_mention` | INTEGER | 멘션 알림 |
| `alert_follow` | INTEGER | 팔로우 알림 |
| `alert_favourite` | INTEGER | 좋아요 알림 |
| `alert_reblog` | INTEGER | 리블로그 알림 |
| `alert_poll` | INTEGER | 투표 결과 알림 |
| `alert_status` | INTEGER | 새 게시물 알림 |
| `alert_update` | INTEGER | 게시물 편집 알림 |
| `alert_follow_request` | INTEGER | 팔로우 요청 알림 |
| `alert_admin_sign_up` | INTEGER | 새 가입 알림 |
| `alert_admin_report` | INTEGER | 새 신고 알림 |
| `policy` | TEXT | all/followed/follower/none |
| `created_at` | TEXT | 타임스탬프 |
| `updated_at` | TEXT | 타임스탬프 |

### 시드된 설정 값

`settings` 테이블에 초기 삽입되는 값:

| 키 | 기본값 | 설명 |
|-----|--------|------|
| `registration_mode` | `open` | 가입 모드 |
| `site_title` | `SiliconBeest` | 사이트 제목 |
| `site_description` | (비어있음) | 사이트 설명 |
| `site_contact_email` | (비어있음) | 연락처 이메일 |
| `site_contact_username` | (비어있음) | 연락처 사용자명 |
| `max_toot_chars` | `500` | 최대 게시물 문자 수 |
| `max_media_attachments` | `4` | 게시물당 최대 미디어 수 |
| `max_poll_options` | `4` | 최대 투표 옵션 수 |
| `poll_max_characters_per_option` | `50` | 옵션당 최대 문자 수 |
| `media_max_image_size` | `16777216` (16 MB) | 최대 이미지 크기 |
| `media_max_video_size` | `104857600` (100 MB) | 최대 비디오 크기 |
| `thumbnail_enabled` | `1` | 썸네일 생성 활성화 |
| `trends_enabled` | `1` | 트렌딩 기능 활성화 |
| `require_invite` | `0` | 초대 필요 여부 |
| `min_password_length` | `8` | 최소 비밀번호 길이 |

### 관계 테이블

| 테이블 | 관계 | 설명 |
|--------|------|------|
| `follows` | account -> target_account | 팔로우 관계 |
| `follow_requests` | account -> target_account | 대기 중인 팔로우 요청 |
| `favourites` | account -> status | 좋아요 |
| `blocks` | account -> target_account | 차단 |
| `mutes` | account -> target_account | 뮤트 |
| `bookmarks` | account -> status | 북마크 |
| `status_mutes` | account -> status | 게시물 알림 뮤트 (마이그레이션 0003) |
| `emoji_reactions` | account -> status + emoji | 이모지 반응 (마이그레이션 0004) |

### 알림 및 멘션

#### `notifications` -- 알림

타입: mention, follow, favourite, reblog, poll, follow_request, status, update, admin.sign_up, admin.report, emoji_reaction

#### `mentions` -- 멘션

게시물의 멘션 추출 및 저장.

### 태그 (해시태그)

- `tags`: 해시태그 레코드
- `status_tags`: 게시물-태그 조인 테이블
- `tag_follows`: 해시태그 팔로우

### OAuth 테이블

- `oauth_applications`: 클라이언트 앱 등록 (client_id, client_secret, scopes)
- `oauth_access_tokens`: 액세스 토큰 (bearer token, scopes, 만료)
- `oauth_authorization_codes`: 인증 코드 (PKCE 지원: code_challenge, code_challenge_method)

### 리스트

- `lists`: 사용자 리스트 (title, replies_policy, exclusive)
- `list_accounts`: 리스트-계정 조인 테이블

### 연합/인스턴스 관리

- `instances`: 알려진 원격 인스턴스 (도메인, 소프트웨어, 헬스 추적)
- `domain_blocks`: 도메인 차단 (severity: silence/suspend/noop)
- `domain_allows`: 도메인 허용 목록
- `relays`: 릴레이 구독 (마이그레이션 0002)

### Web Push 구독

`web_push_subscriptions`: 사용자별 Web Push 구독 (endpoint, keys, alert 설정, policy)

### 신고 및 모더레이션

- `reports`: 신고 (reporter, target, status_ids, category, resolution)
- `account_warnings`: 모더레이터 조치 기록
- `ip_blocks`: IP 차단 (CIDR)
- `email_domain_blocks`: 이메일 도메인 차단

### 타임라인 및 사용자 설정

- `home_timeline_entries`: 구체화된 홈 타임라인
- `markers`: 타임라인 위치 마커
- `user_preferences`: 키-값 사용자 설정
- `filters` + `filter_keywords` + `filter_statuses`: 콘텐츠 필터링

### 콘텐츠 테이블

- `preview_cards` + `status_preview_cards`: URL 미리보기 카드 (마이그레이션 0008)
- `settings`: 인스턴스 키-값 설정 (registration_mode, site_title, max_toot_chars 등)
- `custom_emojis`: 커스텀 이모지 (R2 저장)
- `announcements`: 관리자 공지사항
- `rules`: 인스턴스 규칙
- `conversations` + `conversation_accounts`: DM 대화 추적

### 투표

- `polls`: 투표 (options JSON, multiple, expires_at)
- `poll_votes`: 개별 투표

---

## 5. ActivityPub 구현

### 지원 프로토콜

- **ActivityPub** (W3C 권고안) -- 서버 간 (Server-to-Server)
- **WebFinger** (RFC 7033) -- 계정 디스커버리
- **NodeInfo 2.0/2.1** -- 인스턴스 메타데이터

### HTTP 서명

SiliconBeest는 최대 상호운용성을 위해 여러 HTTP 서명 방법을 지원합니다:

| 방법 | 방향 | 설명 |
|------|------|------|
| `draft-cavage-http-signatures-12` | 서명 + 검증 | 대부분의 Mastodon 호환 소프트웨어가 사용하는 레거시 표준. RSA-SHA256. |
| RFC 9421 (HTTP 메시지 서명) | 서명 + 검증 | 최신 표준. 아웃바운드 배달에 우선 사용. |
| Linked Data 서명 | 서명 + 검증 | 릴레이 전달을 위한 활동 객체의 RsaSignature2017. |
| Object Integrity Proofs (FEP-8b32) | 생성 + 검증 | `ed25519-jcs-2022` 암호화 스위트를 사용하는 Ed25519 기반 DataIntegrityProof. |

#### 더블 노크 배달 전략

원격 인박스에 활동을 배달할 때:

1. **첫 번째 시도**: RFC 9421 HTTP 메시지 서명으로 서명 (선호하는 최신 표준)
2. **거부 시** (서명 오류 응답): `draft-cavage-http-signatures-12`로 재시도 (레거시)
3. **선호도 캐싱**: 수신자의 선호 서명 방법이 KV에 7일간 캐싱됨

이는 최신 및 레거시 페디버스 서버 모두와의 호환성을 보장합니다.

#### 키 타입

- **RSA (RSASSA-PKCS1-v1_5, 2048비트)**: HTTP 서명용 주 서명 키, Actor 문서의 `publicKey`를 통해 참조
- **Ed25519**: Object Integrity Proofs (FEP-8b32)에 사용, `assertionMethod`에서 `Multikey` 타입과 `publicKeyMultibase` 인코딩으로 참조

### Object Integrity Proofs (FEP-8b32)

`ed25519-jcs-2022` 암호화 스위트를 사용하는 `DataIntegrityProof` 객체를 생성하고 검증합니다:

- **아웃바운드**: 모든 아웃바운드 활동이 actor의 Ed25519 키로 서명됨. `proof` 필드가 활동 JSON에 추가됨.
- **인바운드**: 수신 활동에 `proof` 필드가 있으면 발신자의 Ed25519 공개 키로 검증.
- **정규화**: JCS (JSON Canonicalization Scheme, RFC 8785)가 결정적 직렬화에 사용됨.

### Actor 직렬화

로컬 계정은 다음 구조로 ActivityPub Actor 문서로 직렬화됩니다:

**Person 타입** (일반 사용자 계정):
- `@context`: ActivityStreams + security + toot 확장
- `type`: `Person` (봇의 경우 `Service`)
- `id`: `https://{domain}/users/{username}`
- `publicKey`: RSA-2048 공개 키 (키 ID: `{id}#main-key`)
- `assertionMethod`: 무결성 증명용 Ed25519 Multikey
- `endpoints.sharedInbox`: `https://{domain}/inbox`
- `attachment`: `PropertyValue` 객체로서의 프로필 메타데이터 필드
- `alsoKnownAs`: 계정 이전용 별칭 URI

**Application 타입** (인스턴스 actor):
- `type`: `Application`
- `preferredUsername`: 인스턴스 도메인
- `manuallyApprovesFollowers`: true
- 릴레이 활동 서명용 자체 RSA 키쌍

### Note 직렬화

게시물은 ActivityPub Note 객체로 직렬화됩니다:

- `content`: 렌더링된 HTML
- `contentMap`: 언어별 콘텐츠 맵
- `summary`: 콘텐츠 경고 (스포일러 텍스트)
- `sensitive`: 미디어 민감도 플래그
- `inReplyTo`: 부모 Note URI
- `conversation`: 대화 스레드 URI (로컬은 tag: URI, 원격은 보존)
- `quoteUri`: 인용 게시물 URI (FEP-e232)
- `_misskey_quote`: Misskey 하위 호환

#### 가시성 주소 지정

| 가시성 | `to` | `cc` |
|--------|------|------|
| 공개(Public) | `as:Public` | Followers 컬렉션 + 멘션된 actor |
| 미리스트(Unlisted) | Followers 컬렉션 | `as:Public` + 멘션된 actor |
| 팔로워 전용(Private) | Followers 컬렉션 | 멘션된 actor |
| 다이렉트(Direct) | 멘션된 actor | (비어있음) |

### 인박스 처리

SiliconBeest는 13가지 이상의 수신 활동 타입을 처리합니다:

| 활동 | 처리기 | 설명 |
|------|--------|------|
| `Create` | `create.ts` | 새 원격 Note -- 게시물 생성, 멘션/태그 추출, 타임라인 팬아웃 큐잉 |
| `Update` | `update.ts` | 업데이트된 Note 또는 Actor -- 로컬 레코드 업데이트 |
| `Delete` | `delete.ts` | 삭제된 Note 또는 Actor -- 로컬에서 소프트 삭제 |
| `Follow` | `follow.ts` | 팔로우 요청 -- 자동 수락 또는 follow_request 생성 |
| `Accept` | `accept.ts` | 수락된 Follow -- 팔로우 관계 생성 |
| `Reject` | `reject.ts` | 거부된 Follow -- follow_request 제거 |
| `Like` | `like.ts` | 좋아요 -- favourite 레코드 + 알림 생성 |
| `Announce` | `announce.ts` | 리블로그 -- 리블로그 게시물 + 알림 생성 |
| `Undo` | `undo.ts` | Follow/Like/Announce/Block 취소 -- 원래 작업 되돌리기 |
| `Block` | `block.ts` | 차단 -- 차단 생성, 기존 팔로우 제거 |
| `Move` | `move.ts` | 계정 이전 -- alsoKnownAs 검증, 팔로워 이전 |
| `Flag` | `flag.ts` | 원격 신고 -- 로컬 신고 레코드 생성 |
| `EmojiReact` | `emojiReact.ts` | Misskey 이모지 반응 -- emoji_reaction 레코드 + 알림 생성 |

### 활동 전달

원격 활동이 로컬 팔로워를 대상으로 할 때, SiliconBeest는 원본 HTTP 헤더를 보존하여 전달하므로 대상에서 서명 검증이 성공할 수 있습니다. 이는 릴레이 시나리오에서 중요합니다.

### 컬렉션 페이지네이션

모든 컬렉션 엔드포인트는 `first`, `next`, `prev` 링크가 있는 `OrderedCollection`과 `OrderedCollectionPage`를 사용합니다:

- `/users/:username/followers` -- 페이지네이션된 팔로워 목록
- `/users/:username/following` -- 페이지네이션된 팔로잉 목록
- `/users/:username/outbox` -- `Create(Note)` 활동이 있는 페이지네이션된 아웃박스
- `/users/:username/featured` -- 고정된 게시물 (페이지네이션 없음)

### WebFinger

엔드포인트: `/.well-known/webfinger?resource=acct:user@domain`

- `acct:` URI 스킴 지원
- `application/jrd+json` 반환
- 링크: `self` (AP actor URI), `http://webfinger.net/rel/profile-page` (HTML 프로필)

### NodeInfo 2.0/2.1

엔드포인트:
- `/.well-known/nodeinfo` -- `/nodeinfo/2.0`으로 링크
- `/nodeinfo/2.0` -- 인스턴스 메타데이터

노출 메타데이터: 소프트웨어 이름/버전, 지원 프로토콜, 사용자 수, 게시물 수, 도메인 수, 가입 상태.

### 인스턴스 Actor

`/actor`에 `Application` 타입으로 노출:
- 릴레이 및 인스턴스 수준 활동 서명용 자체 RSA 키쌍
- `preferredUsername`: 인스턴스 도메인
- `manuallyApprovesFollowers: true`
- 공유 인박스: `/inbox`

### 릴레이 지원

관리자 API를 통해 관리되는 ActivityPub 릴레이 구독:
- 인증에 인스턴스 actor 사용
- 릴레이 상태: idle, pending, accepted, rejected
- LD 서명을 사용한 아웃바운드 활동 서명

### 활동 멱등성

KV를 사용한 수신 활동 중복 제거:
- 키: `activity:{sha256(activity.id)}`
- TTL: 7일
- 이미 처리된 활동 ID는 자동으로 무시됨

### 대화 스레딩

Note 객체의 `conversation` 필드 지원:
- 로컬 스레드: `tag:` URI 형식 사용
- 원격 `conversation` 값은 그대로 보존
- 사용자별 읽음 상태가 있는 `conversations` 테이블에서 추적

### FEP 준수

| FEP | 제목 | 상태 |
|-----|------|------|
| FEP-8b32 | Object Integrity Proofs | 완전 지원 (Ed25519 ed25519-jcs-2022 생성 + 검증) |
| FEP-8fcf | Followers Collection Synchronization | 지원 (페이지네이션된 팔로워, actor의 alsoKnownAs) |
| FEP-67ff | FEDERATION.md | 이 문서 (프로젝트 루트의 FEDERATION.md) |
| FEP-e232 | Object Links (Quote Posts) | 지원 (quoteUri, _misskey_quote) |

---

## 6. Mastodon API 호환성

### 구현된 엔드포인트

SiliconBeest는 100개 이상의 Mastodon 호환 REST API 엔드포인트를 구현합니다:

#### OAuth 2.0

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| GET | `/oauth/authorize` | 인증 페이지 |
| POST | `/oauth/authorize` | 인증 동의 |
| POST | `/oauth/token` | 토큰 교환 (authorization_code, client_credentials) |
| POST | `/oauth/revoke` | 토큰 폐기 |

#### 계정

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| POST | `/api/v1/accounts` | 새 계정 등록 |
| GET | `/api/v1/accounts/verify_credentials` | 현재 사용자 조회 |
| PATCH | `/api/v1/accounts/update_credentials` | 프로필 업데이트 |
| GET | `/api/v1/accounts/:id` | 계정 조회 |
| GET | `/api/v1/accounts/:id/statuses` | 계정 게시물 |
| GET | `/api/v1/accounts/:id/followers` | 팔로워 |
| GET | `/api/v1/accounts/:id/following` | 팔로잉 |
| POST | `/api/v1/accounts/:id/follow` | 팔로우 |
| POST | `/api/v1/accounts/:id/unfollow` | 언팔로우 |
| POST | `/api/v1/accounts/:id/block` | 차단 |
| POST | `/api/v1/accounts/:id/unblock` | 차단 해제 |
| POST | `/api/v1/accounts/:id/mute` | 뮤트 |
| POST | `/api/v1/accounts/:id/unmute` | 뮤트 해제 |
| GET | `/api/v1/accounts/relationships` | 관계 조회 |
| GET | `/api/v1/accounts/search` | 계정 검색 |
| GET | `/api/v1/accounts/lookup` | acct로 조회 |
| GET/PUT | `/api/v1/accounts/aliases` | 계정 별칭 |
| POST | `/api/v1/accounts/migration` | 계정 이전 |
| POST | `/api/v1/accounts/change_password` | 비밀번호 변경 |

#### 게시물

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| POST | `/api/v1/statuses` | 게시물 작성 |
| GET | `/api/v1/statuses/:id` | 게시물 조회 |
| PUT | `/api/v1/statuses/:id` | 게시물 편집 |
| DELETE | `/api/v1/statuses/:id` | 게시물 삭제 |
| GET | `/api/v1/statuses/:id/context` | 스레드 컨텍스트 |
| POST | `/api/v1/statuses/:id/favourite` | 좋아요 |
| POST | `/api/v1/statuses/:id/unfavourite` | 좋아요 취소 |
| POST | `/api/v1/statuses/:id/reblog` | 리블로그 |
| POST | `/api/v1/statuses/:id/unreblog` | 리블로그 취소 |
| POST | `/api/v1/statuses/:id/bookmark` | 북마크 |
| POST | `/api/v1/statuses/:id/unbookmark` | 북마크 해제 |
| POST | `/api/v1/statuses/:id/mute` | 스레드 뮤트 |
| POST | `/api/v1/statuses/:id/unmute` | 스레드 뮤트 해제 |
| POST | `/api/v1/statuses/:id/pin` | 고정 |
| POST | `/api/v1/statuses/:id/unpin` | 고정 해제 |
| GET | `/api/v1/statuses/:id/favourited_by` | 좋아요 한 사람 |
| GET | `/api/v1/statuses/:id/reblogged_by` | 리블로그 한 사람 |
| GET/POST | `/api/v1/statuses/:id/reactions` | 이모지 반응 |

#### 타임라인

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| GET | `/api/v1/timelines/home` | 홈 타임라인 |
| GET | `/api/v1/timelines/public` | 공개 타임라인 (로컬 + 연합) |
| GET | `/api/v1/timelines/tag/:tag` | 해시태그 타임라인 |
| GET | `/api/v1/timelines/list/:id` | 리스트 타임라인 |

#### 알림

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| GET | `/api/v1/notifications` | 알림 목록 |
| GET | `/api/v1/notifications/:id` | 알림 조회 |
| POST | `/api/v1/notifications/clear` | 모든 알림 삭제 |
| POST | `/api/v1/notifications/:id/dismiss` | 단일 알림 삭제 |

#### 대화, 투표, 리스트

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| GET | `/api/v1/conversations` | 대화 목록 |
| DELETE | `/api/v1/conversations/:id` | 대화 삭제 |
| POST | `/api/v1/conversations/:id/read` | 읽음 표시 |
| GET | `/api/v1/polls/:id` | 투표 조회 |
| POST | `/api/v1/polls/:id/votes` | 투표 참여 |
| GET/POST/PUT/DELETE | `/api/v1/lists` | 리스트 CRUD |

#### 기타 핵심 엔드포인트

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| GET | `/api/v1/favourites` | 좋아요한 게시물 목록 |
| GET | `/api/v1/bookmarks` | 북마크한 게시물 목록 |
| GET | `/api/v1/blocks` | 차단 계정 목록 |
| GET | `/api/v1/mutes` | 뮤트 계정 목록 |
| GET | `/api/v1/preferences` | 사용자 설정 |
| GET | `/api/v1/custom_emojis` | 인스턴스 커스텀 이모지 |
| GET/POST | `/api/v1/markers` | 타임라인 마커 |
| POST | `/api/v1/reports` | 신고하기 |
| GET/POST | `/api/v1/follow_requests` | 팔로우 요청 관리 |
| GET/POST | `/api/v1/tags` | 태그 팔로우/언팔로우 |
| GET | `/api/v1/suggestions` | 팔로우 추천 |
| GET | `/api/v1/announcements` | 공지사항 |
| GET | `/api/v1/instance/rules` | 인스턴스 규칙 |
| GET | `/api/v1/trends/tags` | 트렌딩 태그 |
| GET | `/api/v1/trends/statuses` | 트렌딩 게시물 |
| GET | `/api/v1/export` | CSV 내보내기 |
| POST | `/api/v1/import` | CSV 가져오기 |
| GET | `/api/v1/streaming` | WebSocket 스트리밍 업그레이드 |
| POST/GET/PUT/DELETE | `/api/v1/push/subscription` | Web Push 구독 관리 |
| GET | `/api/v1/instance` | 인스턴스 정보 (v1) |
| GET | `/api/v1/instance/peers` | 알려진 피어 |
| GET | `/api/v1/instance/activity` | 주간 활동 |
| POST | `/api/v1/auth/login` | 직접 로그인 (이메일+비밀번호) |
| POST | `/api/v1/auth/passwords` | 비밀번호 재설정 |

#### 관리자 API

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| GET | `/api/v1/admin/accounts` | 계정 목록 |
| GET | `/api/v1/admin/accounts/:id` | 계정 상세 |
| POST | `/api/v1/admin/accounts/:id/approve` | 가입 승인 |
| POST | `/api/v1/admin/accounts/:id/reject` | 가입 거부 |
| POST | `/api/v1/admin/accounts/:id/action` | 계정 조치 (사일런스/정지) |
| PUT | `/api/v1/admin/accounts/:id/role` | 역할 변경 |
| GET | `/api/v1/admin/reports` | 신고 목록 |
| GET | `/api/v1/admin/reports/:id` | 신고 상세 |
| POST | `/api/v1/admin/reports/:id/resolve` | 신고 해결 |
| POST | `/api/v1/admin/reports/:id/assign_to_self` | 신고 할당 |
| CRUD | `/api/v1/admin/domain_blocks` | 도메인 차단 관리 |
| CRUD | `/api/v1/admin/domain_allows` | 도메인 허용 관리 |
| CRUD | `/api/v1/admin/ip_blocks` | IP 차단 관리 |
| CRUD | `/api/v1/admin/email_domain_blocks` | 이메일 도메인 차단 관리 |
| CRUD | `/api/v1/admin/instance/rules` | 규칙 관리 |
| CRUD | `/api/v1/admin/announcements` | 공지사항 관리 |
| CRUD | `/api/v1/admin/custom_emojis` | 커스텀 이모지 관리 |
| GET/PATCH | `/api/v1/admin/instance/settings` | 인스턴스 설정 |
| CRUD | `/api/v1/admin/relays` | 릴레이 관리 |
| GET | `/api/v1/admin/federation` | 연합 모니터링 (인스턴스 헬스) |
| POST | `/api/v1/admin/email` | SMTP 이메일 설정 |
| POST | `/api/v1/admin/measures` | 측정 데이터 조회 |

#### API v2

| 메서드 | 엔드포인트 | 설명 |
|--------|----------|------|
| GET | `/api/v2/instance` | 향상된 인스턴스 정보 |
| GET | `/api/v2/search` | 검색 (계정, 게시물, 해시태그) |
| POST | `/api/v2/media` | 비동기 미디어 업로드 |
| CRUD | `/api/v2/filters` | 콘텐츠 필터 |

### OAuth 2.0 흐름

표준 준수 OAuth 2.0 인증 서버:

1. **클라이언트 등록**: `POST /api/v1/apps` -- `client_id`와 `client_secret` 반환
2. **인증**: `GET /oauth/authorize` -- 동의 화면 표시
3. **토큰 교환**: `POST /oauth/token` -- 인증 코드로 교환
4. **PKCE 지원**: 공개 클라이언트용 `code_challenge`와 `code_challenge_method` (S256)
5. **클라이언트 자격증명**: `POST /oauth/token` -- `grant_type=client_credentials`
6. **토큰 폐기**: `POST /oauth/revoke`

### 2FA/TOTP 지원

- RFC 6238 TOTP, `users` 테이블에 AES-GCM 암호화된 비밀 저장
- bcrypt로 해시된 백업 코드
- OTP 암호화 키는 Cloudflare 시크릿으로 저장 (`OTP_ENCRYPTION_KEY`)

### 스트리밍 WebSocket API

Cloudflare Durable Objects를 사용한 실시간 업데이트:

- **엔드포인트**: `GET /api/v1/streaming?stream={stream_name}`
- **스트림**: `user`, `public`, `public:local`, `hashtag:{tag}`, `list:{id}`, `direct`
- **이벤트**: `update`, `notification`, `delete`, `status.update`, `filters_changed`
- **하이버네이션**: Cloudflare의 Hibernatable WebSocket API로 비용 효율성
- **자동 핑/퐁**: `setWebSocketAutoResponse`로 설정

### Web Push 알림

- **VAPID** (RFC 8292): 푸시 서비스 인증용 ECDSA P-256 키 쌍
- **RFC 8291**: 메시지 암호화 (aes128gcm 콘텐츠 인코딩)
- **알림별 설정**: 사용자가 특정 알림 유형 활성화/비활성화 가능
- **정책**: all/followed/follower/none

### 페이지네이션

모든 목록 엔드포인트에서 커서 기반 페이지네이션 사용:
- `max_id` / `min_id` / `since_id` 쿼리 파라미터
- `Link` 헤더에 `rel="next"`와 `rel="prev"` URL
- ID가 ULID (시간 정렬 가능)이므로 커서 페이지네이션이 자연스러움

### 미디어 업로드

- **업로드**: `POST /api/v2/media` -- R2에 업로드, 미디어 첨부파일 엔티티 반환
- **제공**: `GET /media/:key` -- R2에서 적절한 Content-Type으로 제공
- **썸네일 처리**: 큐를 통한 비동기 처리
- **크기 제한**: 이미지 16 MB, 비디오 100 MB (설정으로 변경 가능)
- **타입**: image, video, gifv, audio

### 인용 게시물

- statuses의 `quote_id` 컬럼을 통해 지원
- `quoteUri` 속성으로 연합 (FEP-e232)
- `_misskey_quote`와 하위 호환

### 계정 이전

- **Move 활동**: 모든 팔로워에게 `Move(Actor)` 전송
- **alsoKnownAs**: 양방향 별칭 검증
- **CSV 내보내기/가져오기**: 팔로잉, 차단, 뮤트 목록
- **가져오기 처리**: 큐를 통한 비동기 (한 번에 하나씩)

---

## 7. Misskey 호환성

SiliconBeest는 상호운용성을 위해 여러 Misskey 전용 확장을 구현합니다:

### 콘텐츠 필드

| 필드 | 방향 | 설명 |
|------|------|------|
| `_misskey_content` | 인바운드 | 수신 Note 객체의 Misskey 포맷 MFM 콘텐츠 |
| `_misskey_summary` | 인바운드 | 콘텐츠 경고 텍스트 |
| `_misskey_quote` | 양방향 | 인용 게시물 참조 (FEP-e232 `quoteUri`와 하위 호환) |
| `_misskey_reaction` | 인바운드 | 이모지 반응 메타데이터 |

### EmojiReact 활동 타입

Misskey, Calckey, Firefish 및 호환 구현에서 사용하는 `EmojiReact` 활동 타입 지원:

- **인바운드**: `EmojiReact` 활동 처리, `emoji_reactions` 레코드 생성, 알림 전송
- **아웃바운드**: 사용자가 이모지로 반응할 때 `EmojiReact` 활동 전송
- **커스텀 이모지**: 유니코드 이모지와 커스텀 이모지 (`:shortcode:` 형식) 모두 지원
- **API**: `GET/POST /api/v1/statuses/:id/reactions`

### 커스텀 이모지 연합

커스텀 이모지는 Note 객체의 `Emoji` 태그로 연합됩니다. 원격 커스텀 이모지는 소스 인스턴스의 `domain`이 설정된 상태로 로컬에 캐싱됩니다.

---

## 8. 큐 시스템

### 두 개의 큐

| 큐 | 용도 | 재시도 | DLQ |
|----|------|--------|-----|
| `siliconbeest-federation` | 연합 관련 작업 (배달, 가져오기, 전달) | 5 | `siliconbeest-federation-dlq` |
| `siliconbeest-internal` | 내부 작업 (타임라인, 알림, 미디어, 트렌드) | 3 | 없음 |

### 메시지 타입 (15가지)

| 타입 | 큐 | 설명 |
|------|-----|------|
| `deliver_activity` | 연합 | 특정 원격 인박스에 단일 활동 배달 |
| `deliver_activity_fanout` | 연합 | 모든 팔로워 인박스에 활동 팬아웃 |
| `fetch_remote_account` | 연합 | 원격 AP actor 가져오기 및 캐싱 |
| `fetch_remote_status` | 연합 | 원격 AP 객체 가져오기 및 캐싱 |
| `update_instance_info` | 연합 | 알려진 인스턴스 메타데이터 업데이트 |
| `deliver_report` | 연합 | 원격 인스턴스에 신고 전달 |
| `forward_activity` | 연합 | 원본 HTTP 헤더 보존 활동 전달 |
| `import_item` | 연합 | 단일 CSV 가져오기 항목 처리 |
| `timeline_fanout` | 내부 | 모든 팔로워의 홈 타임라인에 게시물 삽입 |
| `create_notification` | 내부 | 알림 레코드 생성 및 Web Push 큐잉 |
| `process_media` | 내부 | 미디어 썸네일 처리 |
| `send_web_push` | 내부 | Web Push 알림 암호화 및 전송 |
| `fetch_preview_card` | 내부 | URL 미리보기용 OpenGraph 메타데이터 가져오기 |
| `cleanup_expired_tokens` | 내부 | 만료된 OAuth 토큰 정리 |
| `update_trends` | 내부 | 트렌딩 태그/게시물 업데이트 |

### 메시지 처리

큐 소비자는 배치의 `for` 루프에서 메시지를 처리합니다:

1. `msg.body.type`으로 올바른 핸들러에 디스패치
2. 성공 시: `msg.ack()`
3. 오류 시: `msg.retry()` (최대 재시도 후 연합 큐는 DLQ로)

### 인스턴스 헬스 추적

`instances` 테이블에서 배달 성공/실패를 추적:
- `last_successful_at`: 마지막 성공 배달 타임스탬프
- `last_failed_at`: 마지막 실패 배달 타임스탬프
- `failure_count`: 연속 실패 횟수
- 도달할 수 없는 인스턴스에 대한 백오프 구현에 사용

---

## 9. 프론트엔드 (Vue 3)

### 기술 스택

| 기술 | 버전 | 용도 |
|------|------|------|
| Vue 3 | ^3.5.29 | 반응형 UI 프레임워크 |
| Vite | ^7.3.1 | 빌드 도구 |
| Tailwind CSS 4 | ^4.2.2 | 유틸리티 우선 CSS |
| Pinia | ^3.0.4 | 상태 관리 |
| vue-i18n | ^11.3.0 | 국제화 |
| vue-router | ^5.0.3 | 클라이언트 사이드 라우팅 |
| @headlessui/vue | ^1.7.23 | 접근성 있는 UI 컴포넌트 |
| @sentry/vue | ^10.45.0 | 에러 추적 (선택사항) |
| @vueuse/core | ^14.2.1 | Vue 컴포지션 유틸리티 |

### 컴포넌트 아키텍처

컴포넌트는 도메인별로 구성됩니다:

| 카테고리 | 컴포넌트 | 용도 |
|----------|---------|------|
| **layout** | AppShell, Sidebar, MobileNav, AdminLayout | 애플리케이션 프레임 및 네비게이션 |
| **status** | StatusCard, StatusContent, StatusActions, StatusComposer, MediaGallery, PreviewCard | 게시물 표시 및 작성 |
| **account** | AccountCard, AccountHeader, FollowButton | 계정 표시 및 상호작용 |
| **common** | Avatar, EmojiPicker, ImageViewer, InfiniteScroll, LoadingSpinner, Modal, ReportDialog, Toast | 공유 UI 컴포넌트 |
| **notification** | NotificationItem | 알림 표시 |
| **auth** | LoginForm, RegisterForm, TwoFactorForm | 인증 폼 |
| **settings** | LanguageSelector | 설정 UI 컴포넌트 |
| **timeline** | TimelineFeed | 무한 스크롤 타임라인 |

### 라우팅 (30개 이상 라우트)

| 경로 | 가드 | 뷰 |
|------|------|-----|
| `/` | redirectIfAuthenticated | LandingView |
| `/home` | requireAuth | HomeView |
| `/explore/:tab` | (없음) | ExploreView |
| `/about` | (없음) | AboutView |
| `/search` | (없음) | SearchView |
| `/tags/:tag` | (없음) | TagTimelineView |
| `/login` | redirectIfAuthenticated | LoginView |
| `/register` | redirectIfAuthenticated | RegisterView |
| `/notifications` | requireAuth | NotificationsView |
| `/conversations` | requireAuth | ConversationsView |
| `/bookmarks` | requireAuth | BookmarksView |
| `/favourites` | requireAuth | FavouritesView |
| `/lists` | requireAuth | ListsView |
| `/lists/:id` | requireAuth | ListTimelineView |
| `/follow-requests` | requireAuth | FollowRequestsView |
| `/settings/*` | requireAuth | Settings* 뷰 (6개 하위 라우트) |
| `/admin/*` | requireAdmin | Admin* 뷰 (10개 하위 라우트) |
| `/@:acct` | (없음) | ProfileView |
| `/@:acct/:statusId` | (없음) | StatusDetailView |

### 스토어 (Pinia)

| 스토어 | 상태 | 용도 |
|--------|------|------|
| `auth` | 토큰, 현재 사용자, 2FA 상태 | 인증 및 세션 |
| `accounts` | 계정 캐시, 관계 | 계정 데이터 및 상호작용 |
| `statuses` | 게시물 캐시, 컨텍스트 | 게시물 데이터 및 작업 |
| `timelines` | 홈, 로컬, 공개, 태그, 리스트 피드 | 타임라인 조립 |
| `notifications` | 알림 목록, 읽지 않은 수 | 알림 |
| `compose` | 초안 텍스트, 미디어, 투표, 가시성 | 게시물 작성 |
| `instance` | 인스턴스 설정, 커스텀 이모지, 규칙 | 인스턴스 메타데이터 |
| `ui` | 테마, 사이드바 상태, 모바일 네비, 모달, 토스트 | UI 상태 관리 |

### 국제화 (i18n)

지연 로딩을 지원하는 12개 언어:

| 코드 | 언어 | 방향 |
|------|------|------|
| `en` | English | LTR |
| `ko` | 한국어 | LTR |
| `ja` | 일본어 | LTR |
| `zh-CN` | 중국어 간체 | LTR |
| `zh-TW` | 중국어 번체 | LTR |
| `es` | 스페인어 | LTR |
| `fr` | 프랑스어 | LTR |
| `de` | 독일어 | LTR |
| `pt-BR` | 브라질 포르투갈어 | LTR |
| `ru` | 러시아어 | LTR |
| `ar` | 아랍어 | **RTL** |
| `id` | 인도네시아어 | LTR |

영어는 기본값으로 즉시 로딩됩니다. 나머지 언어는 필요 시 동적 `import()`로 지연 로딩됩니다.

### 스트리밍 (WebSocket)

`api/streaming.ts` 모듈은 다음 기능의 WebSocket 클라이언트를 제공합니다:
- `/api/v1/streaming?stream={name}`에 연결
- 지수적 백오프로 자동 재연결
- Pinia 스토어에 이벤트 디스패치 (새 게시물, 알림, 삭제)
- 여러 스트림 구독 동시 처리

### Sentry 통합

`@sentry/vue`를 통한 선택적 에러 추적:
- `VITE_SENTRY_DSN` 환경 변수로 설정
- Vue 에러 핸들러와 통합

### 이미지 뷰어 모달

전체 화면 이미지 뷰어:
- 키보드 네비게이션 (화살표, Escape)
- 모바일 핀치 줌
- 이미지 다운로드

### 이모지 피커

커스텀 이모지 피커:
- 유니코드 이모지 카테고리
- 인스턴스 커스텀 이모지
- 자동완성 (`:shortcode` 트리거)
- 검색/필터 기능

### 반응형 디자인

- Tailwind CSS 4로 모바일 우선
- 모바일에서 하단 네비게이션 (`MobileNav.vue`)
- 데스크탑에서 사이드바 네비게이션 (`Sidebar.vue`)
- 시스템 인식 다크 모드 및 수동 토글

---

## 10. 관리자 기능

### 관리자 패널

관리자 패널은 `/admin`에서 접근 가능하며 `requireAdmin` 네비게이션 가드가 필요합니다. `AdminLayout.vue`에 사이드바 네비게이션을 사용합니다.

### 사용자 관리 (`/admin/accounts`)

- 필터링이 가능한 **계정 목록** (로컬, 원격, 활성, 대기, 정지, 사일런스)
- 대기 중인 가입 요청 **승인**
- 대기 중인 가입 **거부**
- 계정 **사일런스** (가시성 제한)
- 계정 **정지** (완전 차단)
- **역할 변경**: user, moderator, admin

### 신고 관리 (`/admin/reports`)

- 상태 필터링이 있는 **신고 목록** (열림, 해결됨)
- 신고된 게시물을 포함한 **신고 상세 보기**
- 모더레이터에게 **신고 할당**
- 조치와 함께 **신고 해결**
- 원격 인스턴스에 **신고 전달**

### 도메인 차단 (`/admin/domain-blocks`)

- 심각도별 도메인 차단 생성 (silence, suspend, noop)
- 옵션: 미디어 거부, 신고 거부, 도메인 난독화
- 공개/비공개 코멘트
- 허용 목록 모드를 위한 도메인 허용

### 커스텀 이모지 관리 (`/admin/custom-emojis`)

- 커스텀 이모지 업로드 (R2에 저장)
- 이모지 카테고리 분류
- 피커 가시성 토글
- 이모지 삭제

### 공지사항 (`/admin/announcements`)

- 선택적 시작/종료 날짜가 있는 공지사항 생성
- 공지사항 공개/비공개
- 종일 이벤트 지원
- 공지사항 편집/삭제

### 규칙 (`/admin/rules`)

- 인스턴스 규칙 생성
- 우선순위별 재정렬
- 규칙 편집/삭제

### 연합 모니터링 (`/admin/federation`)

- 인스턴스 헬스 대시보드
- 배달 성공/실패 통계
- 소프트웨어 정보가 포함된 알려진 인스턴스 목록
- 실패 횟수 추적

### 릴레이 관리 (`/admin/relays`)

- 릴레이 구독 추가
- 릴레이 상태 모니터링 (idle, pending, accepted, rejected)
- 릴레이 구독 제거

### SMTP 이메일 설정

SMTP 설정 구성: 호스트, 포트, 사용자, 비밀번호, 발신 주소. 비밀번호 재설정 이메일 및 알림 이메일에 사용됩니다.

### 인스턴스 설정 (`/admin/settings`)

- **브랜딩**: 사이트 제목, 설명, 썸네일
- **연락처**: 관리자 이메일, 관리자 사용자명
- **가입**: 공개, 승인 필요, 폐쇄
- **제한**: 최대 문자 수, 미디어 첨부파일, 투표 옵션
- **기능**: 트렌드, 썸네일 생성

---

## 11. 보안

### HTTP 서명 검증

- **타임스탬프 검증**: 수신 서명의 Date 헤더가 +-300초 이내인지 확인
- **다이제스트 검증**: 본문 다이제스트가 Digest 헤더와 일치하는지 검증
- **키 가져오기**: 발신자의 actor 문서에서 공개 키 가져오기
- **서명 알고리즘**: draft-cavage용 RSA-SHA256, RFC 9421용 설정 가능

### Content-Type 검증

인박스 엔드포인트는 수신 요청의 ActivityPub 콘텐츠 타입을 검증:
- `application/activity+json`
- `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`

### 속도 제한

KV 기반 슬라이딩 윈도우 속도 제한기 (`middleware/rateLimit.ts`):

| 프리셋 | 제한 | 윈도우 |
|--------|------|--------|
| `RATE_LIMIT_GENERAL` | 300 요청 | 5분 |
| `RATE_LIMIT_AUTH` | 30 요청 | 5분 |
| `RATE_LIMIT_REGISTRATION` | 5 요청 | 5분 |

키 형식: `rl:{ip}:{endpoint}:{windowId}`

응답 헤더:
- `X-RateLimit-Limit`: 최대 요청 수
- `X-RateLimit-Remaining`: 남은 요청 수
- `Retry-After`: 윈도우 리셋까지 초 (429 시)

### CORS 설정

CORS 미들웨어는 Mastodon 클라이언트 애플리케이션의 크로스 오리진 요청을 적절한 헤더와 함께 허용합니다.

### 비밀번호 해싱

- `bcryptjs` 라이브러리를 통한 **bcrypt**
- 가입 시 해싱, 로그인 시 검증

### TOTP 2FA

- **RFC 6238** TOTP 구현
- `OTP_ENCRYPTION_KEY` Cloudflare 시크릿을 사용하여 **AES-GCM**으로 OTP 비밀 암호화
- **백업 코드**: bcrypt로 해시된 일회용 코드
- 활성화 시 OAuth 토큰 교환 중 적용

### VAPID 인증

- **RFC 8292** VAPID -- Web Push 인증용
- `generate-vapid-keys.sh`로 생성된 ECDSA P-256 키 쌍
- Cloudflare 시크릿으로 저장

### 봇 보호

Cloudflare의 Bot Fight Mode가 연합을 방해할 수 있습니다 (ActivityPub 요청을 봇으로 차단). WAF Skip 규칙이 필요합니다:

```
(http.request.uri.path matches "^/users/.*" or
 http.request.uri.path eq "/inbox" or
 http.request.uri.path eq "/actor" or
 http.request.uri.path matches "^/nodeinfo/.*" or
 http.request.uri.path matches "^/.well-known/.*")
```

### HTML 살균

사용자 생성 HTML 콘텐츠는 XSS 방지를 위해 살균됩니다:
- `utils/sanitize.ts`가 위험한 태그 및 속성 제거
- 허용된 HTML 태그와 속성만 통과
- 수신 연합 콘텐츠와 로컬 작성 게시물 모두에 적용

---

## 12. 스크립트 및 배포

### 스크립트 설정

모든 스크립트는 `PROJECT_PREFIX`를 기반으로 리소스 이름을 정의하는 `scripts/config.sh`를 소스합니다:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PROJECT_PREFIX` | `siliconbeest` | 모든 리소스의 마스터 접두사 |
| `WORKER_NAME` | `{prefix}-worker` | API Worker |
| `CONSUMER_NAME` | `{prefix}-queue-consumer` | 큐 소비자 |
| `VUE_NAME` | `{prefix}-vue` | 프론트엔드 Worker |
| `D1_DATABASE_NAME` | `{prefix}-db` | D1 데이터베이스 |
| `R2_BUCKET_NAME` | `{prefix}-media` | R2 버킷 |
| `KV_CACHE_TITLE` | `{prefix}-CACHE` | 캐시 KV |
| `KV_SESSIONS_TITLE` | `{prefix}-SESSIONS` | 세션 KV |
| `QUEUE_FEDERATION` | `{prefix}-federation` | 연합 큐 |
| `QUEUE_INTERNAL` | `{prefix}-internal` | 내부 큐 |
| `QUEUE_DLQ` | `{prefix}-federation-dlq` | Dead Letter 큐 |

**커스터마이징 옵션:**
1. 환경 변수: `PROJECT_PREFIX=myserver ./scripts/setup.sh`
2. 영구 파일: `scripts/config.env`
3. 개별 오버라이드: `export D1_DATABASE_NAME=my-custom-db`

### setup.sh

대화형 초기 설정:

1. 프로젝트 접두사, 인스턴스 도메인, 제목, 가입 모드, 관리자 인증 정보, Sentry DSN 입력 요청
2. D1 데이터베이스, R2 버킷, KV 네임스페이스, Queues 생성
3. VAPID 키 쌍 (ECDSA P-256) 및 OTP 암호화 키 생성
4. 모든 `wrangler.jsonc` 파일에 리소스 ID 업데이트
5. `wrangler secret put`으로 시크릿 설정
6. D1 마이그레이션 적용
7. 관리자 사용자 생성
8. `siliconbeest-vue/.env` 작성

### deploy.sh

3개 Worker 모두 빌드 및 배포:

| 플래그 | 설명 |
|--------|------|
| `--domain <domain>` | 커스텀 도메인 Workers Routes 설정 |
| `--dry-run` | 배포될 내용 표시 |
| `--skip-migrations` | D1 마이그레이션 단계 건너뛰기 |

### update.sh

프로덕션 업데이트 워크플로우:

1. `git pull` (변경 로그 표시)
2. 모든 프로젝트 `npm install`
3. TypeScript 타입 체크
4. 테스트 실행
5. D1 마이그레이션 적용
6. 프론트엔드 빌드
7. 모든 Worker 배포

| 플래그 | 설명 |
|--------|------|
| `--branch <name>` | 풀할 Git 브랜치 |
| `--skip-pull` | 현재 작업 트리 사용 |
| `--skip-tests` | 테스트 단계 건너뛰기 |
| `--dry-run` | 배포 없이 확인 |

### configure-domain.sh

독립적인 도메인 설정 (재배포 없이):
- API 경로를 API Worker에 Workers Routes 생성
- Vue 프론트엔드에 catch-all 라우트 생성

### generate-vapid-keys.sh

VAPID Web Push용 ECDSA P-256 키 쌍 생성:
- `--set-secrets` 플래그로 Cloudflare에 저장

### seed-admin.sh

관리자 사용자 생성:
- 대화형 또는 인수: `./scripts/seed-admin.sh 이메일 사용자명 비밀번호`

### migrate.sh

D1 마이그레이션 적용:
- `--local`: 개발용
- `--remote`: 프로덕션 (기본값)
- `--dry-run`: 대기 중인 마이그레이션 목록만 표시

### backup.sh

D1 + R2 백업:
- `--skip-r2`: D1만
- `--output-dir`: 커스텀 위치

### delete-account.sh

AP 호환 계정 삭제:
- 모든 알려진 연합 서버에 `Delete(Actor)` 전송
- 로컬 데이터베이스에서 계정 제거
- `--all --confirm`: 서버 종료 시

### sync-config.sh

Cloudflare 리소스 ID를 wrangler.jsonc에 동기화:
- Cloudflare API에서 D1, KV, R2, Queue ID 가져오기
- 3개의 wrangler.jsonc 파일 모두 재생성
- `--apply`: 파일 작성 (기본값은 드라이 런)

---

## 13. 테스트

### 테스트 프레임워크

- **Vitest** + `@cloudflare/vitest-pool-workers`: Workers 런타임 환경에서 테스트
- 실제 Cloudflare Workers 런타임에서 테스트 실행
- D1 데이터베이스 테스트 가능 (인메모리)

### Worker 테스트 (49개 파일)

| 테스트 파일 | 커버리지 영역 |
|-------------|--------------|
| `accounts.test.ts` | 계정 CRUD, 프로필 업데이트, 관계 |
| `activity-idempotency.test.ts` | KV 기반 활동 중복 제거 |
| `activitypub.test.ts` | AP 인박스 처리, 활동 핸들링 |
| `actor-serializer.test.ts` | Actor 문서 직렬화 |
| `admin-*.test.ts` | 관리자 기능 (공지, 도메인 차단, 역할, 규칙) |
| `admin.test.ts` | 관리자 계정 관리 |
| `auth.test.ts` | 인증, 로그인, 토큰 관리 |
| `blocks-mutes.test.ts` | 차단 및 뮤트 작업 |
| `bookmarks-favourites.test.ts` | 북마크 및 좋아요 작업 |
| `collection-pagination.test.ts` | AP 컬렉션 페이지네이션 |
| `content-parser.test.ts` | 멘션, 해시태그, 링크 파싱 |
| `conversations.test.ts` | DM 대화 관리 |
| `custom-emojis.test.ts` | 커스텀 이모지 CRUD |
| `discovery.test.ts` | WebFinger, NodeInfo 디스커버리 |
| `ed25519-crypto.test.ts` | Ed25519 키 작업 |
| `emoji-reactions.test.ts` | 이모지 반응 작업 |
| `featured-collections.test.ts` | 고정/해제, featured 컬렉션 |
| `filters.test.ts` | 콘텐츠 필터 CRUD |
| `http-signatures.test.ts` | HTTP 서명 생성 및 검증 |
| `integrity-proofs.test.ts` | FEP-8b32 Object Integrity Proofs |
| `ld-signatures.test.ts` | Linked Data 서명 작업 |
| `oauth-flow.test.ts` | 전체 OAuth 2.0 흐름 + PKCE |
| `statuses.test.ts` | 게시물 CRUD, 가시성, 스레딩 |
| (기타 테스트 파일...) | 타임라인, 검색, 미디어, 투표, 신고, 비밀번호 등 |

### Vue 프론트엔드 테스트 (11개 파일)

| 테스트 파일 | 커버리지 영역 |
|-------------|--------------|
| `api/client.test.ts` | API 클라이언트 설정 및 인터셉터 |
| `components/Avatar.test.ts` | 아바타 컴포넌트 렌더링 |
| `components/LoadingSpinner.test.ts` | 로딩 스피너 컴포넌트 |
| `components/StatusActions.test.ts` | 게시물 액션 버튼 |
| `components/FollowButton.test.ts` | 팔로우 버튼 상태 관리 |
| `stores/auth.test.ts` | 인증 스토어 (로그인, 로그아웃, 토큰) |
| `stores/ui.test.ts` | UI 스토어 (테마, 사이드바, 모달) |
| `stores/statuses.test.ts` | 게시물 스토어 작업 |
| `stores/timelines.test.ts` | 타임라인 스토어 관리 |
| `router/guards.test.ts` | 네비게이션 가드 로직 |
| `i18n/i18n.test.ts` | i18n 설정 및 로케일 로딩 |

### 테스트 실행

```bash
# API Worker 테스트 (49개 파일)
cd siliconbeest-worker && npm test

# Vue 프론트엔드 테스트 (11개 파일)
cd siliconbeest-vue && npm test

# 모든 테스트 실행
cd siliconbeest-worker && npm test && cd ../siliconbeest-vue && npm test
```

---

## 14. 알려진 제한사항 및 향후 계획

### Cloudflare Workers 제약

| 제약 | 제한 | 영향 |
|------|------|------|
| 요청당 CPU 시간 | 30초 (Paid) | 복잡한 연합 작업은 청킹이 필요할 수 있음 |
| 서브리퀘스트 제한 | 요청당 50개 (Paid: 1000) | 많은 팔로워에 대한 팬아웃은 큐 배칭 필요 |
| 본문 크기 | 100 MB | 큰 미디어 업로드가 실패할 수 있음 |
| D1 행 크기 | ~1 MB | 매우 긴 게시물 콘텐츠가 잘릴 수 있음 |
| KV 값 크기 | 25 MB | 큰 캐시 객체는 분할 필요 |

### D1 제한사항

- **SQLite 기반**: 저장 프로시저 없음, 제한된 쿼리 복잡성
- **데이터베이스 간 JOIN 불가**: 모든 데이터에 단일 D1 데이터베이스
- **최종 일관성**: 글로벌 읽기 복제본이 약간 지연될 수 있음
- **전체 텍스트 검색 없음**: 검색은 기본 `LIKE` 쿼리 (FTS5 없음)

### 컨테이너 지원 없음

SiliconBeest는 비용을 낮추기 위해 Cloudflare Containers를 사용하지 않습니다:
- 무거운 이미지 처리 없음 (ImageMagick/Sharp 없음)
- 제한된 비디오 트랜스코딩
- 간소화된 BlurHash 생성

### 개선 영역

- 전체 텍스트 검색 (Workers AI 또는 외부 서비스 활용 가능)
- 비디오 트랜스코딩 파이프라인
- 고급 미디어 처리 (이미지 최적화, 형식 변환)
- 추가 FEP 구현
- 고팔로워 계정에 대한 성능 최적화
- 다이렉트 메시지용 E2E 암호화
- 확장을 위한 플러그인 시스템

---

## 15. 설정 레퍼런스

### 환경 변수 (wrangler.jsonc vars)

| 변수 | Worker | 설명 | 예시 |
|------|--------|------|------|
| `INSTANCE_DOMAIN` | API | 인스턴스 도메인명 | `social.example.com` |
| `INSTANCE_TITLE` | API | 인스턴스 표시 이름 | `My Fediverse Server` |
| `REGISTRATION_MODE` | API | open / approval / closed | `open` |

### 시크릿 (Cloudflare Secrets, 코드에 절대 포함 안 됨)

| 시크릿 | Worker | 설명 | 설정자 |
|--------|--------|------|--------|
| `VAPID_PRIVATE_KEY` | API, 큐 소비자 | ECDSA P-256 개인 키 (base64url) | `setup.sh` |
| `VAPID_PUBLIC_KEY` | API, 큐 소비자 | ECDSA P-256 공개 키 (base64url) | `setup.sh` |
| `OTP_ENCRYPTION_KEY` | API | TOTP 비밀용 AES-GCM 키 | `setup.sh` |
| `SMTP_HOST` | API | SMTP 서버 호스트명 (선택사항) | 관리자 설정 |
| `SMTP_PORT` | API | SMTP 서버 포트 (선택사항) | 관리자 설정 |
| `SMTP_USER` | API | SMTP 사용자명 (선택사항) | 관리자 설정 |
| `SMTP_PASS` | API | SMTP 비밀번호 (선택사항) | 관리자 설정 |
| `SMTP_FROM` | API | SMTP 발신 주소 (선택사항) | 관리자 설정 |

### Wrangler 바인딩

#### API Worker (`siliconbeest-worker/wrangler.jsonc`)

| 바인딩 | 타입 | 이름 |
|--------|------|------|
| `DB` | D1 Database | `siliconbeest-db` |
| `MEDIA_BUCKET` | R2 Bucket | `siliconbeest-media` |
| `CACHE` | KV Namespace | (ID별) |
| `SESSIONS` | KV Namespace | (ID별) |
| `QUEUE_FEDERATION` | Queue Producer | `siliconbeest-federation` |
| `QUEUE_INTERNAL` | Queue Producer | `siliconbeest-internal` |
| `STREAMING_DO` | Durable Object | `StreamingDO` 클래스 |

#### 큐 소비자 (`siliconbeest-queue-consumer/wrangler.jsonc`)

| 바인딩 | 타입 | 이름 |
|--------|------|------|
| `DB` | D1 Database | `siliconbeest-db` |
| `MEDIA_BUCKET` | R2 Bucket | `siliconbeest-media` |
| `CACHE` | KV Namespace | (ID별) |
| `QUEUE_FEDERATION` | Queue Producer/Consumer | `siliconbeest-federation` |
| `QUEUE_INTERNAL` | Queue Producer/Consumer | `siliconbeest-internal` |
| `WORKER` | Service Binding | `siliconbeest-worker` |

#### Vue 프론트엔드 (`siliconbeest-vue/wrangler.jsonc`)

서비스 바인딩 없음. 정적 자산만 제공.

### 프론트엔드 환경 (`siliconbeest-vue/.env`)

| 변수 | 필수 | 설명 |
|------|------|------|
| `VITE_INSTANCE_DOMAIN` | 예 | 인스턴스 도메인 (메타 태그용) |
| `VITE_VAPID_PUBLIC_KEY` | 예 | VAPID 공개 키 (Web Push 구독용) |
| `VITE_SENTRY_DSN` | 아니오 | 에러 추적용 Sentry DSN |

### 인스턴스 설정 (D1 `settings` 테이블)

관리자 API를 통해 런타임에 설정 가능:

| 키 | 타입 | 기본값 | 설명 |
|----|------|--------|------|
| `registration_mode` | string | `open` | open/approval/closed |
| `site_title` | string | `SiliconBeest` | 인스턴스 이름 |
| `site_description` | string | (비어있음) | 인스턴스 설명 |
| `site_contact_email` | string | (비어있음) | 연락처 이메일 |
| `site_contact_username` | string | (비어있음) | 연락처 계정 |
| `max_toot_chars` | number | `500` | 최대 게시물 문자 수 |
| `max_media_attachments` | number | `4` | 게시물당 최대 미디어 수 |
| `max_poll_options` | number | `4` | 최대 투표 옵션 수 |
| `poll_max_characters_per_option` | number | `50` | 투표 옵션당 최대 문자 수 |
| `media_max_image_size` | number | `16777216` | 최대 이미지 크기 (바이트) |
| `media_max_video_size` | number | `104857600` | 최대 비디오 크기 (바이트) |
| `thumbnail_enabled` | boolean | `1` | 썸네일 생성 활성화 |
| `trends_enabled` | boolean | `1` | 트렌딩 기능 활성화 |
| `require_invite` | boolean | `0` | 가입에 초대 필요 |
| `min_password_length` | number | `8` | 최소 비밀번호 길이 |

---

## 부록: 도메인 변경 경고

> **주의**: 연합 시작 후 인스턴스 도메인을 변경하지 마세요. ActivityPub actor URI에는 도메인이 포함되어 있으며 페디버스 전체에서 영구 식별자입니다. 다른 서버가 actor를 캐싱한 후 도메인을 변경하면 모든 기존 연합 관계, 팔로워 및 대화가 깨집니다. 시작 전에 도메인을 신중하게 선택하세요.
