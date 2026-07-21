# SiliconBeest 기여 가이드

SiliconBeest에 관심을 가져 주셔서 감사합니다. 오타 수정부터 버그 수정, 새 기능, 테스트와 문서 개선까지 모든 기여를 환영합니다.

이 저장소는 Cloudflare Workers 위에서 동작하는 ActivityPub 서버이자 Mastodon 호환 API와 Vue/Nuxt 프런트엔드를 함께 제공하는 모노레포입니다. 작은 변경도 인증, 공개 범위, 연합 전송에 영향을 줄 수 있으므로 관련 테스트를 함께 추가해 주세요.

For the English contributing guide, see [CONTRIBUTING.md](CONTRIBUTING.md).

## 시작하기 전에

- 버그나 기능 제안은 먼저 기존 이슈와 PR에 같은 내용이 있는지 확인해 주세요.
- 동작이나 호환성이 크게 달라지는 변경은 구현 전에 이슈에서 방향을 논의해 주세요.
- 한 PR에는 가능한 한 하나의 논리적 변경만 담아 주세요.
- API 키, 토큰, 비밀번호, 실제 사용자 데이터, `.env`, `.dev.vars`, `scripts/config.env`를 커밋하지 마세요.
- 공개 전에 조율이 필요한 보안 취약점은 공개 이슈에 재현 정보나 비밀 값을 올리지 말고 저장소 소유자에게 비공개로 알려 주세요.

## 개발 환경

필수 도구는 다음과 같습니다.

- Node.js `25+`
- pnpm `10.9.0`
- 로컬 Worker나 Cloudflare 리소스를 다룰 때 Wrangler `4.x`와 Cloudflare 계정

SiliconBeest를 개발하면서 테스트용 유료 Cloudflare Workers 환경이 필요하다면 [siliconsjang@gmail.com](mailto:siliconsjang@gmail.com)으로 요청해 주세요. **유료 플랜** 또는 **엔터프라이즈 플랜**의 Cloudflare Workers 환경을 제공해 드리겠습니다. 해당 환경에서 다른 서버와 Federation 테스트가 필요하다면 환경을 적절히 준비할 수 있도록 요청 메일에 그 필요성을 **반드시** 별도로 명시해 주세요.

저장소를 포크하고 의존성을 설치합니다.

```bash
git clone <your-fork-url>
cd siliconbeest
pnpm install --frozen-lockfile
git remote add upstream https://github.com/SJang1/siliconbeest.git
```

작업 브랜치는 최신 `main`에서 만드세요.

```bash
git fetch upstream
git switch main
git rebase upstream/main
git switch -c fix/short-description
```

## 저장소 구조

| 경로 | 역할 |
| --- | --- |
| `siliconbeest/` | Hono API Worker와 Vue/Nuxt 웹 앱 |
| `siliconbeest/server/worker/` | Mastodon API, 인증, ActivityPub, 서비스와 저장소 계층 |
| `siliconbeest/src/` | Vue 컴포넌트, 뷰, 스토어, 다국어 리소스 |
| `siliconbeest/migrations/` | Cloudflare D1 스키마 마이그레이션 |
| `siliconbeest-queue-consumer/` | 연합 전송, 타임라인 팬아웃, 알림 등의 비동기 작업 |
| `siliconbeest-email-sender/` | 이메일 큐 소비 및 SMTP 전송 |
| `packages/shared/` | 여러 Worker가 공유하는 타입과 유틸리티 |
| `scripts/` | 설치, 설정, 마이그레이션, 배포 및 운영 스크립트 |
| `docs/` | 아키텍처와 기능별 상세 문서 |

자세한 구조는 [루트 README](README.md)와 각 패키지의 README를 참고해 주세요.

## 로컬 실행

메인 앱을 실행합니다.

```bash
pnpm --filter siliconbeest-vue dev
```

큐 흐름이나 이메일 전송까지 확인하려면 별도 터미널에서 Worker를 실행합니다.

```bash
pnpm --filter siliconbeest-queue-consumer dev
pnpm --filter siliconbeest-email-sender dev
```

로컬 D1에 마이그레이션을 적용하려면 다음 명령을 사용합니다.

```bash
./scripts/migrate.sh --local
```

전체 Cloudflare 리소스를 만드는 `./scripts/setup.sh`는 일반적인 단위 테스트나 UI 작업에는 필요하지 않습니다. 로컬 Worker 간 Queue, D1, R2, KV 바인딩을 함께 검증할 때만 [배포 문서](docs/deploy/README.md)와 [스크립트 문서](scripts/README.md)를 따라 설정해 주세요.

## 변경 작성 원칙

### 코드와 타입

- 기존 파일의 형식과 설계를 따르고 TypeScript 타입을 명확히 유지해 주세요.
- `any`, 미처리 Promise, 매개변수 재할당, 불필요한 가변 상태를 피하세요. `siliconbeest/oxlint.config.ts`와 `siliconbeest/eslint.config.ts`가 서버 코드의 상세 규칙을 정의합니다.
- 비즈니스 로직은 가능한 한 서비스 계층에, 데이터 접근은 저장소 계층에 두세요.
- API 입력은 주변 엔드포인트와 같은 방식으로 검증하고, 오류 응답과 권한 검사를 빠뜨리지 마세요.
- 공유되는 메시지나 API 타입을 바꾸면 생산자, 소비자, `packages/shared/`의 정의가 서로 일치하는지 확인하세요.

### ActivityPub, 인증 및 권한

