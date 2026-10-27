# NEXUS 아키텍처 (맥 기준)

> **이 파일이 NEXUS 아키텍처의 단일 기준 문서입니다.** 앞으로 구조·보안·운영이 바뀌면 이 파일에 반영합니다.
> - 새 변경은 **§13 변경 이력** 맨 위에 추가하고, 영향받는 절을 같이 고칩니다.
> - 위치: `NEXUS-Mac-Package/NEXUS-ARCHITECTURE.md` (실제 파일은 저장소 `app/docs/NEXUS-ARCHITECTURE.md` 이고, 패키지 루트의 파일은 그 파일을 가리킵니다. 그래서 수정하면 git 으로 같이 저장됩니다.)
> - 저장소가 **공개**이므로 비밀번호·사내 IP·회사 문서 이름·키는 적지 않습니다.

| 항목 | 값 |
|---|---|
| 버전 | **v28** (윈도 시절 v27 이후, 맥 이전 + 접근 제어 + 관리자 콘솔 + 문서 요약) |
| 작성 | 2026-10-27 |
| 기준 브랜치 | `nexus_linux` (GitHub 기본 브랜치) |
| 윈도 시절 보존 | 태그 `windows-final` (= `feat/archive-qa`, v27). 더 이상 고치지 않음 |
| 이전 아키텍처 | `docs/architecture-v27.html` (윈도 시절, 기능 소개 중심) |

---

## 1. 한눈에 보기

NEXUS 는 사내 문서 아카이브 + 근거 기반 질의응답 + 문서 작성 시스템입니다 (AnythingLLM v1.16.0 포크).
v27 까지는 윈도 PC 한 대에서 로그인 없이 돌았고, v28 에서 **맥으로 옮기면서** 아래가 추가됐습니다.

1. **폴더 비밀번호** — 업로드하는 사람이 폴더를 만들며 비밀번호를 정하면, 모르는 사람의 검색·열람에서 그 폴더가 제외된다.
2. **브라우저별 대화 분리** — 로그인 없이 브라우저마다 대화·스레드가 따로 보인다.
3. **관리자 콘솔** — 관리자 비밀번호로 들어가는 별도 화면. 설정·관리 기능은 여기로 모았다.
4. **문서 요약** — 문서마다 한두 문장 요약을 만들어 문서함에 보여 준다.
5. **운영 보강** — 한글 폴더 이름(NFC/NFD) 처리, 시작 시 DB 마이그레이션, 테스트의 `.env` 오염 방지.

---

## 2. 시스템 구성

```
 사용자 브라우저 (같은 사내망)
   │  localStorage 의 임의 ID 를 X-Nexus-Client 헤더로 모든 API 요청에 붙임
   ▼
 ┌────────────────────────── 서버 맥 (macOS) ───────────────────────────┐
 │                                                                       │
 │  프론트엔드  Vite dev  :3000 ──(/api)──▶ 서버  Express  :3001          │
 │                                           │                           │
 │            accessContext  → 요청마다 접근 범위(scope) 계산             │
 │            consoleGuard   → 관리자 전용 경로 차단                      │
 │                                           │                           │
 │        ┌──────────────┬───────────────┬───┴────────────┐              │
 │        ▼              ▼               ▼                ▼              │
 │   SQLite (Prisma)  Postgres 17     collector :8888   Claude CLI        │
 │   anythingllm.db   + pgvector      문서 파싱·변환     `claude -p`       │
 │   (설정·문서목록·   anythingllm_   │                  (답변·초안·요약)  │
 │    분류·잠금·대화)  vectors        ├─▶ Docling :5001  (켜고 끌 수 있음) │
 │                    (384차원)       └─▶ LibreOffice (PPT/HWP→PDF)       │
 │                                                                       │
 │   로컬 ONNX: 임베딩(multilingual-e5-small) + 리랭커                    │
 │   파일: server/storage/documents/<폴더>/*.json  (+ originals/)         │
 │                                                                       │
 │   LaunchAgent: com.nexus.autostart (로그인 시 + 5분마다 run-local.sh)  │
 │                com.nexus.caffeinate (전원 연결 중 잠자기 방지)         │
 └───────────────────────────────────────────────────────────────────────┘
```

