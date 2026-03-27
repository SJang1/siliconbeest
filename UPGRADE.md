# SiliconBeest 통합 배포 업그레이드 가이드

## 개요

커밋 `20b3dda` (custom emoji) 이후, Worker와 Vue가 하나의 Worker로 통합되었습니다.
기존 분리 배포(`siliconbeest-worker` + `siliconbeest-vue`)에서 통합 배포(`siliconbeest`)로 전환하는 가이드입니다.

## 변경 사항 요약

### 아키텍처 변경
| 이전 | 이후 |
|------|------|
| `siliconbeest-worker` (API, zone routes 14개) | 하나의 `siliconbeest` Worker |
| `siliconbeest-vue` (SPA, custom_domain) | (통합됨) |
| `API_WORKER` service binding | 직접 함수 호출 |
| `c.env.VAPID_PUBLIC_KEY` (env secret) | DB settings 조회 (`getVapidPublicKey()`) |

### 디렉토리 변경
```
이전:
  siliconbeest-worker/src/     → API 서버
  siliconbeest-vue/server/     → OG handler만

이후:
  siliconbeest/server/worker/   → API 서버 (이동됨)
  siliconbeest/server/index.ts  → 통합 entry point
  siliconbeest/migrations/      → D1 마이그레이션 (이동됨)
  siliconbeest/test/worker/     → Worker 테스트 (이동됨)
```

### wrangler.jsonc 변경
- `name`: `"siliconbeest-worker"` → `"siliconbeest"`
- `routes`: 14개 zone route 패턴 → 1개 `custom_domain`
- 모든 바인딩(D1, R2, KV, Queues, DO)이 `siliconbeest/wrangler.jsonc`에 통합
- `services` 블록 제거 (API_WORKER 불필요)

## 업그레이드 절차

### 1. 코드 업데이트
```bash
cd /path/to/siliconbeest
git pull origin main
```

### 2. 의존성 설치
```bash
cd siliconbeest
npm install
```

### 3. Secrets 설정 (새 Worker 이름이므로 필요)
```bash
cd siliconbeest

# OTP 암호화 키 (2FA용, 현재 미사용이면 더미 값 가능)
openssl rand -hex 32 | npx wrangler secret put OTP_ENCRYPTION_KEY
# 또는 기존 값이 있으면 그 값을 입력

# VAPID 키는 DB settings 테이블에서 조회하므로 env secret 불필요
```

### 4. 빌드 + 배포
```bash
cd siliconbeest
npm run build
npx wrangler deploy
```

> **다운타임 0**: custom_domain이 zone routes보다 우선하므로 배포 즉시 모든 트래픽이 새 Worker로 전환됩니다.

### 5. 정상 동작 확인
```bash
# API 확인
curl https://YOUR_DOMAIN/api/v1/instance

# SPA 확인
curl https://YOUR_DOMAIN/

# ActivityPub 확인
curl -H "Accept: application/activity+json" https://YOUR_DOMAIN/users/YOUR_USERNAME

# OG meta 확인 (크롤러 UA)
curl -A "Twitterbot/1.0" https://YOUR_DOMAIN/@YOUR_USERNAME
```

### 6. Queue Consumer 업데이트
```bash
cd siliconbeest-queue-consumer
# wrangler.jsonc의 services[0].service를 "siliconbeest"로 변경
npx wrangler deploy
```

### 7. 기존 Workers 삭제
```bash
# 기존 Vue Worker 삭제 (이전 아키텍처에서 사용)
npx wrangler delete -n siliconbeest-vue

# 기존 API Worker 삭제 (DO 세션 만료 후, 수 시간 대기)
npx wrangler delete -n siliconbeest-worker
```

## 롤백 절차

문제 발생 시:
1. 기존 `siliconbeest-worker`가 아직 존재하면 → zone routes가 여전히 유효
2. 새 `siliconbeest` Worker 삭제: `npx wrangler delete -n siliconbeest`
3. custom_domain이 해제되면 기존 `siliconbeest-vue`의 custom_domain + zone routes로 복원

## 주의사항

- **VAPID 키**: 이제 DB settings 테이블에서만 조회됩니다. Admin 설정 페이지에서 VAPID 키가 설정되어 있는지 확인하세요.
- **OTP_ENCRYPTION_KEY**: 현재 코드에서 사용하지 않지만, 향후 2FA 구현 시 필요합니다.
- **siliconbeest-worker/ 디렉토리**: 이전 아키텍처의 디렉토리입니다. 통합 후에는 삭제되었습니다.
- **Queue Consumer**: `WORKER` service binding이 새 Worker 이름(`siliconbeest`)을 가리키도록 반드시 업데이트하세요. 안 하면 Push 알림, 스트리밍이 안 됩니다.

## 새 환경에서 처음부터 배포 (Zero-State)

```bash
# 1. 리포지토리 클론
git clone https://github.com/SJang1/siliconbeest.git
cd siliconbeest

# 2. 설정
cp scripts/config.env.example scripts/config.env
# config.env 편집: 도메인, DB 이름 등

# 3. 인프라 생성 + 초기 배포
bash scripts/setup.sh

# 4. 관리자 계정 생성
bash scripts/seed-admin.sh

# 5. D1 마이그레이션
bash scripts/migrate.sh
```
