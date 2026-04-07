# SiliconBeest 인스턴스 배포 가이드

[English](README.md)

SiliconBeest는 **GitHub 템플릿 레포지토리**입니다. Cloudflare Workers 위에 자신만의 Fediverse 인스턴스를 배포하고, 자동 업스트림 업데이트를 받을 수 있습니다.

---

## 사전 요구사항

- **Workers Enabled** Cloudflare 계정
- Cloudflare에서 관리하는 도메인
- [Node.js](https://nodejs.org/) >= 20 (셋업 스크립트 실행용)

---

## 1단계. 레포지토리 생성

[github.com/SJang1/siliconbeest](https://github.com/SJang1/siliconbeest)에서 **"Use this template"** 버튼을 클릭하여 새 레포지토리를 생성합니다.

---

## 2단계. Cloudflare 리소스 생성

아래 명령어를 실행하여 필요한 모든 Cloudflare 리소스(D1, R2, KV, Queues)를 생성합니다:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/SJang1/siliconbeest/HEAD/scripts/install.sh)"
```

인스턴스 도메인, 제목 등을 입력하면 모든 리소스를 생성하고, 다음 단계에서 필요한 값을 출력합니다.

> [Cloudflare 대시보드](https://dash.cloudflare.com/)에서 직접 리소스를 생성할 수도 있습니다.

---

## 3단계. GitHub Secrets & Variables 설정

레포지토리 **Settings > Secrets and variables > Actions**에서 설정합니다.

### Secrets

| Secret | 설명 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Workers, D1, R2, KV, Queues 권한이 있는 Cloudflare API 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 계정 ID |

### Repository Variables

| 변수 | 설명 | 예시 |
|------|------|------|
| `PROJECT_PREFIX` | 리소스 이름 접두사 | `myinstance` |
| `INSTANCE_DOMAIN` | 인스턴스 도메인 | `social.example.com` |
| `INSTANCE_TITLE` | 인스턴스 표시 이름 | `내 페디버스 서버` |
| `REGISTRATION_MODE` | `open`, `approval`, `closed` 중 선택 | `open` |
| `D1_DATABASE_ID` | D1 데이터베이스 UUID | `7c66942d-...` |
| `KV_CACHE_ID` | 캐시용 KV 네임스페이스 ID | `14a4d29d...` |
| `KV_SESSIONS_ID` | 세션용 KV 네임스페이스 ID | `b28dd211...` |
| `KV_FEDIFY_ID` | Fedify용 KV 네임스페이스 ID | `cc8fbc2d...` |

### 선택 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `AUTO_DEPLOY` | `true` | `false`로 설정하면 main push 시 자동 배포 비활성화 |
| `AUTO_UPDATE_UPSTREAM_DEPLOY` | `true` | `false`로 설정하면 업스트림 코드만 동기화 (배포 안 함) |

---

## 4단계. 배포

**Actions > Deploy > Run workflow**를 실행하여 첫 배포를 트리거합니다.

워크플로우가 수행하는 작업:
1. GitHub Variables로부터 wrangler.jsonc 파일 생성
2. Vue 프론트엔드 빌드
3. D1 데이터베이스 마이그레이션 적용
4. 3개 워커 모두 배포 (메인, 큐 컨슈머, 이메일 센더)

---

## 5단계. Cloudflare 봇 보호 설정 (필수)

> **이 설정 없이는 연합(Federation)이 완전히 작동하지 않습니다.**

Cloudflare의 Bot Fight Mode가 ActivityPub 트래픽을 차단합니다 (`/users/*`, `/inbox`에 대해 403 응답). ActivityPub 콘텐츠 타입(`application/activity+json`, `application/ld+json`)을 사용하는 연합 엔드포인트 요청에 대해서만 봇 보호를 우회하는 WAF Skip 규칙을 **반드시** 생성해야 합니다.

전체 WAF 규칙 표현식과 설정 방법은 [scripts/README.md](../../scripts/README.md#cloudflare-bot-protection-critical)를 참고하세요.

---

## 자동 업스트림 업데이트

인스턴스에는 매일 00:00 UTC (한국시간 09:00)에 실행되는 워크플로우 (**Sync Upstream & Deploy**)가 포함되어 있습니다:

1. `SJang1/siliconbeest`에서 새 릴리즈 (git 태그) 확인
2. 업스트림 변경사항을 `main` 브랜치에 머지
3. 데이터베이스 마이그레이션 적용 및 모든 워커 배포

머지 충돌이 발생하면 배포 대신 **GitHub Issue**를 자동으로 생성하여 수동 해결 방법을 안내합니다.

수동으로 동기화를 트리거할 수도 있습니다:
**Actions > Sync Upstream & Deploy > Run workflow**에서 `force_deploy`를 활성화하세요.

---

## 문제 해결

### "No account id found"
GitHub Secrets에 `CLOUDFLARE_ACCOUNT_ID`를 설정하세요.

### "dist/client directory does not exist"
빌드 단계가 실패했습니다. 빌드 로그에서 TypeScript 또는 의존성 에러를 확인하세요.

### 업스트림 동기화 시 머지 충돌
워크플로우가 자동으로 GitHub Issue를 생성합니다. Issue의 안내에 따라 수동으로 해결하세요:

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git && cd YOUR_REPO
git remote add upstream https://github.com/SJang1/siliconbeest.git
git fetch upstream --tags
git merge upstream/main
# 충돌 해결 후:
git add -A && git commit
git push
```

### 연합(Federation)이 작동하지 않음 (403 에러)
Cloudflare WAF Skip 규칙 설정이 필요합니다. [5단계](#5단계-cloudflare-봇-보호-설정-필수)를 참고하세요.