| 구성요소 | 위치/포트 | 비고 |
|---|---|---|
| 프론트엔드 | `app/frontend`, :3000 | Vite 개발 서버. 소스를 고치면 곧바로 반영됨 |
| API 서버 | `app/server`, :3001 | Node 24, Express, Prisma 5.3.1 |
| collector | `app/collector`, :8888 | 업로드 파일 → 파싱된 JSON |
| 메타 DB | `server/storage/anythingllm.db` | SQLite. 문서 목록·분류·대화·잠금·요약 |
| 벡터 DB | Postgres 17 + pgvector | 테이블 `anythingllm_vectors`, 청크 단위, `metadata->>'doc_id'` 로 문서와 연결 |
| 임베딩·리랭커 | 서버 프로세스 안 ONNX | 모델은 `server/storage/models` |
| LLM | Claude CLI (`claude -p`) | 모델 `claude-sonnet-5-5`. 이 맥에 로그인된 계정 사용 |
| Docling | 127.0.0.1:5001 | 표·구조 PDF/PPTX 정밀 파싱. 적재할 때만 켠다 |
| 작업공간 | `archive-full`(본 아카이브), `eval` | 벡터는 작업공간(namespace)별로 분리 |

**문서가 저장되는 방식**: 문서는 `storage/documents/<폴더>/<이름>.json` (폴더는 한 단계만). DB 의 `workspace_documents.docpath` 가 `폴더/파일.json` 이고, `docId` 가 벡터의 `doc_id` 와 같다. 폴더 이름이 곧 "저장 폴더"이며 비밀번호 잠금의 단위다. (문서함 화면의 "분류 폴더"는 업무 분류·사업부 값으로 묶은 **다른 개념**이다 — §8.)

---

## 3. 패키지 폴더 구조

```
NEXUS-Mac-Package/
├─ app/                 ← git 저장소 (GitHub, 공개). 소스 코드
│   ├─ server/ frontend/ collector/
│   ├─ docs/NEXUS-ARCHITECTURE.md   ← 이 문서의 실제 파일
│   └─ .local-cache/    ← 로그·가상환경·백업 (git 제외)
├─ data/                ← 설정·DB 덤프·모델 캐시 (윈도 내보내기본, git 제외)
├─ secrets/admin.env    ← 관리자 비밀번호 (git 밖, 권한 600)
├─ user-guide/          ← 사용자 배포용 가이드 (PDF/HTML/MD + 이미지)
├─ NEXUS-ARCHITECTURE.md → app/docs/NEXUS-ARCHITECTURE.md
├─ 1-setup.sh  2-start.sh  3-verify.sh
└─ README-맥에서-시작하기.md
```

- `user-guide/` 는 화면 이미지에 회사 문서가 보여 **저장소에 올리지 않는다.**
- `secrets/` 는 저장소 밖이라 코드와 함께 올라가지 않는다. 위치는 환경변수 `NEXUS_SECRETS_DIR` 로 바꿀 수 있다.

---

## 4. 접근 제어 (v28 핵심)

### 4-1. 사용자 식별 — 로그인 없이 "브라우저"를 사용자로

