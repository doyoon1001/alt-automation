# Alt Automation - 웹훅 & 폴링 자동화

Alt 녹음 완료 시 → Notion 요약 저장 → Discord/Slack 알림 자동화

## 📁 파일 구조

```
alt-automation/
├── .env                    # 환경 변수 (API 키, 시크릿 등)
├── alt-webhook.js          # 웹훅 수신 서버 (Express)
├── alt-poller.js           # 폴링 방식 워커 (백업용)
├── hermes-bridge.js        # Hermes CLI 래퍼 (Discord/Slack 전송)
├── notion.js               # Notion API 연동
├── package.json            # 의존성
└── README.md               # 이 파일
```

## 🚀 실행 방법

### 1. 의존성 설치
```bash
cd /Users/kimdoyoon/alt-automation
npm install
```

### 2. 환경 변수 설정 (.env)
```env
ALT_API_KEY=alt_live_...
ALT_WEBHOOK_SECRET=whsec_...
NOTION_TOKEN=ntn_...
NOTION_DATABASE_ID=...
```

### 3. 웹훅 서버 실행 (메인)
```bash
# Cloudflare Tunnel로 외부 접근 가능하게 하기
cloudflared tunnel --url http://localhost:3000

# 웹훅 서버 실행
node -r dotenv/config alt-webhook.js
```

### 4. 폴링 워커 실행 (백업/보조)
```bash
node -r dotenv/config alt-poller.js
```

## 🔧 주요 설정

### 웹훅 엔드포인트
- **URL**: `https://<your-tunnel>.trycloudflare.com/webhooks/alt`
- **이벤트**: `note.ended`, `note.summary.generated`, `note.updated`, `note.deleted`
- **시크릿**: `.env`의 `ALT_WEBHOOK_SECRET`

### Alt API
- **Base URL**: `https://public-api.altalt.io/v1`
- **인증**: `Authorization: Bearer <ALT_API_KEY>`
- **엔드포인트**:
  - `GET /notes` - 노트 목록
  - `GET /notes/{id}/transcript` - 트랜스크립트
  - `GET /notes/{id}/summary` - 요약
  - `GET /webhook-endpoints` - 웹훅 관리

## 🔄 플로우

```
Alt 녹음 완료
    │
    ▼
┌─────────────────────────────────┐
│  웹훅 (note.ended)              │
│  또는 폴링 (1분마다)             │
└─────────────────────────────────┘
    │
    ▼
Hermes CLI로 요약 생성 (hermes -z)
    │
    ▼
Notion 데이터베이스에 페이지 생성
    │
    ▼
Discord 채널에 링크 공유 (hermes send --to discord)
    │
    ▼
Slack 채널에 완료 알림 (hermes send --to slack)
```

## 🛠️ 트러블슈팅

### 웹훅이 안 올 때
1. Cloudflare Tunnel이 실행 중인지 확인
2. Alt 대시보드에서 웹훅 상태가 `active`인지 확인
3. API 키와 워크스페이스가 일치하는지 확인
4. `note.ended` 이벤트가 체크되어 있는지 확인

### Notion 연동 안 될 때
1. Integration이 데이터베이스에 연결되었는지 확인 (데이터베이스 → ... → Add connections)
2. `.env`의 `NOTION_DATABASE_ID`가 정확한지 확인 (하이픈 포함)

### Discord/Slack 안 갈 때
1. `hermes status`로 설정 확인
2. `hermes setup`으로 Discord/Slack 연동
3. `~/.hermes/config.yaml` 확인

## 📝 주요 명령어

```bash
# 웹훅 서버 재시작
kill $(lsof -ti:3000) 2>/dev/null
node -r dotenv/config alt-webhook.js &

# Cloudflare Tunnel 재시작
kill $(pgrep cloudflared) 2>/dev/null
cloudflared tunnel --url http://localhost:3000

# 웹훅 URL 업데이트
node -e "
const axios = require('axios');
const key = process.env.ALT_API_KEY;
axios.patch('https://public-api.altalt.io/v1/webhook-endpoints/b2b5ccf9-6af0-48cd-ac5f-2daa8d89f01e', {
  url: 'https://<new-tunnel>.trycloudflare.com/webhooks/alt'
}, { headers: { Authorization: 'Bearer ' + key } });
"

# 웹훅 테스트
node -e "
const axios = require('axios');
const key = process.env.ALT_API_KEY;
axios.post('https://public-api.altalt.io/v1/webhook-endpoints/b2b5ccf9-6af0-48cd-ac5f-2daa8d89f01e/test', {}, {
  headers: { Authorization: 'Bearer ' + key }
});
"
```

## 📌 참고
- Cloudflare Quick Tunnel은 재시작할 때마다 URL이 바뀜
- 영구 URL이 필요하면 Named Tunnel 설정 필요
- Alt API 키는 해당 워크스페이스/계정의 녹음만 볼 수 있음