- 공개 범위(`public`, `unlisted`, `private`, `direct`)와 로컬·원격 계정의 차이를 모두 고려하세요.
- 연합 수신과 전송을 변경할 때 서명 검증, 대상 audience, 중복 처리, 재시도와 DLQ 동작을 보존하세요.
- 인증 엔드포인트에는 OAuth scope, 정지 계정, 관리자 권한과 객체 소유권 검사를 적용하세요.
- 외부 URL을 가져오는 코드는 SSRF 방어, 허용 프로토콜, 리디렉션, 크기 및 타임아웃 제한을 유지하세요.
- 권한이나 공개 범위를 고쳤다면 허용 사례와 거부 사례를 모두 테스트하세요.

### 데이터베이스 마이그레이션

- 스키마 변경은 `siliconbeest/migrations/`에 다음 순번의 SQL 파일로 추가하세요. 이미 배포된 마이그레이션은 수정하지 마세요.
- 파일명은 `NNNN_short_description.sql` 형식을 사용하세요.
- 기존 데이터가 있는 인스턴스에서 안전하게 적용되는지, 필요한 인덱스와 롤아웃 순서가 적절한지 확인하세요.
- PR 설명에 데이터 변환, 호환성 및 운영상 주의점을 적고 로컬에서 적용해 보세요.

```bash
./scripts/migrate.sh --local
```

### Cloudflare 바인딩과 생성 타입

`wrangler.jsonc`의 바인딩을 변경했다면 관련 Worker 타입을 다시 생성하고 생성된 선언 파일도 함께 검토하세요.

```bash
pnpm --filter siliconbeest-vue cf-typegen
pnpm --filter siliconbeest-queue-consumer cf-typegen
pnpm --filter siliconbeest-email-sender cf-typegen
```

개인 계정의 리소스 ID나 비밀 값이 생성 파일 또는 설정 파일에 들어가지 않았는지 커밋 전에 반드시 확인하세요.

### 프런트엔드와 번역

- 기존 컴포넌트와 [디자인 시스템](docs/design-system.md)을 재사용하고, 키보드 조작·포커스·색상 대비를 포함한 접근성을 확인하세요.
- 사용자에게 보이는 문자열은 기존 i18n 구조를 사용하세요. 번역을 모두 제공할 수 없다면 최소한 기본 영어 키가 누락되지 않도록 하세요.
- 반응형 레이아웃, 다크 모드와 RTL 언어에서의 동작을 고려하세요.

## 테스트와 품질 검사

변경 중에는 가장 가까운 테스트를 반복해서 실행하세요.

```bash
# 메인 웹 앱 테스트
pnpm --filter siliconbeest-vue test:vue

# 메인 API Worker 테스트
pnpm --filter siliconbeest-vue test:worker

# 큐 소비자 테스트
pnpm --filter siliconbeest-queue-consumer test
```

버그 수정에는 수정 전 실패하고 수정 후 통과하는 회귀 테스트를, 새 기능에는 정상·오류·권한 경계 테스트를 추가해 주세요. 테스트 파일은 관련 구현과 가까운 기존 `*.test.ts` 패턴을 따릅니다.

PR을 열기 전에는 저장소 루트에서 다음 검사를 실행하는 것을 권장합니다.

```bash
pnpm lint
pnpm test
pnpm --filter siliconbeest-vue type-check
pnpm build
```

Worker 타입에 직접 영향을 준 변경은 추가로 검사하세요.

```bash
pnpm --dir siliconbeest exec tsc --noEmit -p tsconfig.worker.json
pnpm --dir siliconbeest-queue-consumer exec tsc --noEmit
pnpm --dir siliconbeest-email-sender exec tsc --noEmit
```

문서만 변경했다면 전체 테스트 생략이 가능하지만, 링크와 명령 예제가 현재 구조와 일치하는지 확인해 주세요. 실행하지 못한 검사가 있다면 PR 설명에 이유를 적어 주세요.

## 커밋과 Pull Request

커밋 메시지는 변경의 목적이 드러나도록 짧고 구체적으로 작성하세요. 대규모 포맷 변경이나 관계없는 리팩터링을 기능 변경과 섞지 마세요.

PR은 `main` 브랜치를 대상으로 열고 다음 내용을 포함해 주세요.

- 무엇을 왜 변경했는지 설명
- 관련 이슈 링크
- 실행한 테스트와 결과
- UI 변경 전후의 스크린샷 또는 짧은 영상
- 마이그레이션, 새 바인딩, 환경 변수, 배포 순서가 있으면 운영 영향
- API 또는 연합 동작이 바뀌면 호환성과 보안 영향

제출 전 체크리스트:

- [ ] 변경 범위가 하나의 목적에 집중되어 있습니다.
- [ ] 관련 테스트를 추가하거나 갱신했습니다.
- [ ] lint, 테스트, 타입 검사와 빌드를 필요한 범위에서 실행했습니다.
- [ ] 사용자 대상 동작과 설정 변경을 문서화했습니다.
- [ ] 비밀 값, 개인 리소스 ID, 생성물 또는 디버그 로그를 포함하지 않았습니다.
- [ ] 새 의존성이 꼭 필요한지와 라이선스 영향을 확인했습니다.

동일 저장소에서 올라온 Draft가 아닌 PR에는 승인 후 미리보기 Worker가 만들어질 수 있습니다. 보안상 포크 PR에는 자동 미리보기가 실행되지 않으므로 로컬 검증 결과를 충분히 남겨 주세요.

## 라이선스

기여한 코드는 이 프로젝트와 동일한 [GNU Affero General Public License v3.0](LICENSE)에 따라 배포됩니다. 네트워크 서비스로 배포되는 수정 버전에도 AGPLv3의 소스 공개 의무가 적용됩니다.