- 브라우저가 처음 열릴 때 임의의 ID(24바이트 난수)를 만들어 `localStorage` 에 저장한다 (`utils/nexusClient.js`).
- `window.fetch` 를 감싸서 API 로 가는 **모든 요청**에 `X-Nexus-Client` 헤더를 붙인다 (스트리밍 포함). 헤더를 못 붙이는 `<iframe>`/링크 URL 은 `?cid=` 쿼리를 쓴다.
- 서버는 이 ID 로 "이 브라우저가 연 폴더"와 "이 브라우저의 대화"를 구분한다. **사람이 아니라 브라우저**이므로, 같은 사람도 기기·브라우저마다 다른 사용자이고 브라우저 데이터를 지우면 새 사용자가 된다.
- 쿠키를 쓰지 않는 이유: 프론트(:3000)와 API(:3001)가 다른 출처이고 서버 CORS 가 자격증명을 허용하지 않는다.
- 사내 SSO 를 붙이면 이 ID 대신 사번이 키가 된다 (미구현, §12).

### 4-2. 접근 범위(scope) 계산 — `server/utils/folderAccess/index.js`

요청마다 한 번 `buildScope()` 로 계산해 `AsyncLocalStorage` 에 두고, 이후 모든 읽기 경로가 이것만 본다.

```
접근 범위 = 공개 폴더(잠금 행 없음)
          + 이 브라우저가 비밀번호로 연 폴더 (folder_unlocks, 기본 8시간)
          + (관리자 권한이 켜진 요청이면) 전부
```

- 범위를 알 수 없는 경우(요청 밖 작업, 헤더 없음, 에이전트 웹소켓, 외부 API 키)는 **공개 폴더만** 허용한다 (fail-closed).
- 폴더 = `docpath` 의 첫 구간. 루트 파일은 잠글 수 없다.
- 비밀번호는 `scrypt` + 폴더별 salt 해시로 저장 (`folder_locks.passwordHash`). 평문은 저장하지 않는다.
- 무차별 대입 제한: (브라우저·IP·폴더)별로 10분에 5회 실패하면 10분간 거부 (메모리 보관, 서버 재시작 시 초기화).
- 비밀번호를 바꾸면 그 폴더의 모든 열림 기록(`folder_unlocks`)을 지워 모두 다시 잠근다.

### 4-3. 한글 폴더 이름 (NFC/NFD)

윈도에서 가져온 `실적` 폴더는 디스크에서 분해형(NFD), DB 의 문서 경로는 조합형(NFC)이었다. 눈에는 같아도 문자열이 달라 **잠금이 이 폴더 문서에 안 걸리는** 구멍이 있었다. 이제 잠금 이름·문서 경로·디스크 이름을 비교하는 모든 곳이 NFC 로 정규화한다 (`folderOfDocpath`, `normalizeFolderName`, `canAccessFolder`, `deniedDocIds`, `purgeFolder` 등). 디스크 작업은 실제 디스크 이름으로 한다.

### 4-4. 검색에서 막는 방법 — 사전 필터 + 사후 필터

`server/utils/vectorDbProviders/pgvector/retrieval.js`

1. **SQL 사전 필터**: 밀집(dense)·리랭크·어휘(lexical) 검색 쿼리에 `COALESCE(metadata->>'doc_id','') <> ALL($n)` 를 넣어 잠긴 문서를 **후보를 뽑기 전에** 제외한다. 상위 K개를 뽑은 뒤 지우면 잠긴 문서가 상위권을 차지한 질문에서 결과가 비어 버리기 때문이다.
2. **사후 필터**: 기존 "미승인 생성 문서 제외" 집합에 잠긴 문서를 합쳐 한 번 더 거른다.
3. **최종 안전망**: 구간 확장(`expandSections`) 뒤에도 남은 잠긴 문서를 제거한다.

실데이터 검증: `실적` 폴더를 잠금 상태로 가정하면 밀집 검색의 해당 청크 127개, 어휘 검색의 53개가 사라지고, 열었거나 관리자면 되돌아온다.

### 4-5. 읽기 경로 점검표

