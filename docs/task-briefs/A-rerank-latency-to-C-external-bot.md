# 작업 지시서: A(rerank 성능 개선) → C(P5 외부 봇 배포)

이 문서는 다른 모델/작업자가 이어서 그대로 진행할 수 있도록 작성한 순차 작업 지시서입니다.
각 단계는 "지금 상태 → 할 일 → 확인 방법 → 완료 기준"으로 구성되어 있습니다.
**결정이 필요한 지점은 굵게 표시된 질문으로 명시**했으니, 그 지점에서는 반드시 사용자에게 먼저 확인을 받고 진행하세요.

## 사전 준비 (매 세션 공통, 5분)

```powershell
cd "D:\ai factory\auto docu\anything-llm"
git status --short          # 워크트리가 깨끗해야 시작
git log --oneline -5        # 최신 커밋이 d9c40821 이후인지 확인
```

서버가 켜져 있는지 확인:

```powershell
Invoke-WebRequest "http://127.0.0.1:3001/api/ping" -UseBasicParsing -TimeoutSec 5
```

`200`이 아니면:

```powershell
powershell -File "D:\ai factory\auto docu\anything-llm\run-local.ps1"
```

이 스크립트가 server(3001)/frontend(3000)/collector(8888)와 WSL2 Postgres(pgvector)를 자동 기동합니다.
docling-serve는 수동 모드이므로 이번 작업에는 필요 없습니다(문서 파싱 관련 작업이 아님).

여유 메모리 확인(dense 검색이 lexical fallback으로 떨어지는지 판단):

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory
```

`1600MB(=FreePhysicalMemory 약 1,600,000 KB)` 미만이면 서버 로그에서
`Insufficient free memory`가 찍히는지 확인하세요. 찍히면 A단계의 latency 측정이 무의미해집니다
(lexical fallback은 dense보다 다른 특성을 가짐). 필요하면 다른 무거운 프로그램을 닫고 재시도하세요.

---

## A단계 — rerank 성능 추가 개선

### A-0. 지금 상태 (배경, 읽기만)

방금 전 세션에서 `RERANKER_CANDIDATE_LIMIT`을 도입해 rerank 후보 수를 최대 50개에서 10개로 제한했습니다.
결과:

| 설정 | archive-full(232문서) rerank 평균 지연 | 정확도(MRR) |
|---|---|---|
| 후보 상한 없음(기존, 최대 50) | 관측치 없음(더 느렸을 것으로 추정) | - |
| 후보 상한 16 | 약 15.6초 | 1.000 |
| **후보 상한 10 (현재 기본값)** | **약 7.6초** | **1.000** |

관련 코드: `server/utils/vectorDbProviders/pgvector/index.js`의 `PGVector.rerankCandidateLimit()`, `rerankedSimilarityResponse()`.
관련 리랭커: `server/utils/EmbeddingRerankers/native/index.js` (`NativeEmbeddingReranker`), 모델은
`onnx-community/bge-reranker-v2-m3-ONNX` (568MB, CPU ONNX 추론).

**결론(이미 확정됨)**: 후보를 더 줄이는 것은 안전 하한(10)에 걸려 있어 더 이상 못 줄입니다.
지금 병목은 "CPU에서 ONNX 크로스인코더 추론 자체가 느림"입니다.

### A-1. 할 일

다음 두 방향 중 하나(또는 순차적으로 둘 다)를 진행합니다.

**방향 1: 더 작은/양자화된 리랭커 모델로 교체**

- `server/utils/EmbeddingRerankers/native/index.js`의 `NativeEmbeddingReranker.defaultModel`
  (`onnx-community/bge-reranker-v2-m3-ONNX`, 568MB)을 더 작은 한국어 지원 모델로 교체 검토.
  후보 예시(직접 다운로드 가능 여부와 HF 라이선스를 먼저 확인할 것):
  - 더 작은 XLM-R 계열 cross-encoder
  - 기존 모델의 int8/quantized 버전이 HF에 있는지 확인
- 교체는 `.env`의 `RERANKER_MODEL_PREF`로 오버라이드 가능하므로, 기본값을 바꾸기 전에
  로컬에서 `RERANKER_MODEL_PREF`로 먼저 실험할 것.

**방향 2: 배치/워커 튜닝**

- `RERANKER_MAX_BATCH_SIZE`(현재 `2`, `server/.env.development`)를 올려서 오히려 빨라지는지 테스트.
  주의: 배치를 올리면 피크 메모리가 늘어남 — `RERANKER_MIN_FREE_MEMORY_MB`(현재 1600)와 충돌 가능성 확인.
- Node의 `onnxruntime-node`가 스레드를 몇 개 쓰는지 확인하고, 필요하면 환경변수로 스레드 수 조정
  (`@xenova/transformers`가 내부적으로 쓰는 onnxruntime 옵션 확인 필요, 코드베이스에 아직 노출 안 됨).

### ❓ 결정 필요 지점 1

> 방향 1(모델 교체)과 방향 2(배치 튜닝) 중 어느 쪽을 먼저 시도할지, 혹은 둘 다 시도한 뒤 더 나은 쪽을 채택할지
> 사용자에게 먼저 확인하세요. 모델 교체는 재검증(전체 회귀 스위트) 시간이 더 걸립니다.

### A-2. 검증 방법 (모델/배치를 바꾼 뒤 반드시 실행)

```powershell
cd "D:\ai factory\auto docu\anything-llm"
node eval/run.mjs --keep --mode rerank        # 검색 정확도 회귀 (MRR, hit@k)
node eval/answers.mjs                          # 답변 품질 회귀 (8문항, judge=claudecli)
node eval/perf.mjs --mode rerank --repeat 2    # archive-full 232문서 대상 지연 재측정
```

서버 로그에서 실제 리랭킹 지연을 확인:

```powershell
Get-Content "D:\ai factory\auto docu\anything-llm\.local-cache\server.run.log" -Tail 60 |
  Select-String -Pattern "Reranking .* documents"
