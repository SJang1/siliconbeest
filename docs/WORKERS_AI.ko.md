# 선택적 Workers AI

[English](WORKERS_AI.md)

SiliconBeest는 [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)를 사용해 추천 타임라인, 요청 시 게시물 번역, 이미지 ALT 자동 생성을 제공할 수 있습니다. 기본값은 **비활성화**입니다. 기본 설정에서는 메인 Worker의 Wrangler 파일에 AI 및 AI rate-limit 바인딩이 없고, 모델 추론이 실행되지 않으며, Workers AI 사용 요금도 발생하지 않습니다.

활성화는 두 단계로 이루어집니다.

1. 운영자가 배포 전체의 `WORKERS_AI_ENABLED` 마스터 스위치를 켭니다.
2. 관리자가 관리자 설정에서 추천 타임라인, 게시물 번역, 이미지 ALT 자동 생성을 각각 독립적으로 켭니다.

관리자 스위치 세 개도 모두 기본값이 꺼짐입니다. 저장된 키가 없으면 꺼짐으로 해석하므로 기존 설치에 Workers AI **기능 설정용** migration이나 새 feature-flag SQL문을 추가할 필요가 없습니다. 기존 instance 설정 batch가 query 추가 없이 세 값을 함께 읽어 하나의 write-through KV snapshot을 채우고, 추천·번역·업로드 요청 경로의 feature-flag 검사는 D1 대신 이 snapshot을 읽습니다. 이는 추천 활동 이력과는 별개입니다. 계정별 추천 신호를 영구 저장하기 위해 `0047_recommendation_activities.sql` migration이 D1 table을 추가합니다. 마스터 스위치가 항상 우선하므로 저장된 관리자 선택과 관계없이 마스터가 꺼져 있으면 세 기능을 모두 사용할 수 없습니다.

## GitHub Actions에서 활성화

다음 GitHub Actions 변수를 `production` Environment에 추가합니다. 신뢰할 수 있는 PR Preview에서도 AI가 필요할 때만 `preview` Environment에 같은 변수를 별도로 추가하세요.

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `WORKERS_AI_ENABLED` | `false` | 모든 선택적 AI 기능의 마스터 스위치 |
| `WORKERS_AI_RECOMMENDATION_MODEL` | `@cf/baai/bge-m3` | 추천 타임라인 후보 점수 계산 |
| `WORKERS_AI_TRANSLATION_MODEL` | `@cf/meta/m2m100-1.2b` | 게시물 텍스트 번역 |
| `WORKERS_AI_IMAGE_CAPTION_MODEL` | `@cf/moondream/moondream3.1-9B-A2B` | 이미지 ALT 생성 |
| `WORKERS_AI_RATE_LIMITS` | `true` | Workers AI 활성화 시 계정별 네이티브 추론 보호 장치 생성 |
| `WORKERS_AI_RECOMMENDATION_RATE_LIMIT` | `2` | 설정 기간당 추천 page 요청 최대 횟수 |
| `WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS` | `60` | 추천 제한 기간이며 `10` 또는 `60`만 유효 |
| `WORKERS_AI_TRANSLATION_RATE_LIMIT` | `6` | 설정 기간당 번역 요청 최대 횟수 |
| `WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS` | `60` | 번역 제한 기간이며 `10` 또는 `60`만 유효 |
| `WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT` | `4` | 설정 기간당 이미지 설명 자동 생성 최대 시도 횟수 |
| `WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS` | `60` | 이미지 설명 제한 기간이며 `10` 또는 `60`만 유효 |
| `WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID` | `1001` (PR Preview는 `2001`) | 추천 생성용 네이티브 rate-limit namespace |
| `WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID` | `1002` (PR Preview는 `2002`) | 번역용 네이티브 rate-limit namespace |
| `WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID` | `1003` (PR Preview는 `2003`) | 이미지 ALT 자동 생성용 네이티브 rate-limit namespace |