| 경로 | 처리 |
|---|---|
| 벡터 검색 (채팅·초안·PPT·전사문서·텔레그램·API) | §4-4 |
| 문서 목록·검색 (`listFolders`, `viewLocalFiles`, `getDocumentsByFolder`, `getDocumentsByDocPaths`, `searchDocuments`) | 잠긴 폴더는 이름·🔒 표시만. 문서 수·파일명 숨김. ripgrep 본문 검색은 개수 제한 **전에** 걸러냄 |
| 원문 열람 `/document/raw/:docId` | 403 |
| 본문 로더 (`loadBaseDocument`, `Document.content`, `contentByDocPath`) | "잠긴 폴더의 문서입니다" 예외 → 초안·PPT·추출·통계·우선 자료가 조용히 제외 |
| 워크스페이스 문서 목록 응답 | 열 수 없는 폴더 문서 제외 (`maskWorkspaceDocuments`) |
| 분류 검수 목록 (`archiveDocuments`) | 열 수 없는 문서 제외 |
| 변경 (임베딩 추가·삭제, 폴더 삭제, 이동, 업로드, 재파싱) | 폴더를 열어야만 가능 |
| 생성 문서 보관 (`archive-generated`) | §4-7 |

### 4-6. 대화 분리

`workspace_threads`·`workspace_chats` 에 `client_id` 컬럼. 조회·삭제·수정은 `scopeChatWhere()` 가 "내 기록 + `client_id` 가 비어 있는 이전 기록(공개)"만 보이게 합친다. 새 기록은 현재 브라우저 ID 로 저장된다. 다른 브라우저의 스레드는 열기·삭제 모두 404. 관리자 **콘솔 요청**만 전체를 본다.

### 4-7. 생성 문서의 잠금 상속

잠긴 폴더 자료로 만든 초안·PPT·전사문서 결과를 다운로드하면 "내부생성자료"로 자동 보관되는데, 이것이 공개 폴더로 새지 않게 `restrictionForSources()` 가 판정한다.

- 근거 문서가 **정확히 한 개의 잠긴 폴더**에 있으면 → 결과를 **그 폴더로** 옮겨서 보관
- 서로 다른 잠긴 폴더를 섞었거나, 권한이 없거나, 근거를 모르는데 잠긴 폴더를 열어 둔 상태면 → **보관하지 않음** (다운로드 자체는 영향 없음)

### 4-8. 관리자와 콘솔

- 관리자 비밀번호는 `secrets/admin.env` 의 `NEXUS_ADMIN_PASSWORD`. 서버가 시작할 때 읽는다 (`index.js`). 값이 없으면 관리자 기능은 꺼지고 기존처럼 모두 열린다.
- 로그인은 `/api/nexus/admin/login` → `access_admins` 에 (브라우저 ID, 만료) 저장. **기본 30분, 콘솔을 쓰는 동안 자동 연장.**
- **관리자 권한은 로그인만으로 켜지지 않는다.** 요청에 `X-Nexus-Console: 1` 헤더가 있을 때만 적용된다. 프론트가 이 헤더를 붙이는 곳은 `/nexus-admin`, `/settings/*`(분류 검수 제외), `/workspace/:slug/(settings|affinity|usage)` 뿐이다. 그래서 **관리자도 평소 화면에서는 일반 사용자와 똑같이** 동작한다 (자기가 연 폴더만 검색, 자기 대화만 보임).
- **관리자 전용 경로 차단**: `utils/folderAccess/adminRoutes.js` 한 곳의 표(26개 규칙)로 막고, `consoleGuard` 가 라우터에 닿기 전에 검사한다. 대상은 `/admin/*`, 시스템 설정 쓰기, API 키, 이벤트 로그·전체 채팅 기록, 임베드 위젯 관리, 예약 작업, 모델 라우터, 작업공간 생성·삭제, 콘솔 API 등. **일반 사용자의 평소 작업 경로는 표에 넣지 않으며**, 이 구분은 단위 테스트(`adminRoutes.test.js`)가 지킨다 (예: 검색 방식 전환·모델 선택이 쓰는 `workspace/:slug/update`, 임베드 위젯의 공개 `stream-chat`, 분류 검수).
- 화면 쪽: `AdminGate` 가 설정 계열 라우트(`AdminRoute`/`ManagerRoute`/`SingleUserRoute`)를 감싸 로그인 안 한 접근을 `/nexus-admin?next=...` 로 보낸다. 세션이 만료되면 403 `needsAdmin` 응답을 받아 같은 곳으로 보낸다.