```

### A-3. 완료 기준

- `eval/run.mjs --mode rerank` MRR이 기존 `1.000`에서 떨어지지 않음 (허용 하한: `0.94` 이상 — default 모드 기준선)
- `eval/answers.mjs` 8/8 통과 유지
- archive-full rerank 평균 지연이 기존 `~7.6초`보다 개선됨 (목표: 3초 이하, 최소한 개선이 없다면 "개선 안 됨"을 문서에 명시하고 A단계 종료)
- 결과를 `eval/FINDINGS.md`(맨 위에 새 섹션 추가, 기존 "2026-09-07 — rerank candidate cap" 섹션 형식을 참고)와
  `docs/architecture-v12.html`의 §08(구현 현황)·§10(리스크)에 반영

### A-4. 이 단계 스킵 조건

방향 1/2를 모두 시도해도 개선이 없거나 위험(정확도 저하)이 크면, "CPU 리랭킹은 현재 하드웨어의 근본적 한계"로
결론짓고 A단계를 종료해도 됩니다. 이 경우 `eval/FINDINGS.md`에 "시도했으나 개선 안 됨" 기록을 남기고 B단계로 넘어가지 말고
바로 C단계(P5)로 진행하세요.

---

## C단계 — P5 외부 봇 배포

## A단계 실행 결과 (2026-09-07)

The batch-size experiment was completed before starting P5. The current
runtime was restored to `RERANKER_MAX_BATCH_SIZE="2"` because larger batches did
not improve latency on this CPU host.

| batch size | archive-full average | p95/max | retrieval MRR | answer quality |
|------------|----------------------|---------|---------------|----------------|
| 2 | 9,528 ms | 14,300 ms | 1.000 | 8/8 passed |
| 4 | 10,521 ms | 16,096 ms | 1.000 | 8/8 passed |
| 6 | 10,850 ms | 20,112 ms | 1.000 | 8/8 passed |

Conclusion: the bottleneck is ONNX model inference, not only the number of
inference batches. Do not raise the batch size on this machine. Continue to C
with batch size 2, candidate cap 10, and rerank as an optional precision mode.
Further A work requires a smaller/quantized Transformers.js-compatible model or
a separate inference service; do not replace the validated BGE reranker without
running the full retrieval, answer, and latency regression suite.

### C-0. 지금 상태 (배경, 읽기만)

- `anythingllm-embed`는 이 리포지토리에 **git submodule**로 등록되어 있으나 **초기화되지 않은 상태**입니다.
  ```powershell
  git submodule status
  # 출력 예: -7e5c6afc0266a536dfeeae10b73747461b31ca44 embed
  #          맨 앞의 '-'가 "체크아웃 안 됨"을 의미
  ```
- 서버 쪽 embed 관리 API는 이미 구현되어 있습니다:
  - `server/endpoints/embedManagement.js` — 내부 관리 API (`/embeds`, `/embed/new`, `/embed/update/:id` 등)
  - `server/endpoints/api/embed/index.js` — 외부 공개 API (`/v1/embed/*`, API 키 인증)
  - `server/models/embedConfig.js` — embed 설정 모델, `parseAllowedHosts()`로 도메인 화이트리스트 관리
  - `server/utils/middleware/embedMiddleware.js` — origin 검증 미들웨어
  - `EMBED_REQUIRE_ALLOWLIST` 환경변수(`server/.env.example:583`) — 화이트리스트 미설정 시 전체 origin 허용을 막는 하드닝 옵션. 기본은 미설정(전체 허용).
- `anythingllm-mobile`은 이 리포지토리에 서브모듈로도 없고, 별도 레포입니다. 이번 작업 범위에서는 **모바일 앱은 제외**하고
  웹 임베드 위젯 + 외부 접속(터널)까지만 다룹니다. (문서상 "P5"는 이 두 가지를 함께 묶어놨지만, 모바일 앱은 별도 프로젝트로
  분리하는 게 합리적입니다 — 아래 결정 지점 참고.)
- `cloudflared`는 이 머신에 설치되어 있지 않습니다 (`where.exe cloudflared` 결과 없음).

### ❓ 결정 필요 지점 2 (반드시 시작 전에 확인)

> P5를 "웹 임베드 위젯 빌드 + Cloudflare Tunnel로 외부 노출"까지만 이번에 하고, `anythingllm-mobile`은
> 완전히 별도 작업으로 분리해도 괜찮은지 사용자에게 확인하세요. (권장: 분리. 모바일은 별도 레포·별도 빌드체인이라
> 이번 작업 범위에 넣으면 지시서가 너무 커집니다.)

### ❓ 결정 필요 지점 3 (보안 정책 — 반드시 코드 작성 전에 확인)

> 외부에서 접근 가능한 채팅 위젯을 열 때, 다음 중 어떤 보안 수준으로 시작할지 확인하세요.
>
> - **옵션 1 (가장 안전, 권장 시작점)**: `EMBED_REQUIRE_ALLOWLIST="true"`로 설정하고, 위젯을 실제로 심을 도메인만
>   화이트리스트에 등록. 익명 접근은 허용하되 origin은 제한.
> - **옵션 2**: 화이트리스트 없이 전체 공개(누구나 어떤 사이트에든 심을 수 있음). 빠르지만 위험.
> - 또한 **rate-limit**을 넣을지(현재 코드베이스에 embed 전용 rate-limit이 있는지 아래 C-1에서 먼저 확인 필요),
>   민감 워크스페이스는 절대 embed 대상으로 만들지 않는다는 원칙을 어떻게 강제할지(수동 체크리스트 vs 코드 가드)도
>   같이 확인하세요.

### C-1. 조사 단계 (코드 작성 전 필수)

아직 실제로 구현되어 있는지 확인되지 않은 것들을 먼저 점검합니다. 다음 파일들을 읽고 각 항목을 표로 기록하세요.

```powershell
# rate-limit 관련 코드가 있는지 확인
grep -rn "rate.?limit" server/utils/middleware/ server/endpoints/api/embed/
grep -rn "rate.?limit" server/endpoints/embedManagement.js

# EMBED_ 관련 전체 환경변수 목록 확인
grep -n "EMBED_" server/.env.example server/utils/helpers/updateENV.js
```

프론트엔드에서 embed 위젯 설정 화면이 이미 있는지 확인:

```powershell
# GeneralSettings 아래에 embed 관련 화면이 있는지
Get-ChildItem "frontend/src/pages/GeneralSettings" -Recurse -Filter "*mbed*"
```

이 조사 결과를 바탕으로 "이미 있는 것 / 새로 만들 것"을 나눠서 진행 계획을 세우세요.
(문서 `docs/architecture-v12.html` §05 컴포넌트표에는 "미착수(P5)"로만 적혀 있고 세부 구현 상태는
이번 조사에서 처음 확인하는 것입니다 — 문서를 맹신하지 말고 코드로 재확인할 것.)

### C-2. embed 서브모듈 초기화 및 빌드

```powershell
cd "D:\ai factory\auto docu\anything-llm"
git submodule update --init embed
cd embed
# package.json을 열어서 실제 빌드 스크립트 이름 확인 후 진행 (yarn build 등)
Get-Content package.json | Select-String '"scripts"' -Context 0,15
```

빌드 결과물이 서버가 서빙하는 위치(`server/public` 등, `anythingllm-embed` 리포의 README 참고)로
올바르게 연결되는지 확인. **이 리포는 서브모듈이라 별도 커밋 이력을 가지므로, 서브모듈 안에서 코드를 수정하면
안 됩니다** — 서브모듈은 빌드만 하고, 우리 쪽 변경은 항상 `server/`, `docs/` 등 메인 리포 파일에만 하세요.

### C-3. 서버 측 보안 하드닝 적용

결정 지점 3에서 정한 방향에 따라:

```powershell
# server/.env.development (gitignore 대상, 로컬 전용)에 추가
# EMBED_REQUIRE_ALLOWLIST="true"
```

위젯을 만들 워크스페이스를 정하고, 관리 API로 embed 설정을 생성:

```text
POST /embeds/new  (내부 관리 API, server/endpoints/embedManagement.js)
```

생성된 embed의 `allowed_domains`(또는 `EmbedConfig.parseAllowedHosts()`가 참조하는 필드명을
`server/models/embedConfig.js`에서 정확히 확인 후)에 실제 도메인을 등록.

**민감 워크스페이스는 절대 이 단계에서 선택하지 마세요** — `docs/architecture-v12.html` §07의
민감도 축(Axis 1) 분류가 "격리·민감"인 워크스페이스는 embed 대상에서 제외해야 합니다. 이 체크를
수동으로 할지 코드 가드를 추가할지도 결정 지점 3의 일부로 이미 확인했어야 합니다.

### C-4. Cloudflare Tunnel 설정

```powershell
# cloudflared 설치 확인/설치 (winget 또는 공식 설치 파일)
where.exe cloudflared
```

없으면 설치가 필요합니다. 설치 후:

```powershell
cloudflared tunnel login
cloudflared tunnel create anything-llm-embed
cloudflared tunnel route dns anything-llm-embed <고정할 서브도메인>
```

로컬 3001(server) 또는 embed 전용 포트를 터널에 연결하는 config 파일 작성.
**이 자격증명·터널 설정 파일은 절대 git에 커밋하지 마세요** — `.gitignore`에 해당 경로가
없으면 추가하세요 (`cloudflared` config는 보통 `%USERPROFILE%\.cloudflared\`에 저장되므로
리포 안에는 안 들어가는 게 기본이지만, 혹시 리포 안에 config를 만들었다면 반드시 무시 처리).

### C-5. 검증

```powershell
# 터널이 뜬 상태에서, 화이트리스트에 등록된 도메인이 아닌 origin으로 요청했을 때 차단되는지 확인
# (curl로 Origin 헤더를 위조해서 테스트)
curl -H "Origin: https://not-allowed.example.com" https://<터널도메인>/api/embed/... 
# → 403 또는 차단 응답이어야 함

# 화이트리스트에 등록된 도메인으로는 정상 동작하는지 확인
curl -H "Origin: https://실제도메인" https://<터널도메인>/api/embed/...
```

민감 워크스페이스가 embed 목록에 노출되지 않는지 관리 API로도 재확인:

```text
GET /embeds  (내부 관리 API)
```

응답에 격리·민감 워크스페이스가 섞여 있으면 즉시 롤백.

### C-6. 완료 기준

- `git submodule status`에서 `embed`가 `-` 없이(초기화 완료) 표시됨
- 화이트리스트 미포함 origin은 차단, 포함된 origin은 정상 응답
- 민감 워크스페이스가 embed 설정 목록에 없음(수동 확인 + 가능하면 자동 테스트)
- 고정 도메인으로 외부에서 실제 접속 확인(다른 네트워크에서 curl 또는 브라우저로 1회 이상 테스트)
- `docs/architecture-v12.html` §08(구현 현황)의 "P5 · 외부 봇 배포 — 미착수" 항목을 "완료" 또는
  "부분 완료(모바일 제외)"로 갱신하고, 실제로 한 작업(화이트리스트 정책, 터널 도메인 존재 여부 등)을 기록
- `eval/FINDINGS.md`에는 이 작업이 검색/답변 회귀와 무관하므로 추가하지 않음 — 대신
  별도로 `docs/` 아래에 이번 배포 절차와 도메인/보안 설정을 기록한 운영 노트를 남길 것을 권장
  (파일명 예: `docs/p5-embed-deployment-notes.md`, 비밀번호·토큰은 절대 포함하지 말 것)

---

## 전체 예상 소요 시간

| 단계 | 내용 | 예상 시간 |
|---|---|---|
| 사전 준비 | 서버 기동 확인 | 5분 |
| A단계 | 방향 1 또는 2 중 택1 시도 + 회귀 검증 | 2~4시간 |
| A단계 (둘 다 시도 시) | 방향 1 + 방향 2 순차 진행 | 4~6시간 |
| C-1 조사 | 코드베이스 실제 구현 상태 확인 | 30분~1시간 |
| C-2~C-4 구현 | 서브모듈 빌드 + 보안 설정 + 터널 구성 | 3~5시간 (cloudflared 최초 설치·DNS 전파 대기 포함) |
| C-5~C-6 검증 | 외부 접속 테스트 + 문서화 | 1시간 |
| **합계** | | **반나절 ~ 1.5일** |

Cloudflare Tunnel의 DNS 전파 대기 시간이 예측 불가능한 변수이니, C단계는 여유 있게 반나절 이상 잡는 것을 권장합니다.

---

## 공통 주의사항

- 코드를 고치기 전에 항상 `git status --short`로 워크트리 상태를 확인하고, 무관한 변경이 섞이지 않게 하세요.
- 이 프로젝트의 품질 게이트(D8)는 "골든 세트 회귀 없음"입니다. A단계에서 모델/설정을 바꾼 뒤에는
  반드시 `eval/run.mjs`와 `eval/answers.mjs`를 실행해 회귀가 없는지 확인하세요.
- `server/.env.development`는 `.gitignore` 대상이라 커밋되지 않습니다. 이 파일에 넣은 값은
  반드시 `server/.env.example`과 `docker/.env.example`의 주석 블록에도 반영해서, 다른 환경에서
  같은 값을 재현할 수 있게 하세요(이번 세션에서 `RERANKER_CANDIDATE_LIMIT`을 그렇게 처리한 방식을 그대로 따르면 됩니다).
- 결정 필요 지점(1, 2, 3)에서는 반드시 먼저 질문하고, 답을 받은 뒤에 코드를 작성하세요. 임의로 넘어가지 마세요.
- 작업이 끝나면 `docs/architecture-v12.html`과 `eval/FINDINGS.md`(해당되는 경우)를 갱신하고,
  변경사항을 논리적 단위로 나눠 커밋하세요(이번 세션에서 한 것처럼 "버그 수정"과 "성능/기능 추가"를 분리).
