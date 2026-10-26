# NEXUS — 맥에서 시작하기

윈도 PC에서 돌던 시스템(문서 아카이브 + 검색 답변 + 보고서/PPT 작성)을 **이 폴더 하나**로 맥에 옮겨 실행합니다.
`data/MANIFEST.txt`에 내보낸 시점의 코드 버전과 데이터 개수가 적혀 있습니다.

> ⚠️ 이 설치 스크립트는 **맥에서 실제로 돌려 본 적이 없습니다**(개발·검증은 윈도 PC에서 했습니다).
> 막히는 단계의 메시지를 그대로 알려 주시면 고칩니다. 각 단계는 멱등이라 같은 명령을 다시 실행해도 안전합니다.

## 폴더 구성

| 경로 | 내용 |
|---|---|
| `app/` | 소스 코드(git 저장소, GitHub `jinnykim120/anything-llm` · 브랜치 `feat/archive-qa`) |
| `data/config/` | 설정 파일(`.env` 비밀키 포함!) · 사내 프록시 CA |
| `data/storage/` | SQLite DB · 업로드한 문서(원본 PDF + 파싱 결과) · 임베딩/리랭커 모델 |
| `data/pg/` | pgvector 벡터 DB 덤프(검색 인덱스) |
| `data/hf/` | Docling 모델 캐시(다시 내려받지 않도록) |
| `1-setup.sh` `2-start.sh` `3-verify.sh` | 설치 / 시작 / 점검 |

**보안:** `data/config`의 `.env`에는 비밀키가, `data/storage`에는 회사 문서가 들어 있습니다. USB/클라우드로 옮길 때 외부에 노출되지 않게 하세요.

## 준비물 (맥에서)

1. **Homebrew** — 없으면 먼저 설치: `https://brew.sh`
2. **인터넷 연결** — 첫 설치 때 Node 패키지(약 1GB) · Python 패키지(Torch 포함 약 1~2GB) · LibreOffice를 받습니다. 사내망이면 프록시 CA(`data/config/corp-root-ca.pem`)를 자동 적용하지만, 필요하면 키체인 접근에 CA를 먼저 등록하세요.
3. **Claude CLI** — 답변·보고서 생성에 필요: `npm install -g @anthropic-ai/claude-code` 후 터미널에서 `claude`를 한 번 실행해 로그인
4. 여유 디스크 약 **15GB** (이 폴더 약 6GB + 설치물)

## 순서

```bash
# 1) 이 폴더를 맥으로 복사 (예: ~/NEXUS-Mac-Package). 터미널에서 이동
cd ~/NEXUS-Mac-Package

# 2) 설치 + 데이터 가져오기 + 실행  (처음 20~40분)
bash 1-setup.sh

# 3) 브라우저에서 http://localhost:3000/  (비밀번호 없음)

# 4) 점검
bash 3-verify.sh --llm
```

평소 시작은 `bash 2-start.sh`입니다.

`1-setup.sh`가 하는 일: Homebrew로 Node 24 · PostgreSQL 17 · pgvector · Python 3.12 · LibreOffice 설치 → `yarn install` → Python 가상환경(Docling·통계분석·한글 변환) → 설정/문서/모델 복사 → 벡터 DB 복원 → **윈도 경로(`\`)를 맥 경로(`/`)로 변환** → 서비스 시작.

## 매일 쓰는 명령 (폴더 안에서)

| 하고 싶은 것 | 명령 |
|---|---|
| 시작 / 내리기 | `bash 2-start.sh` / `bash app/stop-local.sh` |
| Docling 켜기 / 끄기 | 화면의 버튼 또는 `bash app/start-docling.sh` / `bash app/stop-docling.sh` |
| 로그인 시 자동 시작 + 5분마다 자동 복구 | `bash app/scripts/mac/install-launchagent.sh` |
| 자동 복구 잠시 멈춤 / 다시 켜기 | `... install-launchagent.sh --pause` / `--resume` |
| 로그 | `app/.local-cache/server.run.log` · `collector.run.log` · `frontend.run.log` |

## 맥에서 달라지는 점 / 주의

- **Docling은 필요할 때만 켜세요.** 적재할 때만 켜고 끝나면 끕니다(30분 사용 없으면 자동 종료). 16GB 램에서는 서버·DB와 함께 켜면 빠듯합니다. 애플 실리콘 GPU(MPS)로 빨라질 수 있지만 **측정해 보지 않았습니다.** 표 인식이 깨지거나 오류가 나면 `NEXUS_DOCLING_DEVICE=cpu bash app/start-docling.sh`로 시험하세요. 스레드/배치는 `NEXUS_DOCLING_THREADS`, `NEXUS_DOCLING_BATCH`(기본 2)로 조절합니다.
- **절전:** `install-launchagent.sh`가 전원 연결 중 잠자기를 막는 `caffeinate`도 같이 설치합니다. **덮개를 닫으면(외장 모니터 없이) 맥은 잠자기에 들어가 서비스가 멈춥니다.** 서버로 돌릴 때는 덮개를 열어 두세요. 에어는 팬이 없어 장시간 최대 부하(큰 PDF의 Docling 처리)에서 느려질 수 있습니다.
- **한글 파일명:** 맥은 한글을 분해형(NFD)으로 저장하는 경우가 있습니다. 이 폴더는 그대로 복사해 쓰면 문제없지만, 압축/클라우드 동기화 도구가 이름을 바꾸면 문서 파일을 못 찾을 수 있습니다. `bash 3-verify.sh`가 "문서 경로 → 파일 확인"으로 알려 줍니다.
- **첫 PPT→PDF 변환/HWP 변환** 때 macOS가 LibreOffice 실행 허용을 물을 수 있습니다(허용).
- **Windows PC와 동시에 같은 데이터를 쓰지 마세요.** 이 패키지는 내보낸 시점의 **복사본**입니다. 두 곳에서 따로 문서를 올리면 서로 합쳐지지 않습니다.

## 막혔을 때

- `bash 3-verify.sh` 의 FAIL 항목부터 확인합니다.
- 서버가 안 뜨면 `app/.local-cache/server.run.log` 마지막 줄을 확인합니다.
- 검색이 "문서가 없다"고만 하면 Postgres를 확인합니다: `brew services list` → `postgresql@17`이 started인지.
- 설치를 처음부터 다시: `bash 1-setup.sh` (이미 된 단계는 건너뜁니다). 데이터를 다시 덮어쓰려면 `bash 1-setup.sh --force-data`.

## 맥 환경에서 확인되지 않은 것 (정직한 목록)

- 설치 스크립트 전체(Homebrew 포뮬러 이름·버전, pgvector가 PostgreSQL 17과 맞는지)
- 고정 버전 Python 패키지가 맥 휠로 설치되는지(안 되면 버전 제한 없는 목록으로 자동 재시도)
- Docling의 맥(MPS) 동작·속도, 메모리 사용
- Apple Silicon에서 `claude` CLI 로그인과 모델 `claude-sonnet-5-5` 사용 가능 여부(윈도 PC에서는 정상)
- 로그인 시 자동 시작(LaunchAgent)