관리자 콘솔 (`/nexus-admin`, `frontend/src/pages/NexusAdmin`):

| 탭 | 내용 |
|---|---|
| 개요 | 문서·요약·잠긴 폴더·스레드·질문 수, 최근 24시간 질문, 대화를 남긴 브라우저 수 |
| 폴더 관리 | 전체 폴더 목록(문서 수·잠금 상태), 잠그기·비밀번호 초기화·잠금 해제·삭제 |
| 전체 대화 | 모든 브라우저의 질문·답변 열람(읽기 전용), 검색·브라우저 필터 |
| 시스템·설정 | 서버 상태, 기존 설정 화면 바로가기 |

---

## 5. 데이터 모델 (v28 추가분)

SQLite(Prisma) 마이그레이션 2개: `20261026140700_nexus_folder_locks`, `20261026160000_nexus_document_summaries`.

| 테이블/컬럼 | 용도 |
|---|---|
| `folder_locks(folder UNIQUE, passwordHash, createdByClient)` | 잠긴 폴더. 행이 없으면 공개 |
| `folder_unlocks(clientId, folder, expiresAt)` | 브라우저가 연 폴더. 만료되면 다시 잠김 |
| `access_admins(clientId UNIQUE, expiresAt)` | 관리자 비밀번호로 로그인한 브라우저 |
| `workspace_threads.client_id`, `workspace_chats.client_id` | 대화 소유 브라우저. NULL = 이전 기록(공개) |
| `document_summaries(contentHash UNIQUE, summary, sourceChars, model)` | 문서 요약 (내용 해시 기준) |

- 관계(FK)를 걸지 않았다 (SQLite 는 관계를 걸면 테이블 전체 재생성이라 위험하다는 기존 판단과 같음).
- 마이그레이션은 `run-local.sh` 가 서버를 새로 띄우기 전에 `prisma migrate deploy` 로 자동 적용한다 (멱등). 옛 DB(윈도 내보내기본)를 가져와도 서버가 깨지지 않는다.

---

## 6. 문서 요약

- 문서 내용 앞 **12,000자**를 읽고 설정된 LLM 이 한국어 2문장(120자 안팎)으로 요약 (`utils/summaries`). 수치·고유명사를 그대로 쓰고 추측하지 않게 지시.
- **처음 한 번**: `server/scripts/backfill-summaries.js` (이어서 실행 가능, 동시 3개). 현재 문서 전체 완료 — 154건이 352초, 실패 0.
- **이후**: 백그라운드 작업 `summarize-documents` 가 15분마다 새 문서를 10건까지 요약 (동시 2개).
- **잠긴 폴더 문서는 백그라운드에서 요약하지 않는다.** 아무도 폴더를 열지 않은 상태로 내용을 LLM 에 보내지 않기 위해서다. 폴더를 열 수 있는 사람이 문서함에서 **요약 만들기**를 누르면 `POST /classification/summary` 가 그 자리에서 만든다.
- 비용 실측(1건): 6천자 → 입력 약 7.5천 토큰·6.1초, 3만자 → 약 3.1만 토큰·9.2초. 토큰은 글자 수와 거의 1:1.
- 표시: `GET /classification/documents` 가 `summary` 를 내려주고 문서함 목록에 문서명 아래로 보인다. 접근 불가 문서는 목록에서 이미 빠지므로 요약도 같이 가려진다.

---

## 7. API 요약 (v28 추가/변경)