`WORKERS_AI_ENABLED`와 `WORKERS_AI_RATE_LIMITS`에는 소문자 문자열 `true` 또는 `false`만 사용할 수 있습니다. 마스터 값이 없으면 `false`, rate limiting 값이 없으면 `true`가 되며, `TRUE`, `1`, `yes` 같은 값은 설정 생성을 즉시 실패시킵니다. 각 한도는 양의 정수여야 하고 각 기간은 정확히 `10`초 또는 `60`초여야 합니다.

변수를 바꾼 뒤 해당 Workflow를 다시 실행합니다. 설정 및 타입 검증은 다음 순서로 동작합니다.

1. GitHub 변수를 `scripts/config.env`에 기록합니다.
2. `./scripts/sync-config.sh --apply`를 실행합니다.
3. `cf-typegen`을 실행하고 전체 Worker를 `tsc --noEmit`으로 검사합니다.
4. 메인 Worker를 빌드합니다.
5. 배포 Workflow는 기존 D1 migration 단계를 실행한 뒤 배포하고, PR Preview Workflow는 preview version을 업로드합니다.

Deploy, PR Preview, Upstream Sync Deploy 세 Workflow 모두 설정 동기화 직후 이 타입 생성 및 Worker 타입 검사를 실행합니다. 따라서 바인딩이 타입과 맞지 않으면 빌드나 배포 전에 Workflow가 실패합니다. 일반 배포 migration 단계에서 `0047_recommendation_activities.sql`을 적용하며, 이 migration은 추천 활동 table과 index를 만들고 기존 로컬 사용자마다 조건에 맞는 최신 공개 게시·리포스트·좋아요 신호 30개를 backfill합니다. 관리자 스위치 세 개는 기존 설정 저장소를 계속 사용하므로 별도의 기능 설정 migration이 필요하지 않습니다.

Workers AI를 활성화하면 생성된 `siliconbeest/wrangler.jsonc`에 `AI`라는 원격 바인딩이 들어갑니다. `WORKERS_AI_RATE_LIMITS=true`이면 네이티브 Rate Limiting 바인딩 세 개도 들어가며, 이를 `false`로 설정하면 `AI`는 유지하고 모든 `ratelimits` 바인딩만 제외합니다. `WORKERS_AI_ENABLED=false`이면 rate-limit 설정과 관계없이 `ai`와 `ratelimits`가 모두 빠집니다. 모델 변수는 모든 모드에서 `vars`에 남아 애플리케이션 설정을 안정적으로 유지합니다. Queue Consumer와 Email Sender에는 이 바인딩들이 생성되지 않습니다.

두 스위치가 모두 `true`이면 각 Rate Limiting namespace ID는 양의 정수 문자열이어야 하고 세 ID가 서로 달라야 하며, 같은 Cloudflare account 안에서 나타내는 동작별로 고유해야 합니다. Preview traffic이 production 한도를 함께 소비하지 않도록 production과 preview에 서로 다른 ID를 사용하세요. `WORKERS_AI_RATE_LIMITS=false`이면 namespace ID가 필요하지 않습니다.

