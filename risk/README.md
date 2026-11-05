# Risk Monitor (리스크 모니터링)

NEXUS 생태계의 한 갈래. 이슈를 먼저 감지하고(Sensing), 사건 자료를 보관하며(Archive), 단계별로 대응해(Incident Response) 종결하면 다음 대응의 기준으로 남긴다.

## 구조 (실제 사용 환경 기준)
- **Windows PC (이 시스템)**: 화면·DB(사건·단계·카드)·AI 호출(센싱, 카드 분석, 대응 제안, 종결 요약)을 모두 여기서 한다. AI 는 `claude -p`(그 PC 의 팀 계정)로 부른다.
- **Mac 의 NEXUS**: 사건 원본 보관(잠금 폴더 `리스크관리`), 문서 파싱, 사내 아카이브 검색을 맡는다. 네트워크(HTTP API)로만 연결한다. Mac 은 리스크를 위해 Claude 를 부르지 않는다.
- 원본은 **양쪽에** 둔다(PC `data/cases/…/원본/` + Mac `리스크관리/<사건 폴더>/`). Mac 이 꺼져 있어도 PC 에서는 계속 쓸 수 있다.

## 실행
```
node server.mjs                       # http://<이 PC>:8081  (환경변수 RISK_PORT 로 포트 변경)
RISK_NEW_PASSWORD=… node server.mjs --set-password   # 접속 비밀번호 설정(해시만 저장)
```
접속은 비밀번호 로그인(쿠키). 확정 비밀번호(사건 카드·종결 확정)는 기본이 접속 비밀번호와 같고 화면에서 따로 정할 수 있다.

## Mac NEXUS 연결 (`config/nexus.json` + `secrets/`)
| 파일 | 내용 | git |
|---|---|---|
| `config/nexus.json` | `baseUrl`(NEXUS 서버, 예 `http://<주소>:3001`), `workspace`(검색할 워크스페이스), `caseFolder`, `allowTitlePatterns`(AI 에 보내도 되는 문서 제목 정규식), 로컬 대체값 | 제외 (`nexus.example.json` 참고) |
| `secrets/nexus-key.txt` | NEXUS API 키(한 줄) | 제외 |
| `secrets/nexus-folder.json` | 잠금 폴더 이름·비밀번호 | 제외 |
| `secrets/nexus-client.txt` | 이 PC 의 NEXUS 클라이언트 ID(자동 생성). NEXUS 는 이 ID 별로 잠금 폴더를 8시간 열어 준다 | 제외 |

- 점검: `node nexus.mjs --check` (서버 응답 → 키 인증 → 워크스페이스 → 잠금 폴더 열기까지 읽기 전용으로 확인)
- **민감도 방어**: NEXUS API 응답에는 문서 민감도가 없다. 그래서 센싱의 사내 아카이브 검색은 `allowTitlePatterns` 에 맞는 제목의 문서만 AI 에 보낸다(목록이 비면 아무것도 안 보냄). 사건 원본은 잠금 폴더에만 들어가며 전사 아카이브 검색에는 연결하지 않는다.
- 업로드(`nexussync.mjs`): 새 파일은 PC 저장 직후 자동으로 Mac 에 올라가고 Mac 이 읽은 본문이 `data/cases/<사건>/.nexus/` 에 캐시된다(PDF 처럼 이 PC 에 파서가 없는 형식을 AI 분석이 이 본문으로 읽는다). 기존 사건은 자동 일괄 업로드를 하지 않고, 사건 상세의 `Mac NEXUS에 올리기` 버튼으로만 올린다. 연결 문제로 실패한 파일은 서버가 10분마다 자동 재시도한다. NEXUS 가 직접 거부한 형식(예: 음성)은 재시도하지 않는다.
- NEXUS 는 하위 폴더를 API 로 지울 수 없다(최상위 폴더만 삭제됨). 사건 하위 폴더 정리는 NEXUS 화면에서 한다.

## 화면
- **Dashboard**: 연도·월·유형·사업부문별 건수, 센싱→사건화 전환율.
- **Sensing**: 오늘의 이슈, 유형·사업부문 분류(AI 는 제안만), 사건화·보류(사유 기록), 키워드 직접 검색.
- **Archive**: 사건 폴더 목록·상세, 폴더 선택 업로드(종결 여부 선택), 서버 경로 가져오기, AI 분석(버튼·확인창·예상 비용), 사건 카드 확정, zip 다운로드.
- **Incident Response**: 진행 중 사건의 6단계 기록, 단계별 `제안 받기`(버튼), 종결 요약 → 확정 → Word/PDF.
- 디자인: `app/skin.css` (우리동네GS 디자인 문서 기준). 되돌리려면 `app/index.html` 에서 링크 한 줄만 지운다.

## AI 를 쓰는 곳 (토큰)
| 어디서 | 언제 | 비고 |
|---|---|---|
| 센싱 웹 수집 | 자동 실행(08시·14시)·수동·키워드 검색 | 가장 큼. 분야 4개 + 관심 키워드 묶음 = 5회 호출, 검색·열람 반복. 실행이 끝나면 `[사용량]` 줄과 `logs/sensing-cost.jsonl` 에 호출별 토큰·비용이 남는다 |
| 센싱 이슈 분석 | 위 실행 안에서 이슈마다 1회 | 작음 |
| 아카이브 AI 분석 | 사건 상세 `AI 분석` 버튼 + 확인창 | 사건당 약 $0.07~0.30 (이미지가 많으면 더) |
| 사건 대응 | `제안 받기`, `종결 요약 초안` 버튼 + 확인창 | 실측 제안 약 $0.03, 종결 요약 약 $0.04 (확인창 안내는 $0.03~0.10) |
업로드·가져오기·분류 규칙·개인정보 의심 표시·대시보드·zip/Word/PDF 는 토큰을 쓰지 않는다. 시험: `RISK_CLAUDE_STUB=scripts/fake-claude.mjs` 로 가짜 claude 를 쓰면 AI 를 호출하지 않고 흐름을 확인할 수 있다.

## Windows 배포
- 자동 센싱: `deploy/register-risk-task.ps1` 이 작업 스케줄러에 08:00·14:00 항목(`deploy/risk.cmd`)을 등록한다. `risk.cmd` 는 `config/nexus.json` 의 사내 프록시 인증서(`caCert`)를 `NODE_EXTRA_CA_CERTS` 로 지정한다(없으면 출처 링크 확인이 전부 실패한다).
- PDF 내보내기에 LibreOffice 가 필요하다(`D:\LibreOffice` 등 설치 경로 자동 탐색, 환경변수 `RISK_SOFFICE` 로 지정 가능). 없으면 Word 만 받을 수 있다.
- 데이터 백업은 `data/cases/` 와 `data/risk.db` 를 한 쌍으로 한다. 확정 비밀번호·접속 비밀번호는 `secrets/`.

## 설정 파일
`config/taxonomy.json`(리스크 9개 유형·사업부문 6개·6단계·파일 종류), `config/analysis.json`(AI 분석 비용 근거·상한·규칙), `config/import.json`(서버 경로 가져오기 허용 경로), `config/nexus.json`(위 표).

## 배치 실행
사건 폴더별 가져오기+분석을 서버와 별도 프로세스로 돌리려면 `importer.mjs`·`analyze.mjs` 를 호출하는 드라이버를 새로 만든다(사건 이름이 박힌 스크립트는 저장소에 포함하지 않는다).