| 경로 | 설명 | 권한 |
|---|---|---|
| `GET /nexus/access` | 내 상태: `adminAuthed`, `isAdmin`(이 요청이 관리자 권한을 쓰는가), `adminEnabled` | 모두 |
| `GET /nexus/folders` | 폴더 목록 + 잠금/열림 여부 (내용 없음) | 모두 |
| `POST /nexus/folders/:name/unlock` · `/lock` | 비밀번호로 열기 / 이 브라우저에서 다시 잠그기 | 모두 |
| `POST /nexus/folders/:name/password` · `/remove-lock` | 현재 비밀번호를 아는 사람이 변경/해제 | 모두(비밀번호 필요) |
| `POST /nexus/admin/login` · `/logout` | 관리자 로그인/로그아웃 | 모두 |
| `GET /nexus/admin/overview` · `/folders` · `/chats` | 콘솔용 현황·폴더·전체 대화 | 관리자 |
| `POST /nexus/admin/folders/:name/lock` · `/nexus/folders/:name/admin-reset` | 공개 폴더 잠그기 / 비밀번호 초기화·해제 | 관리자 |
| `POST /document/create-folder` | `password` 선택 인자 추가 | 모두 |
| `POST /workspace/:slug/upload-and-embed` | `folderPassword` 인자(새 폴더일 때), 잠긴 폴더는 연 사람만 | 모두 |
| `GET /classification/folders` | 분류 폴더 값 + 문서 수 (빈 폴더 표시용) | 모두 |
| `DELETE /classification/taxonomy/axis` | `onlyEmpty` 모드(문서가 하나라도 있으면 거부) | 모두 |
| `POST /classification/summary` | 요약 즉시 생성 (열 수 있는 문서만) | 모두 |
| `DELETE /system/remove-folder` | 지울 수 없으면 400+사유(이전엔 조용한 200), 삭제 시 잠금 행도 정리 | 폴더를 연 사람 |

---

## 8. 화면 (프론트엔드) 변경

| 화면 | 변경 |
|---|---|
| 모든 화면 | 브라우저 ID 헤더 자동 부착. 왼쪽 아래(테마 버튼 옆)에 관리자 콘솔 바로가기 |
| 채팅·사이드바 | **검색 범위 표시**: "잠긴 폴더 N개는 검색에서 제외됨 · 열기" / "열어 둔 잠긴 폴더 N개 포함하여 검색". 누르면 폴더 목록에서 열기·다시 잠그기 |
| 자료 업로드 창 | 자료 구분에 서버 폴더 목록(🔒 표시)과 **+ 새 폴더 만들기**(이름 + 비밀번호). 잠긴 폴더는 비밀번호 입력 후 저장. 이 창이 검색 범위 설정(`archive-scope`)을 바꾸지 않도록 수정 |
| 내 문서(파일 선택기) | 폴더 🔒 아이콘, 클릭 시 비밀번호 창, 열린 폴더는 보안 설정(재잠금·비밀번호 변경·해제) |
| 문서함 | 문서 아래 요약·"요약 만들기" 버튼, **빈 폴더** 구역(문서 0건인 사용자 추가 폴더만, 휴지통으로 삭제) |
| 관리자 콘솔 | §4-8 |

**"추출 아카이브 범위"** (사이드바 드롭다운 전체/실적/법규/대외)는 저장 폴더가 아니라 **문서 종류(docType) 기준**으로 채팅 검색만 좁힌다. 자료 추출·초안·통계·PPT·전사문서작성에는 적용되지 않는다. 사규 등 일부 종류는 어느 범위에도 없어서, 범위를 좁히면 검색에서 빠진다.

**자료 추출**은 저장 폴더가 아니라 **업무 분류 폴더** 또는 개별 파일로 고른다. 분류 전 문서는 "미분류" 폴더에 들어 있으며, 잠긴 폴더 문서는 폴더를 연 브라우저에만 나타난다. 한 번에 최대 15건.

---

## 9. 운영

