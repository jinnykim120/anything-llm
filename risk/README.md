# Risk Monitor (리스크 점검) — ~/AI_factory/Risk
- 매일 08:00·14:00 `deploy/mac-risk.sh` → `risk.mjs`: 웹 검색으로 이슈 수집(식품안전·가맹업·유통규제·소비자/사회) → 사내 아카이브(NEXUS, general 등급) 대조 → 당사와의 관계·위험도·확인할 점 → `data/issues.json` 누적 → `site/index.html` → `~/risk-monitor/` 게시
- 보는 곳: http://<맥북 IP>:8081/ (인사이트 사이트와 별도, 링크 없음). 제외 기준 없이 전부 싣는다.
- 수동 실행: `bash deploy/mac-risk.sh [--slot am|pm]`, 페이지만 다시: `--build-only`

## AI 분석 · 서버 경로 가져오기 (2026-11)
- **AI 분석**: 사건 상세 → `AI 분석` 버튼 → 확인창(읽을 파일·보관만·개인정보 의심·이미지 수·예상 비용) → `분석 시작`. 누르기 전에는 AI 를 호출하지 않는다. 결과는 항상 **초안** 카드이며 담당자가 확정한다. 한도(rate limit)에 걸리면 `일시중지` → `이어서 실행`.
  고객 명단·개인정보 의심 파일·.msg 등은 AI 에 보내지 않는다(보관만). 이미지는 기본으로 Claude 비전으로 읽는다(끌 수 있음).
- **서버 경로로 가져오기**: 아카이브 목록 → `서버 경로로 가져오기`. 이 서버 PC 의 폴더 경로(절대 경로)를 넣고 `미리보기`(복사 없음) → 체크한 폴더만 가져오기(AI 호출 없음).
  허용 경로는 `config/import.json` 의 `allowedImportRoots`(기본 `D:\ai factory`)로 제한한다. 바꾸려면 이 파일을 고치고 저장(서버 재시작 불필요), 임시로는 환경변수 `RISK_IMPORT_ROOTS`(세미콜론 구분).
  `data/cases` 직하에 사용자가 둔 원본 폴더는 가져올 수 있지만, 시스템이 관리하는 사건 폴더·DB·secrets 는 거부한다.
- **배치 실행**: 사건 폴더별 가져오기+분석을 서버와 별도 프로세스로 돌리는 드라이버를 쓴다(상태 `reports/batch-state.json`, 결과 `reports/batch-<날짜>.json|txt`). 이 저장소에는 사건 폴더 이름이 박힌 실행 스크립트를 포함하지 않았다 — 필요하면 `importer.mjs`·`analyze.mjs` 를 호출하는 드라이버를 새로 만든다.
- **시험**: `RISK_CLAUDE_STUB=scripts/fake-claude.mjs` 로 가짜 claude 를 쓰면 AI 를 호출하지 않고 흐름을 확인할 수 있다.
- 설정: `config/analysis.json`(비용 근거·상한·규칙), `config/import.json`(허용 경로).
