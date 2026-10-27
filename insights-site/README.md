# insights-site — 아카이브 → 전사 인사이트 사이트 (프로토타입)

파이프라인: 추출(general만) → 생성(`claude -p`) → **사람 승인** → 정적 사이트 빌드.

```
node insights-site/generate.mjs --list                 # 분야별 general 문서 수
node insights-site/generate.mjs 공정거래 동반성장       # 초안 생성 → data/drafts/
node insights-site/review.mjs show 공정거래             # 초안 검토
node insights-site/review.mjs approve 공정거래 --by 이름 # 승인 → data/approved/
node insights-site/build.mjs                           # 승인분만 → site/
node insights-site/build.mjs --preview                 # 미승인 초안 포함(배너 표시, 배포 금지)
```

`site/` 폴더(index.html + site-data.js)를 아무 웹서버에 복사하면 끝.

## 폴더 구조
```
insights-site/
├─ lib.mjs                      공용: 아카이브 읽기·general 필터·claude 호출
├─ generate.mjs · review.mjs    분야 인사이트 초안 생성 · 사람 승인(승인된 것만 발행)
├─ forecast.mjs                 통계 전망(부문별 몬테카를로, P10~P90)
├─ board.mjs · outlook.mjs      전망 보드의 환경·위기·해설 초안 생성
├─ fetch-media.mjs · build.mjs  기사 이미지 내려받기 · 정적 사이트 빌드
├─ template/                    feed(메인)·board(전망)·topic(주제) HTML, 공통 CSS/JS, fonts/
├─ data/
│  ├─ drafts/ approved/         주제·보드 초안과 승인본 (JSON)
│  ├─ research/ forecast.json   외부 근거 정리 · 전망 결과
│  ├─ media.json                이미지 id → 원본 주소·출처
│  └─ media/                    받은 이미지 (git 제외, fetch-media.mjs 로 다시 받음)
└─ site/                        빌드 결과 (git 제외, build.mjs 로 다시 만듦)
```
git 에서 제외하는 것: `site/`, `data/media/`(외부 기사 이미지), 사내 문서 기반 분야 초안(`공정거래.json`·`동반성장.json`, 검토 전).


## 토픽 보드 (핀터레스트형 피드, 예: GS리테일 2026~2028 전망)
```
node insights-site/forecast.mjs                 # general 사업보고서 XBRL 표 → 부문별 통계 전망(몬테카를로) → data/forecast.json
# data/research/<slug>.json 에 외부 기사 근거를 정리(원문을 읽어 확인한 것만; 미확인은 unverified)
node insights-site/board.mjs gsretail-2026      # 대외환경·위기·고민할 것 카드 초안 → data/drafts/board-<slug>.json
node insights-site/outlook.mjs gsretail-2026    # 전체 해설·부문별 전망 해설을 초안에 병합(기존 카드 유지)
node insights-site/review.mjs approve board-gsretail-2026 --by 이름
node insights-site/build.mjs [--preview]
```
- 페이지 구성: 01 전체 매출 전망(+부문별, 숫자로 더 보기) → 02 통계 분석 설명(+민감도) → 03 대외환경·위기 요인 → 04 Inside(함께 생각해 볼 질문) → 05 Insight(HOW 제안).
- 차트·수치 카드는 `forecast.json`에서 코드로 그리고, 서술 카드만 LLM 초안(근거 id 없으면 버림).
- 전망은 점이 아니라 P10~P90 구간. 가정(장기 성장 앵커 등)은 `forecast.mjs`의 `A`에서 조정.
- 로컬 확인: `site/`를 `python -m http.server`로 서빙(`file://`는 일부 도구에서 막힘).

## 이미지 피드(홈) + 주제 페이지
`site/index.html` 은 이미지 카드 피드(핀터레스트형, 카드 위에 제목). 카드를 누르면 해당 페이지로 이동하고, 영상 카드는 눌러서 재생한다.
- 카드 1: 매출 전망(`gsretail-2026.html`, 위 토픽 보드). 카드 2~: 트렌드 주제(`<slug>.html`)와 그 안의 상품 사례·영상 핀.
- 트렌드 주제는 `data/drafts/topic-<slug>.json` 에 직접 쓴다(구역 4개: 현상 → 유통과의 연결 → 이유 → 생각할 것). 항목 type: stat · case(이미지+시트) · video · note · question. `pin:true` 인 항목은 피드에도 올라간다.
- 이미지: `data/media.json` 에 id→url·출처를 적고 `node insights-site/fetch-media.mjs` 로 `data/media/` 에 받는다(사내 프록시면 `NODE_EXTRA_CA_CERTS`). 사내 비상업 용도, 카드마다 출처 표기.
- 영상: YouTube id 만 저장하고 youtube-nocookie 로 임베드(원본 링크 제공).
- 승인: `review.mjs approve topic-<slug>` 후 `build.mjs`. 해석·가설은 본문에 그렇게 표시하고, 확인 못 한 것은 `unverified` 에 둔다.

## 질문(Inside)과 HOW(Insight)
- 주제 파일의 마지막 섹션에서 `"mark": "HOW"` 가 있는 항목은 보라색 카드로 아래 `Insight` 섹션에, 나머지 질문은 어두운 카드로 위 `Inside` 섹션에 나뉜다. 전망 보드는 draft 의 `ideas` 배열이 `Insight` 섹션이 된다.
- 로컬 확인: `site/` 를 `python -m http.server` 로 서빙한다.

## 규칙
- `sensitivity = general` 이 아닌 문서는 `lib.mjs` 에서 걸러진다.
- 근거 문서 번호가 없는 항목은 `generate.mjs` 가 버린다.
- 문서가 5건 미만인 분야는 생성하지 않는다(억지 채우기 방지).
- 사이트 데이터에는 문서 제목만 들어가고 해시·내부 ID는 나가지 않는다.

## Mac 이식
- 폴더째 복사. 경로는 `ARCHIVE_ROOT`(기본: 이 폴더의 부모)로 해석 — 하드코딩 없음.
- Node 22.5+ (`node:sqlite` 사용), `claude` CLI 필요(`CLAUDE_CLI_BIN`으로 경로 지정 가능).
- 스케줄러(주 1회 generate)만 OS별로 다름: Windows 작업 스케줄러 ↔ Mac `launchd`.
- `data/`(초안·승인 이력)를 복사하면 승인 상태가 그대로 이어진다.