Cloudflare의 네이티브 바인딩 및 `env.AI.run()` 설명은 [Workers AI 바인딩 문서](https://developers.cloudflare.com/workers-ai/configuration/bindings/), 요청 보호 장치는 [Rate Limiting 바인딩 문서](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)를 참고하세요.

## 로컬 설정

저장소 root에서 예제 파일을 복사하고 마스터 스위치를 켠 다음 Wrangler 설정을 다시 생성합니다. 네이티브 rate limiting을 사용할 때 아래 namespace ID는 예시이므로 같은 Cloudflare account에서 이미 사용 중이면 다른 값으로 바꾸세요.

```bash
cp scripts/config.env.example scripts/config.env
```

```dotenv
WORKERS_AI_ENABLED=true
WORKERS_AI_RECOMMENDATION_MODEL=@cf/baai/bge-m3
WORKERS_AI_TRANSLATION_MODEL=@cf/meta/m2m100-1.2b
WORKERS_AI_IMAGE_CAPTION_MODEL=@cf/moondream/moondream3.1-9B-A2B
WORKERS_AI_RATE_LIMITS=true
WORKERS_AI_RECOMMENDATION_RATE_LIMIT=2
WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS=60
WORKERS_AI_TRANSLATION_RATE_LIMIT=6
WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS=60
WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT=4
WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS=60
WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID=1001
WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID=1002
WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID=1003
```

```bash
./scripts/sync-config.sh --apply
cd siliconbeest
pnpm cf-typegen
pnpm exec tsc --noEmit -p tsconfig.worker.json
pnpm type-check
```

그다음 build된 Worker를 로컬에서 시작합니다.

```bash
pnpm preview
```

원격 AI 바인딩을 사용하려면 Wrangler 인증이 필요합니다. Preview를 시작하기 전에 `siliconbeest`에서 `pnpm wrangler whoami`를 실행하고, 필요하면 `pnpm wrangler login`으로 로그인하세요.

관리자 계정으로 로그인해 `/admin/settings`를 열고, 테스트할 AI 기능만 각각 켜서 저장합니다. 배포 마스터 스위치만 켜서는 사용자에게 어떤 AI 기능도 노출되지 않는 것이 정상입니다. 추천 기능을 테스트하기 전에 `0047_recommendation_activities.sql`을 포함한 저장소의 일반 D1 migration을 적용하세요. 관리자 선택 자체에는 기능 설정 migration이 필요하지 않습니다. 기존 설정 저장소를 사용하고 키가 없으면 꺼짐이며, 추론 제한은 D1 counter가 아니라 Cloudflare 네이티브 바인딩을 사용합니다.

간단한 end-to-end 확인은 별도 AI 추천 피드 navigation으로 이동해 새로고침하고, 대상이 되는 public 또는 unlisted 게시물에서 번역을 요청하고, ALT를 비운 지원 이미지 하나를 업로드하면 됩니다. 업로드 UI에는 ALT 생성 중 상태가 보인 뒤 일반 미디어 상태 polling이 끝나면 생성된 설명이 표시되어야 합니다.

`cf-typegen`은 tracked 파일인 `scripts/typegen.env`를 자동으로 읽습니다. 이 파일에는 `OTP_ENCRYPTION_KEY`, `SETUP_SECRET`, `SENTRY_DSN` 바인딩의 타입 생성용 placeholder만 있으며 런타임 secret이 아닙니다. 이 값을 배포하거나 로컬 credential로 사용하거나, 파일에 실제 secret을 넣으면 안 됩니다. `worker-configuration.d.ts`는 현재 Wrangler 모드로 Wrangler가 생성하므로 직접 수정하지 않습니다.

AI를 켜거나 끈 뒤에는 같은 타입 생성, 전체 Worker `tsc`, 애플리케이션 타입 검사를 실행하세요.

AI 추론은 오프라인 작업이 아닙니다. 생성되는 바인딩이 원격이므로 `pnpm preview`와 PR Preview에서도 입력이 Cloudflare로 전송되고 Workers AI 할당량을 사용하며 비용이 발생할 수 있습니다. 일반 `pnpm dev`는 Nuxt 개발 서버만 실행하므로 그 자체로 실제 Workers AI 바인딩을 제공하지 않습니다. 반드시 필요하고 신뢰할 수 있는 경우가 아니라면 GitHub `preview` Environment에서는 AI를 끄세요.

로컬 AI 사용을 중지하려면 관리자 스위치 세 개를 끕니다. 바인딩까지 제거하려면 `scripts/config.env`에서 `WORKERS_AI_ENABLED=false`로 바꾸고 `./scripts/sync-config.sh --apply`를 다시 실행한 뒤 `siliconbeest`에서 `pnpm cf-typegen`을 다시 실행합니다.

## 관리자 기능 스위치

관리자 스위치 세 개는 서로 독립적이며 배포 마스터 스위치와 함께 평가합니다.

| 관리자 스위치 | 꺼져 있을 때 사용자 화면 |
| --- | --- |
| 추천 타임라인 | 별도 AI 추천 피드 navigation, page 및 Deck column 추가 항목을 표시하지 않습니다. |
| 게시물 번역 | 게시물에 번역 메뉴를 표시하지 않습니다. |
| 이미지 ALT 자동 생성 | 업로드 시 AI caption을 건너뜁니다. 수동 ALT 입력은 AI 기능이 아니므로 계속 사용할 수 있습니다. |

스위치를 끄면 관련 사용자 UI를 숨길 뿐 아니라 해당 추론 경로도 실행하지 않습니다. AI 섹션은 관리자에게 계속 보입니다. 배포 마스터가 꺼져 있으면 세 스위치를 비활성화하고 배포 설정 안내를 표시하며, 운영자가 마스터를 켠 뒤 관리자가 원하는 기능만 골라 켤 수 있습니다.

기존 설정 endpoint는 `workers_ai_recommendation_enabled`, `workers_ai_translation_enabled`, `workers_ai_image_description_enabled`를 저장합니다. 문자열 `1`일 때만 켜짐이며 키가 없거나 다른 값이면 꺼짐입니다. 이 키를 SQL로 seed하지 마세요.

## 기능 동작

### 추천 타임라인

`POST /api/v1/timelines/recommended`가 page를 생성합니다. 새 피드는 `cursor` 없이 요청하고, 다음 page는 Link의 opaque cursor를 전달합니다. 최초 page와 연속 page는 모두 POST 전용이며, rate limiting을 켰다면 모든 요청이 설정된 추천 Rate Limiter binding을 소비합니다. 새로 생성하는 비어 있지 않은 page마다 추론을 실행합니다. 성공한 cursor를 다시 요청하면 추가 모델 호출 없이 단기 memoized 결과를 반환할 수 있고, 후보 window가 비어 있으면 추론 없이 피드를 끝냅니다. 로그인과 `read:statuses` scope가 필요합니다. 기본 page는 게시물 30개입니다. D1은 사용자가 볼 수 있는 최신 public(공개) 게시물과 해당 사용자의 홈 피드에 실제 올라올 수 있는 게시물에서 요청 page 크기의 최대 5배(최대 200개)인 rolling 후보 window를 먼저 만듭니다. 요청한 사용자의 게시물도 조건에 맞으면 포함하고, Direct 게시물은 제외하며, 조건에 맞는 boost는 원본 게시물로 정규화합니다. 본문을 AI로 보내기 전에 기존 visibility, 계정 상태, 차단, 관계 필터를 모두 적용합니다. 홈 피드에 포함 가능한 게시물은 공개 범위가 public이 아닐 수도 있으므로, 요청한 사용자가 볼 권한이 있는 비공개 범위 게시물 본문을 모델이 처리할 수 있습니다.

Home과 AI 추천은 timeline, store, route, navigation 진입점이 완전히 별개입니다. Aurora와 Classic은 전용 추천 피드 page로 열고, Deck에서는 전용 추천 column을 추가할 수 있습니다. 추천 피드는 Home을 대체하거나 Home 게시물을 걸러내거나 섞어 넣지 않으며, 추천 새로고침도 Home을 새로고침하지 않습니다.

관심사 query는 팔로우한 태그와 공개 게시물에 관한 활동만 사용합니다. D1의 `recommendation_activities`에는 계정별로 조건에 맞는 최신 `posted`, `reposted`, `liked` 신호 30개를 유지하며, `0047_recommendation_activities.sql` migration은 기존 로컬 사용자에게도 같은 범위의 이력을 backfill합니다. 새 신호 기록, 30개를 초과한 오래된 신호 정리, 취소 또는 삭제에 따른 제거는 Worker의 `waitUntil()` lifetime으로 예약하므로 게시·리포스트·좋아요·취소·삭제의 주 응답이 추천 이력 관리 작업을 기다리지 않습니다. 비공개 게시물 활동은 처음부터 기록하지 않습니다. 추천을 생성할 때는 D1에 남은 활동 전체를 읽고 현재 게시물 row를 기준으로 다시 확인합니다. 원본이 여전히 공개 상태이고 삭제되지 않은 원본 게시물이며, `posted` 신호는 여전히 해당 계정 소유일 때만 사용합니다. 따라서 background 제거가 늦어지거나 나중에 visibility가 바뀌어도 오래된 활동이 입력에 노출되지 않습니다.

유지된 모든 활동의 태그, 언어, 제한된 본문 snippet을 모델 query에 합치며, 직접 게시하거나 리포스트한 활동은 좋아요보다 강한 신호로 가중합니다. query는 최대 7,000자로 제한하여 BGE-M3가 임의로 관심사를 만들게 하지 않고 ranker에 명시적인 사용자 관심 신호를 줍니다. 각 후보 context는 최대 400자의 평문으로 바꾸고 명백한 URL, 이메일 주소, 멘션을 제거한 뒤 추론하지만, 남은 게시물 본문도 Cloudflare로 전송되는 콘텐츠입니다.

기본 [BGE-M3](https://developers.cloudflare.com/workers-ai/models/bge-m3/) 어댑터는 모델의 `query`와 순서가 있는 `contexts` 점수 계산 계약으로 각 rolling window를 재정렬합니다. AI는 권한 검사 수단이 아니며 D1 필터가 항상 먼저 실행되고, 추론 뒤에는 선택한 page와 예비 후보의 visibility를 다시 검사합니다. UI는 결과를 AI 생성 추천 피드라고 명확히 표시합니다. 연속 page 상태는 새로고침을 시작한 시점의 상한과 관심사 query를 고정하고, 이미 표시했거나 무효가 된 ID를 기록합니다. page마다 이 ID 목록을 하나의 JSON binding으로 전달하고 SQLite `json_each`로 펼쳐 D1 query 안에서 제외합니다. 이번 page에서 선택되지 않은 최신 후보는 계속 대상에 남고, 제외 목록이 늘어난 만큼 더 오래된 후보를 window에 보충한 뒤 다시 섞어 랭킹합니다. 따라서 200은 전체 피드 제한이 아니라 page마다 사용하는 후보 window의 상한이며, 조건에 맞는 게시물이 없어질 때까지 중복 없이 계속 pagination합니다. 새로고침하면 시점 상한과 seed 및 피드의 표시/무효 제외 목록을 초기화하고, 영구 저장된 D1 활동 이력으로 새 query를 만듭니다. D1 활동 이력 자체를 지우거나 다시 구축하지는 않습니다.

추론을 사용할 수 없거나 잘못된 랭킹을 반환하면 AI 추천 피드 생성 실패와 새로고침 재시도 안내를 UI에 표시합니다. 일반 타임라인으로 조용히 대체하지 않습니다. 일반 홈 타임라인은 이 과정과 독립적으로 계속 사용할 수 있습니다. KV는 계정별 5분 pagination 상태에만 사용합니다. 고정 시점 상한, seed, 생성된 관심사 query, 표시/무효 ID 및 같은 cursor 재시도를 안정적으로 처리하는 memoized 응답이 여기에 포함됩니다. 영구 활동 이력은 KV가 아니라 D1에 저장합니다. 후보 게시물 본문과 모델 점수는 별도로 저장하지 않으며, 이 구현을 위해 별도의 Vectorize index도 만들지 않습니다.

### 게시물 번역

번역은 POST 전용 `POST /api/v1/statuses/:id/translate?lang=...`를 통해 요청합니다. 로그인한 사용자가 볼 권한이 있는 원본 public 또는 unlisted 게시물만 대상이며 `read:statuses` OAuth scope가 필요합니다. `lang`은 선택 사항이며 없으면 사용자 locale, 그마저 없으면 영어를 사용합니다. 서비스는 정제된 게시물 내용의 entity를 decode하고 평문을 추출한 뒤, 모델 결과를 escape 및 linkify해 안전한 HTML로 반환합니다. 번역 입력이 10,000자를 넘으면 직전 문단 경계에서 나누어 순차적으로 배치 번역한 뒤 원래 순서대로 합칩니다. 한 문단 자체가 제한을 넘는 경우에는 안전한 문자 경계로 나눕니다. 내장 UI는 대상 게시물 바로 아래에 가벼운 Twitter식 inline 번역 action을 표시합니다. 요청 중에는 원문을 그대로 유지하고, 성공하면 같은 본문 위치를 번역문으로 교체하며 action은 원문 보기로 바뀝니다. 번역문에는 사용한 모델과 AI 번역이 부정확할 수 있다는 안내를 함께 표시합니다. sensitive 또는 Content Warning으로 가려진 게시물에는 번역 action을 표시하지 않으므로 기존 열람 제어를 우회하지 않습니다. 해당 관리자 스위치 또는 마스터 스위치가 꺼져 있으면 번역 메뉴 자체를 렌더링하지 않습니다. 요청을 시작한 뒤 지원하지 않는 번역 방향이거나 추론이 실패하면 원문은 그대로 보이고 번역 UI에 오류를 표시합니다.

[M2M100](https://developers.cloudflare.com/workers-ai/models/m2m100-1.2b/)이 범용 기본 모델입니다. [IndicTrans2 English-to-Indic](https://developers.cloudflare.com/workers-ai/models/indictrans2-en-indic-1B/)는 특수 어댑터입니다. 영어 본문과 문자 체계를 포함한 `target_language`를 입력하고 `translations` 배열을 출력합니다. M2M100의 `source_lang` / `target_lang` 및 `translated_text` 계약을 그대로 사용하는 교체 모델이 아닙니다.

### 이미지 ALT 자동 생성

ALT 생성은 업로드를 수락한 뒤 Worker의 background lifetime에서 시작합니다. 최초 `202` 응답은 `description_generation_status`를 `pending`으로 표시하고, 일반 미디어 상태 GET은 현재 설명과 함께 `pending`, `complete`, `failed`, `disabled` 중 하나를 반환합니다. 대기 중에는 업로드 UI에 ALT를 생성 중이라고 표시합니다. 마스터 및 이미지 ALT 자동 생성 관리자 스위치가 모두 켜져 있고, 제출한 설명이 비어 있으며, 추론 payload가 10 MiB 이하인 JPEG, PNG, WebP 업로드에만 실행됩니다. GIF, 그 밖의 형식, 더 큰 파일은 정상 업로드되지만 AI를 건너뜁니다.

생성된 텍스트는 정규화되고 애플리케이션의 ALT 제한인 1,500자로 잘린 뒤 미디어 첨부에 저장됩니다. 첨부가 여전히 변경되지 않은 빈 값일 때만 database update가 성공하므로, 생성 대기 중 의도적으로 빈 값으로 저장한 경우를 포함해 사용자의 모든 편집이 우선하며 AI가 덮어쓸 수 없습니다. 추론에 실패하거나 비어 있거나 잘못된 결과를 반환해도 업로드는 성공하며, 사용자가 나중에 직접 ALT를 추가할 수 있도록 빈 값으로 유지됩니다.

Composer는 현재 작성 session에서 업로드해 AI ALT가 생성된 미디어에만 자동 생성 ALT가 부정확할 수 있으므로 검토해야 한다는 안내를 표시합니다. Article 이미지 Markdown에 AI 설명을 삽입한 경우도 포함합니다. 일반 ALT 편집기에서 검토 후 저장에 성공하거나 생성된 Article Markdown을 직접 수정하면 안내가 사라집니다. 기존 게시물을 편집하면서 불러온 첨부는 이번 session에서 새로 생성된 것으로 취급하지 않으므로 이 안내를 표시하지 않습니다.

기본 [Moondream 3.1](https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/) 어댑터는 비스트리밍 응답으로 caption task를 실행합니다. 추론에는 public media URL 대신 업로드 byte를 embed하므로 로컬 또는 private R2 object에서도 동작합니다. [LLaVA 1.5](https://developers.cloudflare.com/workers-ai/models/llava-1.5-7b-hf/)는 Beta 상태를 허용하는 운영자를 위한 호환 fallback 어댑터입니다. 기존 LLaVA 및 UForm byte-array 어댑터는 Moondream 경로의 애플리케이션 제한인 10 MiB와 달리 더 엄격한 4 MiB 추론 제한을 적용합니다.

## 모델 선택과 호환성

Cloudflare가 모델을 추가, 지원 중단 또는 교체할 수 있으므로 모델 ID를 환경변수로 관리합니다. 하지만 이 변수는 **임의 모델을 꽂는 플러그인 슬롯이 아닙니다**. 각 기능은 특정 요청과 응답 계약을 검증합니다. ID를 바꾸기 전에 해당 어댑터가 구현돼 있는지 확인하고 AI 활성 테스트와 타입 검사를 실행하세요.

| 기능 | 권장값 | 호환성 주의사항 |
| --- | --- | --- |
| 타임라인 | `@cf/baai/bge-m3` | 다국어 모델이며 예상한 `query` + `contexts` 랭킹 계약을 지원합니다. Embedding 전용 또는 생성형 모델은 어댑터 및 랭킹 변경 없이 교체할 수 없습니다. |
| 번역 | `@cf/meta/m2m100-1.2b` | 범용 번역 계약입니다. IndicTrans2는 English-to-Indic 전용이며 스키마가 다릅니다. |
| 이미지 ALT | `@cf/moondream/moondream3.1-9B-A2B` | 권장 caption 모델입니다. LLaVA 1.5는 byte-array 입력과 `description` 출력을 사용하는 Beta fallback입니다. |

[UForm Gen2](https://developers.cloudflare.com/workers-ai/models/uform-gen2-qwen-500m/)는 Image-to-Text 모델이지만 Cloudflare가 2026년 5월 30일자로 deprecated 처리했으므로 신규 배포에 권장하지 않습니다. [ResNet-50](https://developers.cloudflare.com/workers-ai/models/resnet-50/)은 자연어 caption이 아니라 이미지 분류 결과를 반환하므로 접근성 ALT 생성에 적합하지 않습니다.

## 프라이버시, 제한 및 비용

- 추천은 요청 사용자의 visibility 및 관계 검사를 통과한 후보 본문만 전송하지만, 홈 피드에 포함 가능한 비공개 범위 게시물도 들어갈 수 있습니다. 활동 profile은 팔로우한 태그와 공개 게시물에 관한 활동만 사용하고 비공개 게시물에 관한 활동은 제외합니다. 번역은 사용자가 볼 수 있는 게시물 본문을, ALT 생성은 업로드한 이미지를 전송합니다. 이러한 처리가 인스턴스 개인정보처리방침이나 사용자 기대 범위를 벗어난다면 기능을 켜지 마세요.
- SiliconBeest는 계정별 최신 공개 게시·리포스트·좋아요 추천 신호 30개를 활동 종류, 원본 게시물 ID, 발생 시각 형태로 D1에 저장합니다. 활동 table에 본문과 메타데이터를 복사하지 않고 관심사 query를 만들 때 현재 게시물 row에서 읽습니다. 후보 context와 모델 점수는 저장하지 않습니다. KV에는 공개 활동에서 파생한 5분짜리 pagination query와 상태만 들어갑니다. 생성 ALT는 미디어 메타데이터가 되므로 저장하지만, 번역 응답은 저장하지 않습니다.
- Cloudflare는 입력과 출력을 Customer Content로 취급하며 처리 방법을 [Workers AI 데이터 사용 문서](https://developers.cloudflare.com/workers-ai/platform/data-usage/)에 설명합니다. AI를 켜기 전에 이 문서와 각 모델 라이선스를 확인하세요.
- 후보 수, 본문 길이, 이미지 형식, ALT 길이는 애플리케이션에서 제한합니다. 모델에도 변경될 수 있는 context, payload, rate limit가 있습니다. 잘못되거나 너무 큰 요청은 기능에 따라 거부하거나 AI를 건너뛰며 권한 검사를 우회하지 않습니다.
- 유료 추론은 Cloudflare 네이티브 Rate Limiting 바인딩으로 보호합니다. 기본값은 로그인 계정별 60초마다 추천 page 요청 2회, 번역 요청 6회, 이미지 설명 자동 생성 4회이며 위 변수로 각 한도와 10초 또는 60초의 기간을 설정합니다.
- 실제 제한 정책은 생성된 Wrangler의 `ratelimits[].simple.limit`와 `ratelimits[].simple.period` 값만으로 결정합니다. 런타임 코드는 로그인 계정 ID를 key로 사용해 기능별 바인딩의 `limit()` 메서드만 호출합니다. 최초 추천 `POST`와 모든 cursor 연속 `POST`가 이 보호 장치를 소비하며, 추천 `GET`은 page를 생성하거나 가져오는 대신 거부합니다.
- 보호 장치가 추천 또는 번역 요청을 거부하면 `429`를 반환합니다. 활성화된 네이티브 보호 장치가 없거나 호출에 실패하면 이 동기 endpoint들은 fail-closed 방식으로 `503`을 반환합니다. ALT 자동 생성은 background에서 실행하므로 보호 장치를 사용할 수 없거나 거부되면 생성 상태만 실패로 바뀌고 이미지 업로드 자체는 계속 성공합니다.
- `WORKERS_AI_RATE_LIMITS=false`로 설정하면 네이티브 바인딩 세 개를 모두 제거하고 이 애플리케이션 수준의 추론 보호 장치를 우회하며, namespace ID도 필요하지 않습니다. 적절한 별도 비용 및 남용 방지 수단이 있을 때만 이 opt-out을 사용하세요.
- 네이티브 Rate Limiting은 best-effort 방식이며 Cloudflare location별로 동작하고 eventual consistency 특성이 있습니다. 일부 초과 요청을 허용할 수 있으므로 우발적이거나 악의적인 추론을 줄이는 장치이지 정확한 사용량 회계 또는 절대적인 지출 상한이 아닙니다. 비용 제어에는 Cloudflare billing control과 Dashboard monitoring을 함께 사용하세요.
- 성공하거나 시도된 각 추론은 Workers AI 할당량을 사용할 수 있습니다. 모델 요금과 무료 할당량은 바뀔 수 있으므로 저장소의 고정 추정치 대신 [현재 요금 문서](https://developers.cloudflare.com/workers-ai/platform/pricing/)와 Workers AI Dashboard를 확인하세요.

## 검증 매트릭스

배포 전에 각 생성 설정 모드를 검증합니다.

1. `WORKERS_AI_ENABLED=false`로 설정하고 `./scripts/sync-config.sh --apply`를 실행한 뒤 `siliconbeest/wrangler.jsonc`에 최상위 `ai` 및 `ratelimits` 블록이 없는지 확인합니다.
2. `siliconbeest`에서 `pnpm cf-typegen`, `pnpm exec tsc --noEmit -p tsconfig.worker.json`, `pnpm type-check`를 실행합니다.
3. `WORKERS_AI_ENABLED=true` 및 `WORKERS_AI_RATE_LIMITS=true`로 바꾸고 다시 생성한 뒤 메인 Worker에만 `ai.binding`이 `AI`, `ai.remote`가 `true`이며 설정한 `simple.limit` 및 `simple.period`를 가진 `ratelimits` 바인딩 세 개가 있는지 확인합니다.
4. `WORKERS_AI_ENABLED=true`를 유지하고 `WORKERS_AI_RATE_LIMITS=false`로 바꿔 다시 생성한 뒤 `AI` 바인딩은 유지되고 `ratelimits`는 없으며 namespace ID가 필요하지 않은지 확인합니다.
5. 양수가 아닌 한도, `10` 또는 `60`이 아닌 기간, 그리고 두 스위치가 모두 활성화된 경우 양수가 아니거나 중복된 namespace ID에서 설정 생성이 실패하는지 확인합니다.
6. 타입 생성, 타입 검사, 전체 테스트를 다시 실행합니다.

```bash
cd siliconbeest
pnpm cf-typegen
pnpm exec tsc --noEmit -p tsconfig.worker.json
pnpm type-check
pnpm test
```

생성 설정을 커밋하기 전에 `WORKERS_AI_ENABLED`를 실제 배포 모드로 되돌리세요. 저장소 기본값은 `false`입니다.
