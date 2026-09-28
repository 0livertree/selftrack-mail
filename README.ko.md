# SelfTrack Mail

**직접 운영하는 Gmail 메일 열람 추적 도구.** 크롬 확장 프로그램과 내 PC에서 돌리는 작은 Python 서버로 구성되어, 외부 추적 서비스가 내 메일을 볼 일이 없습니다.

[English README](README.md)

- Gmail **보낸편지함**과 열어본 메일에 ✓ / ✓✓ 열람 표시
- 수신자가 메일을 열면 데스크톱 알림
- 내가 내 보낸 메일을 본 것은 자동으로 제외
- 서버는 외부 패키지 없음 (Python 표준 라이브러리 + SQLite)
- Gmail, 네이버, 아웃룩 등 웹메일 수신자 모두 추적 (HTTPS 사용 시)

## 동작 방식

```
 Gmail (크롬)                                   수신자 메일 앱
  └─ 발송 시 확장이 1x1 픽셀 삽입 ──────────▶  https://<내 서버>/o/<id>.gif 요청
        │                                                   │
        │ 127.0.0.1:8787  (내부 API)                        ▼ :443 / :80  (공개)
        └────────────────▶  server/server.py  (SQLite)  ◀───┘
```

1. **보내기**를 누르면 확장이 무작위 ID가 담긴 보이지 않는 이미지를 본문에 넣고, 메일 정보(제목, 수신자)를 서버에 등록합니다.
2. 수신자가 메일을 열면 메일 앱이 그 이미지를 요청하고, 서버가 열람을 기록합니다.
3. 확장은 서버에서 기록을 가져와 Gmail에 표시하고 알림을 띄웁니다.

서버는 두 부분으로 나뉩니다. 픽셀만 응답하는 **공개** 리스너와, `127.0.0.1`에서 토큰이 있어야만 쓸 수 있는 **내부 API**입니다.

## 필요한 것

- 크롬 (또는 크로미움 기반 브라우저)
- Python 3.9 이상
- 인터넷에서 서버에 접속할 방법 (둘 중 하나)
  - **공인 IP**를 가진 PC (80/443 포트 접속 가능)
  - `cloudflared`, `ngrok` 같은 **터널**

## 시작하기

### 1. 서버 실행

```powershell
python server/server.py
```

처음 실행하면 토큰이 생성되어 출력됩니다. 토큰과 DB를 저장소 밖에 두려면 `MT_DATA_DIR`을 지정하세요.

```powershell
$env:MT_DATA_DIR = "C:\selftrack-data"; python server/server.py
```

### 2. 픽셀을 인터넷에 공개

#### 방법 A — 공인 IP + HTTPS (장기 사용 권장)

HTTPS가 중요합니다. 네이버, 아웃룩 웹처럼 브라우저가 이미지를 직접 불러오는 웹메일은 `https://` 페이지 안의 `http://` 이미지를 https로 바꿔 요청하기 때문에, 인증서가 없으면 실패합니다. HTTP만으로는 Gmail 수신자(Google 이미지 프록시 경유)만 추적됩니다.

Let's Encrypt는 IP 주소용 단기 인증서(약 6일)를 발급합니다. 서버가 `<MT_DATA_DIR>/acme`를 HTTP-01 webroot로 서빙하므로, 서버를 켠 채로 [lego](https://github.com/go-acme/lego)로 발급·갱신할 수 있습니다.

```powershell
# 80/443 인바운드를 Python에만 허용 (관리자 PowerShell, 최초 1회)
New-NetFirewallRule -DisplayName "SelfTrack Mail pixel" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow -Program "<python.exe 경로>"

# 공개 HTTP 리스너와 함께 서버 실행 (인증서 소유 확인에 필요)
$env:MT_DATA_DIR = "C:\selftrack-data"; $env:MT_PUBLIC_PORT = "80"
python server/server.py

# 다른 터미널에서 인증서 발급
lego run --accept-tos --domains <공인 IP> --profile shortlived --http --http.webroot C:\selftrack-data\acme --path C:\selftrack-data\lego

# HTTPS를 켜고 서버 재시작
$env:MT_HTTPS_PORT = "443"
$env:MT_CERT_FILE = "C:\selftrack-data\lego\certificates\<공인 IP>.crt"
$env:MT_KEY_FILE  = "C:\selftrack-data\lego\certificates\<공인 IP>.key"
python server/server.py
```

같은 `lego run` 명령을 하루 2번 실행하도록 예약하세요 (Windows 작업 스케줄러 / cron). lego는 갱신 시기가 됐을 때만 갱신하고, 서버는 재시작 없이 1분 안에 새 인증서를 사용합니다.

확장의 공개 URL에는 `https://<공인 IP>`를 입력합니다.

#### 방법 B — 터널 (공인 IP가 없을 때)

```powershell
cloudflared tunnel --url http://localhost:8787
```

