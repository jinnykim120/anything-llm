# NEXUS — 다른 윈도우 PC에서 시작하기

원본 윈도우 PC에서 돌던 시스템(문서 아카이브 + 검색 답변 + 보고서/PPT 작성)을 **이 폴더 하나**로 다른 윈도우 PC에 옮겨 실행합니다.
`data\MANIFEST.txt`에 내보낸 시점의 코드 버전과 데이터 개수가 적혀 있습니다.

> ⚠️ 설치 스크립트는 **깨끗한 다른 PC에서 실제로 돌려 본 적이 없습니다**(원본 PC에서 일부 구성요소만 검증).
> 막히는 단계의 메시지를 그대로 알려 주세요. 각 단계는 멱등이라 같은 명령을 다시 실행해도 안전합니다.

## 폴더 구성

| 경로 | 내용 |
|---|---|
| `app\` | 소스 코드(git 저장소, GitHub `jinnykim120/anything-llm` · 브랜치 `feat/archive-qa`) |
| `data\config\` | 설정 파일(`.env` 비밀키 포함!) · 사내 프록시 CA |
| `data\storage\` | SQLite DB · 업로드한 문서(원본 PDF + 파싱 결과) · 임베딩/리랭커 모델 |
| `data\wsl\` | **pgvector Postgres 가 든 WSL 배포판**(검색 인덱스 포함, 약 3GB) — 그대로 가져와 같은 상태로 복원 |
| `data\pg\` | 벡터 DB 덤프(배포판을 못 쓸 때의 대체 수단) |
| `data\hf\` | Docling 모델 캐시(다시 내려받지 않도록) |
| `1-setup.cmd` `2-start.cmd` `3-verify.cmd` | 설치 / 시작 / 점검 |

**보안:** `data\config`의 `.env`에는 비밀키가, `data\storage`·`data\wsl`에는 회사 문서와 검색 인덱스가 들어 있습니다. USB/클라우드로 옮길 때 외부에 노출되지 않게 하세요.

## 준비물

1. **Windows 10 (2004 이상) 또는 11**, 여유 디스크 **약 25GB**(이 폴더 약 9GB + 설치물), 램 **16GB 권장**
2. **WSL2를 켤 수 있는 PC** — BIOS에서 가상화가 켜져 있어야 합니다. WSL이 아직 없으면 설치 스크립트가 켜 주지만 **관리자 권한과 재부팅 1회**가 필요합니다.
3. **인터넷** — 첫 설치 때 Node 패키지(약 1GB) · Python 패키지(Torch 포함 약 2GB) · 도구(winget)를 받습니다. 사내망이면 프록시 CA(`data\config\corp-root-ca.pem`)를 자동 적용합니다.
4. **Claude CLI** — 답변·보고서 생성에 필요: `npm install -g @anthropic-ai/claude-code` 후 터미널에서 `claude`를 한 번 실행해 로그인

## 순서

```text
1) 이 폴더를 새 PC로 복사 (예: D:\NEXUS). 경로에 한글/공백이 있어도 되지만 짧을수록 좋습니다.
2) 1-setup.cmd 를 더블클릭 (관리자 권한 PowerShell 에서 실행하면 WSL 도 자동으로 켭니다)
   - 처음 20~40분. "WSL 을 설치했으니 재부팅" 이 나오면 재부팅 후 1-setup.cmd 를 다시 실행
3) 브라우저에서 http://localhost:3000/   (비밀번호 없음)
4) 3-verify.cmd -Llm   (점검 + claude 응답 확인)
```

평소 시작은 `2-start.cmd`입니다.

`1-setup.cmd`가 하는 일: winget 으로 Node.js LTS · Python 3.12 · Git · LibreOffice 설치 → **WSL 배포판 `AutoDocu-Postgres`(pgvector) 가져오기** → 설정/문서/모델 복사 → `yarn install` → Python 가상환경(Docling·통계분석·한글 변환) → 서비스 시작.

## 매일 쓰는 명령 (`app` 폴더 안에서 PowerShell)

| 하고 싶은 것 | 명령 |
|---|---|
| 시작 | `2-start.cmd` 또는 `.\app\run-local.ps1` |
| Docling 켜기 / 끄기 | 화면의 버튼 또는 `.\app\start-docling.ps1` / `.\app\stop-docling.ps1` |
| 로그인 시 자동 시작 + 5분마다 자동 복구 | `app\scripts\windows\install-autostart.ps1` (`-Pause` · `-Resume` · `-Remove`) |
| 로그 | `app\.local-cache\server.run.log` · `collector.run.log` · `frontend.run.log` |

## 주의

- **Docling은 필요할 때만 켜세요.** 적재할 때만 켜고 끝나면 끕니다(30분 사용 없으면 자동 종료). 16GB 램에서는 서버·DB와 함께 켜면 빠듯합니다. 큰 PDF는 시간이 오래 걸립니다(594쪽에 약 2시간 20분이 걸린 적이 있음).
- **원본 PC와 같은 데이터를 동시에 쓰지 마세요.** 이 패키지는 내보낸 시점의 **복사본**입니다. 두 PC에서 따로 문서를 올리면 서로 합쳐지지 않습니다. 내보낸 뒤에 원본 PC에서 올린 문서는 포함돼 있지 않습니다.
- **WSL 메모리:** WSL이 메모리를 많이 잡을 수 있습니다. `%UserProfile%\.wslconfig`에 `[wsl2]` + `autoMemoryReclaim=gradual`을 넣으면 쉬는 동안 돌려줍니다(설정 후 `wsl --shutdown` 필요, 이 때 Postgres 도 내려가므로 `2-start.cmd`로 다시 올리세요).
- **절전:** 노트북이면 전원 연결 시 절전 안 함 / 덮개 닫아도 유지로 두세요. 절전에 들어가면 서비스가 멈춥니다.
- **서버 대기 한도:** 서버가 문서 처리 결과를 기다리는 한도가 60분입니다. 아주 큰 문서(수백 쪽을 Docling으로)는 화면에서 실패로 보일 수 있습니다.

## 막혔을 때

- `3-verify.cmd`의 FAIL 항목부터 확인합니다.
- 서버가 안 뜨면 `app\.local-cache\server.run.log` 마지막 줄을 확인합니다.
- 검색이 "문서가 없다"고만 하면 Postgres 를 확인합니다: `wsl -d AutoDocu-Postgres -- pg_isready` 가 "accepting connections"인지. 아니면 `2-start.cmd`를 다시 실행합니다.
- 설치를 처음부터 다시: `1-setup.cmd` (이미 된 단계는 건너뜁니다). 데이터를 다시 덮어쓰려면 `1-setup.cmd -ForceData`.
- WSL 배포판을 가져오지 못할 때: `data\pg\anythingllm_vectors.sql.gz`(PostgreSQL 16 + pgvector 덤프)를 직접 복원하거나, 문서함에서 워크스페이스를 다시 임베딩하세요(시간이 오래 걸림).

## 확인되지 않은 것 (정직한 목록)

- 깨끗한 PC에서의 설치 전 과정(winget 패키지 ID, WSL 신규 설치 후 재개 흐름)
- 다른 PC의 하드웨어(CPU/램)에서의 Docling 속도·메모리
- `wsl --import`로 가져온 배포판의 Postgres 자동 시작 — 원본 PC에서 같은 방식으로 시험해 확인했지만 다른 PC에서는 미확인
- 자동 시작(`install-autostart.ps1`)은 원본 PC에서 만든 방식과 같지만 다른 PC에서는 미확인