| 작업 | 방법 |
|---|---|
| 시작 / 중지 | `bash 2-start.sh` / `bash app/stop-local.sh` |
| 점검 | `bash 3-verify.sh [--llm]` |
| 자동 시작 | LaunchAgent 2개(로그인 시 + 5분마다 복구, 전원 연결 중 잠자기 방지). **로그인해야 올라온다** — 로그인 없는 부팅 시 시작은 미구현 |
| 로그 | `app/.local-cache/{server,collector,frontend}.run.log`, `migrate.run.log`, `summaries.backfill.log` |
| 관리자 비밀번호 바꾸기 | `secrets/admin.env` 수정 후 서버 재시작 |
| DB 백업 | 큰 변경 전 `app/.local-cache/backup/` 에 SQLite 사본을 만든다 |
| 설정 위치 | `app/server/.env.development` (DB 접속 등. 관리자 비밀번호는 여기 없음) |

주의할 점 (실제로 겪은 것):

- **테스트가 서버를 망가뜨릴 수 있었다.** 일부 jest 테스트가 `dumpENV()` 를 거치며 테스트용 `STORAGE_DIR` 을 실제 `server/.env` 에 써 넣었고, 다음 서버 시작부터 임베딩 모델을 엉뚱한 경로에서 찾아 **문서 업로드(임베딩)가 모두 실패**했다. `dumpENV()` 는 이제 jest 실행 중 아무것도 하지 않는다. 증상은 서버 로그의 "native embedding model has never been run and will be downloaded".
- 개발 서버(vite)라서 **화면 코드는 저장 즉시 모든 사용자에게 반영**된다. 서버 코드는 서버 재시작 후 반영된다.
- 한글 폴더를 가져오거나 복사할 때 NFC/NFD 가 바뀔 수 있다 (§4-3). `3-verify.sh` 의 "문서 경로 → 파일 확인" 이 알려 준다.

---

## 10. 보안 모델과 한계

| 지키는 것 | 방법 |
|---|---|
| 비밀번호를 모르는 사람의 검색·열람 | §4 (SQL 사전 필터 + 읽기 경로 점검 + 변경 차단) |
| 사용자 간 대화 | 브라우저별 `client_id` 분리 |
| 설정·관리 기능 | 관리자 비밀번호 + `consoleGuard` + 콘솔 헤더 |
| 비밀번호 저장 | scrypt 해시 (폴더), 관리자는 환경변수(파일 권한 600, 저장소 밖) |

| 한계 (알고 쓸 것) | 설명 |
|---|---|
| **HTTP** | 암호화 없음. 같은 네트워크에서 비밀번호가 평문으로 오간다. 소수 인원·사내망 한정이 전제 |
| **식별은 브라우저 단위** | 사람이 아니라 브라우저. 개별 권한 부여·회수는 SSO 이후 |
| **디스크는 암호화 안 됨** | 맥을 직접 쓰는 사람은 문서 파일과 DB 를 볼 수 있다 (FileVault 꺼짐) |
| **LLM 전송** | 폴더를 연 사용자가 질문하면 해당 내용이 Claude 로 전송된다 (요약은 §6 의 규칙) |
| **일부 경로는 범위 적용 밖** | 에이전트 웹소켓·모바일 동기화는 헤더를 못 보내 "공개만"으로 동작하거나 별도 인증을 쓴다. 외부 API 키 경로는 공개 폴더만 |
| **관리자 전체 열람** | 관리자는 콘솔에서 모든 대화를 본다 |
| **서버 재시작 시 시도 횟수 초기화** | 무차별 대입 제한이 메모리 보관 |

---

## 11. 검증 현황 (2026-10-27 기준)