출력되는 `https://xxxx.trycloudflare.com` 주소를 공개 URL로 사용합니다. 이 임시 주소는 **재시작할 때마다 바뀌고**, 이전 주소로 보낸 메일은 더 이상 추적되지 않습니다. 계속 쓰려면 고정 주소가 필요합니다 (본인 도메인 + Cloudflare Named Tunnel, 또는 ngrok 고정 도메인).

### 3. 확장 프로그램 설치

1. `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
2. **압축해제된 확장 프로그램 로드**를 누르고 `extension` 폴더를 선택합니다.
3. SelfTrack Mail 팝업을 열어 **공개 URL**과 **서버 토큰**을 입력하고 저장합니다.
4. Gmail을 새로고침합니다.

## 사용법

- 보내는 메일은 자동으로 추적됩니다 (팝업에서 끄고 켤 수 있음).
- **보낸편지함:** `✓` = 보냄, `✓✓ N` = N회 열람. 마우스를 올리면 처음/마지막 열람 시각이 보입니다.
- **메일 열기:** 본문 위에 열람 횟수와 마지막 열람 시각이 표시됩니다.
- **알림:** 30초 간격으로 확인합니다.
- **삭제:** 팝업에서 메일 하나(×) 또는 전체를 삭제할 수 있습니다. 삭제한 메일은 더 이상 추적되지 않습니다.

## 설정

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `MT_DATA_DIR` | `server/` | `config.json`(토큰), `mailtrack.db`, ACME webroot 위치 |
| `MT_HOST` / `MT_PORT` | `127.0.0.1` / `8787` | 내부 API 리스너 |
| `MT_PUBLIC_PORT` | 꺼짐 | 공개 HTTP 픽셀 리스너 (예: `80`) |
| `MT_HTTPS_PORT` | 꺼짐 | 공개 HTTPS 픽셀 리스너 (예: `443`) |
| `MT_CERT_FILE` / `MT_KEY_FILE` | — | HTTPS용 PEM 인증서(체인 포함)와 키 |

## 열람으로 인정하는 기준

| 규칙 | 이유 |
|---|---|
| 발송 후 10초 안의 요청은 무시 | 작성창 미리보기, 보낸 직후 Gmail 화면 표시 |
| *self-view*는 직전 30초의 Google 프록시 요청을 취소하고, 이후 30초를 차단 | Gmail에서 내 보낸 메일을 읽는 경우 (보낸 계정일 때만 적용) |
| 열람은 20초 뒤에 반영 | 알림이 뜨기 전에 self-view가 취소할 시간을 줌 |
| 같은 메일 + 같은 IP는 10초 안에 한 번만 저장 | 중복 로드 |
| 무시한 요청도 이유와 함께 보관 | 왜 기록되지 않았는지 나중에 확인 가능 |

## 보안

- API는 로컬 접속 + 올바른 토큰(시간차 공격에 안전한 비교)일 때만 응답하며, 터널을 거친 요청은 거부합니다.
- 공개 리스너는 픽셀, `/health`, ACME 확인만 응답하고 나머지는 404입니다.
- 남용 방지: 동시 연결 64개, 연결 타임아웃 10초, IP당 분당 120회, 요청 본문 64KB, User-Agent 길이 제한, Windows에서 포트 독점 사용.
- 모든 SQL은 파라미터 바인딩을 사용하고, 공개 리스너에서는 위조 가능한 IP 헤더를 무시하며, 로그의 제어문자를 제거합니다.
- 확장은 `textContent`로만 화면을 만듭니다 (`innerHTML` 미사용).
- `config.json`과 `mailtrack.db`는 **절대 커밋하지 마세요** (`.gitignore`에 포함되어 있음).

## 한계

- **같은 페이지에서 다시 연 것**은 대부분 집계되지 않습니다. 브라우저가 이미 불러온 이미지를 재사용하기 때문이며, Gmail 이미지 프록시도 캐시합니다.
- 이미지 표시를 꺼둔 수신자는 추적되지 않고, Apple Mail 개인정보 보호는 열지 않은 메일도 열람으로 기록할 수 있습니다.
- 서버가 꺼져 있는 동안의 열람은 기록되지 않습니다.
- 픽셀 주소가 메일 원문에 보이므로, 수신자는 서버 주소(공인 IP 방식에서는 내 IP)를 볼 수 있습니다.
- 보낸편지함 표시는 제목 + 수신자로 매칭하고, 메일 안의 표시는 픽셀 ID로 정확히 매칭합니다.
- Gmail 화면 구조(`.a3s`, `tr.zA`, `.bog`, `.aoO` 등)가 바뀌면 확장이 동작하지 않을 수 있습니다.
- 서버는 Python `http.server` 기반의 개인용 도구이며, 여러 사용자를 받는 운영 서비스용이 아닙니다.

## 개인정보와 책임 있는 사용

이 도구는 수신자가 메일을 연 시각과 IP 주소, User-Agent를 기록합니다. 나와 수신자에게 적용되는 개인정보 관련 법규를 확인하고 책임 있게 사용하세요.

## 라이선스

[MIT](LICENSE)