- **자동 테스트**: 813건 통과, 1건 실패 — 실패는 v28 이전부터 있던 것(`NativeEmbeddingReranker memory guard`, 맥의 메모리 판정이 `os.freemem` 모킹과 맞지 않음). 이번에 추가한 테스트: `folderAccess`(NFC/NFD·관리자·생성물 상속 포함), `adminRoutes`(차단 표와 일반 경로 보호), `purgeFolder`, `docRegen` 잠금 거부.
- **실서버 확인**: 잠금 생성·열기·재잠금, 다른 브라우저의 목록/본문검색/원문/워크스페이스 문서 차단, 실제 질문→답변에서 연 사람은 근거 포함·안 연 사람은 "없음", 대화 분리, 생성물 상속, 관리자 로그인·콘솔 분리·설정 차단, 요약 전체 생성, 빈 폴더 삭제, 한글 폴더 삭제.
- **화면**: 헤드리스 Chrome 으로 주요 화면과 관리자 콘솔 4개 탭을 렌더링해 확인(JS 오류 0건). 다만 사람 눈으로의 전수 점검은 아님.
- **미확인**: 재부팅 후 자동 시작, 다른 기기(휴대폰·타 PC)에서의 접속, 전사문서작성tool·초안 수정의 세부 단계, 장시간 다중 사용자 부하.

---

## 12. 남은 과제 / 결정 대기

1. HTTPS 적용 (사내 IT 인증서 권장). 접속자가 늘거나 기밀 자료를 보호하기 시작하면 필요.
2. 사내 SSO 연동 → 브라우저 ID 를 사번으로 교체, 개별 권한 부여.
3. 로그인 없는 부팅 시 자동 시작, 맥 재부팅 후 동작 확인.
4. 항상 켜져 있는 서버(별도 PC/서버)로의 이전 검토 (맥 잠자기·메모리 한계).
5. "추출 아카이브 범위"를 저장 폴더/분류 폴더와 일치시킬지, 정리할지 (§8).
6. 요약 범위: 지금은 앞 12,000자. 긴 문서의 뒷부분은 반영되지 않는다.
7. 저장소를 비공개로 바꿀지.

---

## 13. 변경 이력 (새 항목은 맨 위에)

| 날짜 | 커밋 | 내용 |
|---|---|---|
| 2026-10-27 | `20156ddf` | 관리자 비밀번호를 저장소 밖 `secrets/admin.env` 로 이동, 서버가 시작 시 읽음 |
| 2026-10-26 | `0ca27557` | 관리자 콘솔 버튼을 사이드바 문구와 겹치지 않게 이동 |
| 2026-10-26 | `d2886221` | 관리자 콘솔 분리(콘솔 요청에만 관리자 권한), 설정 관리자 전용화(`consoleGuard`·`AdminGate`), 한글 폴더 NFC/NFD 정리, `purgeFolder` 수정, 테스트의 `.env` 오염 방지 |
| 2026-10-26 | `48aa5645` | 문서 요약(테이블·생성기·백그라운드 작업·일괄 스크립트·문서함 표시) |
| 2026-10-26 | `dba4d73b` | 검색 범위 표시(채팅·사이드바), 접근 변경 공용 이벤트 |
| 2026-10-26 | `4c32c51d` | 업로드 창이 검색 범위 설정을 바꾸던 문제 수정 |
| 2026-10-26 | `35e5e1bb` | 기준 브랜치 `nexus_linux`, 윈도 최종본 `windows-final` 선언 |
| 2026-10-26 | `e0867d0d` | 문서함 빈 폴더 표시·삭제(`onlyEmpty`) |
| 2026-10-26 | `eee0652b` | **폴더 비밀번호, 브라우저별 대화 분리, 관리자 권한**, 생성물 잠금 상속, 검색 사전 필터 |
| 2026-10-26 | `9e0ffc9b` | 사내 프록시 인증서 때문에 `yarn install` 이 실패하던 문제(`NEXUS_SKIP_CORP_CA`) |
| 2026-10-26 | (설치) | 윈도 → 맥 이전 패키지 설치·데이터 복원·검증(PASS 19), LaunchAgent 자동 시작 |
| ~2026-10-26 | `windows-final` | v27 — 윈도 PC 시절 최종본 (`docs/architecture-v27.html`) |
