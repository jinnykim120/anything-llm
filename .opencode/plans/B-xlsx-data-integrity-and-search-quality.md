# 작업 지시서: XLSX 데이터 손실 방지 및 검색 품질 개선

## 배경 (반드시 읽을 것)

사용자가 `_samples/생계형적합업종/면류` 폴더의 엑셀 파일 하나를 업로드했는데, 분류 검수 화면에 안 보이고 채팅 검색에서도 "정보 없음"으로 답변하는 문제를 겪었다. 조사 결과 이건 이 파일 하나의 우연한 문제가 아니라 **XLSX 처리 경로 전체의 구조적 결함**이었다.

원인은 세 가지가 겹쳐 있다:

1. **물리적 데이터 손실**: `collector/processSingleFile/convert/asXlsx.js`가 시트 이름을 `slugify()`로 슬러그화해서 결과 파일명(`sheet-${slugify(name)}.json`)을 만드는데, 시트 이름이 한글(또는 slugify가 제거하는 비-ASCII 문자)로만 되어 있으면 `slugify()`가 **빈 문자열**을 반환한다. 그러면 같은 폴더 안의 여러 시트가 모두 `sheet-.json`이라는 동일 파일명으로 저장되며 **서로 덮어쓴다**. 에러 로그도 없이 조용히 사라진다.
   - 실제 확인: `server/storage/documents` 안의 XLSX 결과 폴더 21개 중 **17개가 완전히 비어 있음(0개 json 파일)**. 나머지 4개도 폴더당 1개 파일만 생존.
2. **분류 검수 화면에서 숨겨짐**: XLSX 변환은 `finalizeBlocksDoc` 공통 파이프라인(PDF/DOCX/PPTX/HWP가 쓰는)을 타지 않기 때문에 파서 출력 JSON에 `content_hash` 필드가 원래 없다. `server/endpoints/classification.js`의 `archiveDocuments()`는 `if (!hash) continue;`로 `content_hash`가 없는 문서를 그룹핑에서 완전히 건너뛴다. 즉 워크스페이스에는 있어도 분류 검수 목록에는 안 보인다. (서버가 사후 보정을 하지만, 이는 `addDocuments` 실행 이후에만 workspace_documents.metadata에 채워지고, 과거에 이미 적재된 문서에는 반영 안 됨.)
3. **표 데이터가 청킹 시 헤더와 분리됨**: XLSX는 `blocks` 배열을 만들지 않으므로 `server/utils/TextSplitter/index.js`의 표 헤더 반복 로직(`#tableHeaderLine`, block-aware 경로에서만 동작)이 전혀 적용되지 않는다. 순수 `RecursiveCharacterTextSplitter`(chunkSize=1200)로만 잘리기 때문에, 실측 결과 11개 청크 중 1개만 헤더를 갖고 나머지는 "2025년 | 0 | 0 | 98426.8" 같은 숫자만 있고 컬럼명("직접생산/대기업 OEM/중소기업 OEM")이 없는 상태로 임베딩된다. 큰 시트(107,793자)는 103개 청크 중 102개가 헤더 없음.

추가로 검색 후보군 자체가 좁다는 부차적 문제도 확인됨(우선순위 낮음, Phase 3으로 분류):
- Reranker 후보 제한(`RERANKER_CANDIDATE_LIMIT`, 기본 10, 최대 50)이 문서 규모에 비례한 확장(`corpusCandidateCount = totalEmbeddings * 0.1`)을 사실상 무력화한다.
- `topN`의 Prisma 스키마 기본값은 12(`server/prisma/schema.prisma:161`)인데, `server/models/workspace.js:96-102`의 검증 함수 기본값은 4로 서로 다르다. 과거 마이그레이션(`20260901010020_auto_docu_default_topn_12`)은 컬럼 default만 바꾸고 기존 row는 그대로 복사했으므로, 오래된 워크스페이스는 지금도 topN=4일 수 있다.
- Reranker 메모리 임계값(`RERANKER_MIN_FREE_MEMORY_MB`, 기본 3200MB)이 로컬 환경에서 자주 못 미쳐서 dense-only 검색으로 매번 폴백하고 있다(로그에서 반복 관찰됨).

사용자는 다음을 승인했다:
1. 코드 수정 진행
2. Phase 1(데이터 손실 방지) + Phase 2(검색 품질) + Phase 3(검색 후보 확장) + Phase 4(검증/모니터링) **전부** 진행
3. XLSX 컨버터는 **먼저 안전한 최소 패치**로 고친다 (finalizeBlocksDoc으로의 전면 파이프라인 통합 같은 큰 리팩터링은 이번 작업 범위 아님 — 회귀 위험이 크다고 판단해 사용자가 명시적으로 보류를 선택함)
4. **"앞으로 엑셀 자료들에 대해서 동일한 문제가 발생하지 않아야 한다"** — 이것이 이번 작업의 최우선 성공 기준이다. 수동 검증만으로는 재발 방지를 보장할 수 없으므로, Phase 1-1과 Phase 2 모두 **자동화된 회귀 테스트 코드 작성이 필수 작업**이다 (선택 사항 아님). 사용자가 명시적으로 다음 두 테스트를 필수로 지정함:
   - asXlsx.js 파일명 충돌 방지 테스트
   - TextSplitter 표 헤더 보존 테스트
5. Phase 1-1의 파일명 수정 방식은 **이 프로젝트의 기존 관례를 그대로 따른다** — 순번 접두어 방식이 아니라 uuid 접미어 방식.

### 사전 조사로 확인된 사실: asXlsx.js가 프로젝트에서 유일한 예외

`collector/` 전체에서 `slugify(` 호출 38건을 전수 조사한 결과, **`asXlsx.js:146`(시트별 파일명 생성)을 제외한 모든 컨버터/익스텐션이 예외 없이 `${slugify(x)}-${uuid}` 패턴을 쓰고 있다.** 즉 slugify가 빈 문자열을 반환해도 uuid가 뒤에 붙어 파일명 유일성이 항상 보장되는 것이 이 프로젝트의 확립된 안전 관례다.

확인된 안전 사례 (전부 `${slugify(x)}-${data.id 또는 uuid}` 패턴):
- `asAudio.js:73`, `asImage.js:48`, `asEPub.js:53`, `asTxt.js:51`
- `asMbox.js:70` (`${slugify(filename)}-${data.id}-msg-${item}` — 메일 제목 slugify가 실패해도 안전)
- `asXlsx.js:106` (parseOnly 모드의 결합 문서 — 이건 이미 안전함, 문제는 else 블록의 시트별 루프뿐)
- `ObsidianVault/index.js:67`, `PaperlessNgx/index.js:91`, `Confluence/index.js:128`
- `WebsiteDepth/index.js:164-165`, `RepoLoader`(Github/Gitea/Gitlab) 각 76/103번째 줄

**`asXlsx.js:146`의 `filename: \`sheet-${slugify(name)}\`` 단 한 곳만 uuid 없이 시트명 슬러그에만 의존한다.** 이것이 유일한 근본 원인이며, 다른 파일을 추가로 수정할 필요는 없다. (구현자는 이 사실을 신뢰하고 재조사로 시간을 낭비하지 말 것 — 이미 전수 조사됨.)

## 목표

1. XLSX 시트 파일명 충돌로 인한 데이터 손실을 원천 차단한다.
2. XLSX(및 유사하게 content_hash가 없는 형식)가 분류 검수 화면에 정상적으로 나타나게 한다.
3. XLSX의 표 형식 데이터가 청킹될 때 헤더 컨텍스트를 잃지 않게 한다.
4. 검색 후보 확장(reranker candidate limit, topN 일관성)을 개선한다.
5. 기존에 이미 손상된 데이터를 진단하고 복구 가능한 것은 복구한다.
6. 향후 이런 "조용한 손실"을 관리자가 알아챌 수 있는 최소한의 점검 수단을 추가한다.

## 범위 외 (이번에 하지 않음)

- `asXlsx.js`를 `finalizeBlocksDoc`/blocks 파이프라인으로 전면 통합하는 것 (사용자가 명시적으로 보류 선택)
- OCR/officeparser 폴백 경로의 표 감지 히스틱 추가 (조사에서 발견됐지만 이번 지시서 범위 밖 — 별도 후속 작업으로 남김)
- PPTX의 officeparser 폴백 경로 개선 (마찬가지로 후속 작업으로 남김)

---

## Phase 1: 데이터 손실 방지 (최우선)

### 1-1. XLSX 시트 파일명 충돌 수정

**파일**: `collector/processSingleFile/convert/asXlsx.js`

**문제 지점**: 146번째 줄
```js
const document = writeToServerDocuments({
  data: sheetData,
  filename: `sheet-${slugify(name)}`,   // ← 한글 시트명이면 빈 문자열이 됨
  destinationOverride: outFolderPath,
  options: { parseOnly: options.parseOnly },
});
```

**수정 방법**: `sheetData`는 이미 각 시트마다 `v4()`로 생성된 고유 `id`(130번째 줄, `sheetData.id`)를 갖고 있다. 프로젝트의 기존 관례(다른 모든 컨버터가 쓰는 `${slugify(x)}-${uuid}` 패턴)를 그대로 따라, 146번째 줄을 다음과 같이 바꾼다:

```js
filename: `sheet-${slugify(name)}-${sheetData.id}`,
```

`slugify(name)`이 빈 문자열이 되어도 `sheetData.id`(uuid)가 뒤에 붙어 파일명이 항상 유일하다. 이 방식은 프로젝트의 다른 모든 컨버터(asAudio.js, asImage.js, asEPub.js, asTxt.js, asMbox.js 등)와 완전히 동일한 패턴이므로 리뷰어나 향후 유지보수자가 코드를 볼 때 일관성이 있고 이해하기 쉽다. (순번 접두어 방식은 이 프로젝트의 관례와 다르므로 사용하지 않는다.)

**주의사항**:
- 이 변경은 `parseOnly` 모드(단일 결합 문서, 81-110번째 줄)에는 영향 없음. `parseOnly=false`(else 블록, 112-155번째 줄)만 대상.
- `writeToServerDocuments`가 내부적으로 `sanitizeFileName`을 거치므로(collector/utils/files/index.js:135) 특수문자 처리는 이미 되어 있음.
- 기존에 이미 만들어진 폴더(예: `2021~2025-_gs_-.xlsx-727e`)의 파일명 규칙과는 무관 — 이번 수정은 **앞으로 새로 업로드되는 파일**에만 적용됨. 기존 손상 데이터는 Phase 4에서 별도 처리.

**검증 방법 (수동)**: 여러 시트(전부 한글 이름)를 가진 XLSX 샘플로 업로드 테스트. `server/storage/documents/<폴더>` 안에 시트 개수만큼 JSON 파일이 모두 생성되는지 확인. 예를 들어 `_samples/생계형적합업종/면류/면류 관련 全 상품 데이터 및 추출 증빙.xlsx`처럼 여러 시트를 가진 파일로 재현 테스트할 것.

**필수 작업 — 자동 회귀 테스트 추가**:

`collector/__tests__/processSingleFile/convert/asXlsx.test.js`(신규 파일)를 작성한다. 참고할 기존 테스트 패턴: `server/__tests__/utils/files/moveProcessedDocsToFolder.test.js` (임시 디렉토리 생성 → 함수 실행 → 파일시스템 결과 검증 → afterEach로 정리하는 구조).

테스트에 반드시 포함할 시나리오:
1. **재현 테스트 (수정 전 버그를 정확히 잡아내는 테스트)**: 시트 이름이 전부 한글(예: `["국수 집계표", "냉면 집계표", "기타"]`)인 워크북을 구성해 `asXlsx()`를 호출하고, 반환된 `documents` 배열의 길이가 시트 개수와 정확히 일치하는지 검증한다. 이 테스트는 수정 전 코드에서는 반드시 실패해야 한다(시트가 서로 덮어써서 documents 배열이나 실제 파일 개수가 시트 수보다 적게 나옴) — 구현 전에 이 테스트를 먼저 작성해서 실패를 확인한 뒤, 코드를 고치고 통과시키는 순서를 권장한다.
2. 시트 이름이 완전히 동일한 경우(예: 두 시트 모두 `"Sheet1"`)에도 두 파일이 서로 다른 이름으로 생성되는지 검증 (uuid가 동일 slugify 결과를 구분해주는지 확인).
3. 시트 이름이 영문/숫자로 정상적인 경우(기존 정상 동작)에도 회귀가 없는지 확인 — 파일명에 `slugify(name)` 부분이 여전히 사람이 읽을 수 있는 형태로 남아있는지 검증.
4. 실제 `node-xlsx`로 워크북을 만들기 어렵다면, `xlsx.parse`를 모킹하거나 `processSheet`가 반환하는 구조를 직접 구성해 `asXlsx` 내부의 파일 쓰기 로직만 검증해도 된다 — 핵심은 "시트 이름이 slugify 후 빈 문자열이 되는 경우에도 각 시트가 독립된 파일로 저장된다"는 것을 코드로 증명하는 것.

이 테스트는 `yarn test`(루트 `package.json`의 jest 스크립트) 또는 `collector` 디렉토리에서 직접 jest를 실행해 통과를 확인한다.

### 1-2. 기존 손상 데이터 진단

**목적**: 어떤 XLSX가 몇 개 시트 중 몇 개만 남았는지, 원본(`_samples`)이 남아있어 복구 가능한지 파악.

**작업**:
1. `server/storage/documents` 하위의 `.xlsx-` 패턴 폴더 21개를 순회하며 각 폴더의 JSON 파일 개수를 기록 (이미 조사에서 확인: 17개 폴더가 0개, 4개 폴더가 1개씩).
2. 각 손상된 폴더의 JSON 파일 내부 `title`/`docSource` 필드에서 원본 파일명을 추출.
3. `_samples` 디렉토리를 재귀 검색해서 동일한 원본 파일명을 가진 `.xlsx` 파일이 있는지 대조 (조사 결과 `_samples`에 xlsx가 20개 존재함을 이미 확인).
4. "복구 가능"(원본 있음) / "복구 불가능"(원본 없음, 데이터 완전 손실) 목록을 작성해 사용자에게 보고.

**주의사항**: 이 단계는 순수 조사이며 코드/데이터 변경이 없다. 진단 결과를 반드시 사용자에게 먼저 보여주고, 실제 재업로드는 Phase 4에서 사용자 확인 후 진행할 것 (또는 이 브리핑에서 바로 진행 승인이 나 있다면 Phase 4에서 실행).

---

## Phase 2: 검색 품질 개선 — 표 헤더 보존 (안전한 최소 패치)

**중요**: 사용자가 "먼저 안전한 방식"을 명시적으로 요청했다. `asXlsx.js`를 `finalizeBlocksDoc` 파이프라인으로 통합하는 것은 회귀 위험이 크므로 **하지 않는다**. 대신 최소 침습적인 방법으로 표 헤더가 각 청크에 반복되도록 한다.

### 접근 방식 옵션 검토 (구현자가 선택할 것)

**옵션 A (권장, 가장 안전): XLSX 전용 pageContent 앞에 헤더 정보를 주기적으로 삽입하지 않고, 대신 `server/utils/TextSplitter/index.js`의 flat 텍스트 분할 경로(`splitText`)에도 표 헤더 반복을 지원하도록 확장.**

- `TextSplitter.splitDocument()`의 `if (!blocks.length)` 분기(181-189번째 줄, `server/utils/TextSplitter/index.js`)에서 `documentData.pageContent`가 파이프 테이블 형식인지 감지(첫 줄이 `|`를 포함하고 두 번째 줄이 구분선 패턴 `/^[\s|:-]+$/`인지)하면, `splitText` 대신 새로운 "표 인식 flat 분할" 로직을 타게 한다.
- 이 로직은 이미 존재하는 `#tableHeaderLine()` 정적 메서드(309-314번째 줄)를 재사용할 수 있다. `rawSplit()`으로 나눈 뒤 각 조각(첫 조각 제외)에 헤더 라인을 prepend.
- 장점: XLSX뿐 아니라 asTxt.js를 거치는 CSV/TXT 형식의 파이프 테이블에도 자동으로 적용됨. 컨버터 코드 변경 없이 TextSplitter 레벨에서만 처리하므로 회귀 위험이 낮음(TextSplitter는 이미 여러 형식이 공유하는 지점이지만, 새 분기를 추가하는 것이므로 기존 blocks 경로/기존 flat 경로에는 영향 없음).
- 주의: 이 변경이 PDF/DOCX 등 다른 flat-splitText 경로(blocks 없는 문서 전체)에도 영향을 주므로, 파이프 테이블처럼 보이는 일반 텍스트(우연히 `|`가 많은 텍스트)를 잘못 표로 인식하지 않도록 감지 조건을 신중하게 작성할 것. 최소 조건: 첫 줄에 `|`가 2개 이상 있고, 두 번째 줄이 구분선 패턴과 일치.

**옵션 B (대안, 더 국소적): `asXlsx.js`에서 파일을 쓰기 전에 `pageContent`를 미리 chunkSize 단위로 나눠 각 조각에 헤더를 삽입해 저장.**

- 이 방식은 실제 임베딩 시점의 chunkSize와 값이 어긋날 수 있어(설정이 바뀌면 미리 나눈 조각과 실제 청킹이 안 맞음) 옵션 A보다 덜 견고함. 구현자가 옵션 A가 너무 위험하다고 판단할 경우의 대안으로만 사용.

**구현자는 옵션 A를 우선 시도하고, 테스트 중 회귀가 발견되면 옵션 B로 전환할 것.**

### 검증 방법 (수동)

`_samples/생계형적합업종/면류` 폴더의 `2021년~2025년 국수 출하량...xlsx` (또는 유사 표 형식 파일)로 재현 테스트:
1. 업로드 후 생성된 JSON의 `pageContent` 확인.
2. 실제 임베딩 시 몇 개 청크로 나뉘는지, 각 청크에 헤더(`구분 | 점검 기준 출하량...` 및 `직접생산 | 대기업 OEM | 중소기업 OEM`)가 포함되는지 수동 확인.
3. 채팅에서 "2025년 국수 출하량은?" 질문 시 정답(98,426.8kg)이 나오는지 최종 확인.

### 필수 작업 — 자동 회귀 테스트 추가

`server/__tests__/utils/TextSplitter/index.test.js`(신규 파일, 기존에 이 경로에 테스트가 없다면 새로 생성)를 작성한다.

테스트에 반드시 포함할 시나리오:
1. **재현 테스트**: 위 실측에서 확인된 것과 동일한 형태의 파이프 테이블 텍스트(헤더 행 + 구분선 + 여러 데이터 행, 전체 길이가 chunkSize를 넘어 여러 청크로 나뉘도록 충분히 길게 구성)를 `documentData.pageContent`로 주고 `blocks`는 빈 배열(또는 undefined)로 `splitDocument()`를 호출한다. 반환된 `chunks` 배열을 순회하며 **각 청크에 헤더 행(첫 줄과 구분선)이 포함되어 있는지** 검증한다. 수정 전 코드에서는 마지막 청크들에 헤더가 없어야 하므로 이 테스트가 실패하는 것을 먼저 확인하고, 코드를 고친 뒤 통과시킬 것.
2. **오탐 방지 테스트**: 파이프 문자(`|`)가 우연히 포함된 일반 텍스트(예: "A | B 옵션 중 선택하세요" 같은 문장이 포함된 일반 산문, 표 구분선 패턴이 아닌 것)를 넣었을 때 표로 잘못 인식해 헤더를 반복 삽입하지 않는지 확인 — 즉 기존 PDF/DOCX 등 일반 텍스트의 flat 분할 동작이 회귀하지 않는지 검증하는 것이 이 테스트의 핵심 목적.
3. **정상 표 감지 조건 테스트**: 첫 줄에 `|`가 2개 이상 있고 두 번째 줄이 구분선 패턴(`/^[\s|:-]+$/`)과 일치하는 최소 조건으로 표가 정확히 감지되는지, 조건 중 하나만 만족하는 경우(예: 구분선 없이 `|`만 있는 텍스트)에는 표로 인식하지 않는지 확인.
4. 기존에 이미 있는 blocks 기반 분기(`blocks.length > 0`인 경우)의 동작에는 전혀 영향이 없는지 — 즉 이번 변경이 `if (!blocks.length)` 분기 내부에서만 일어나고 그 바깥의 block-aware 로직은 손대지 않았는지 코드 리뷰 관점에서 재확인.

이 테스트는 `yarn test`로 통과를 확인한다. 이 테스트가 Phase 1의 asXlsx.js 테스트와 함께 통과해야 이번 작업이 "완료"된 것으로 간주한다.

---

## Phase 3: 검색 후보 확장 (부차적 개선)

### 3-1. Reranker candidate limit 상향

**파일**: `server/utils/vectorDbProviders/pgvector/index.js:81-93` (`rerankCandidateLimit` 정적 메서드)

현재:
```js
static rerankCandidateLimit(totalEmbeddings, topN = 4) {
  const configured = this.integerSetting("RERANKER_CANDIDATE_LIMIT", 10, 10, 50);
  const corpusCandidateCount = Math.ceil(totalEmbeddings * 0.1);
  return Math.max(topN, Math.min(configured, Math.max(10, corpusCandidateCount)));
}
```

`configured`의 기본값(10)과 최대값(50)이 `integerSetting`의 min/max 파라미터로 고정되어 있어, env 변수를 설정하지 않으면 항상 10 근처에 머문다. `corpusCandidateCount`(문서 규모 기반 10%)가 아무리 커도 `configured`(기본 10, 상한 50) 안에서만 움직인다.

**수정 방향**: `.env` 또는 `.env.example`에 `RERANKER_CANDIDATE_LIMIT` 권장값을 30~50 정도로 명시하는 문서화를 추가하거나(안전), 기본값 자체를 조금 올리는 것을 고려(예: fallback 10 → 20, max 50 → 80). 코드 변경 시 `integerSetting("RERANKER_CANDIDATE_LIMIT", <fallback>, <min>, <max>)` 세 번째/네 번째 인자를 조정.

**주의**: 이 값을 너무 올리면 rerank 연산량(레이턴시)이 늘어난다. 66개 문서/~1000벡터 규모를 기준으로 30 정도가 합리적인 절충점으로 보이나, 실제 조정값은 구현자가 리랭커 응답 시간을 실측하며 결정할 것. 무리하게 80까지 올리지 말고 우선 30으로 시작해 필요 시 조정 권장.

### 3-2. topN 기본값 불일치 해소

**파일**: `server/models/workspace.js:96-102`

현재:
```js
topN: (value) => {
  if (value === null || value === undefined) return 4;
  const n = parseInt(value);
  if (isNullOrNaN(n)) return 4;
  if (n < 1) return 1;
  return n;
},
```

Prisma 스키마 기본값(`server/prisma/schema.prisma:161`)은 12인데 이 검증 함수의 fallback은 4. 새 워크스페이스 생성 시 `additionalFields.topN`이 명시적으로 안 넘어오면 이 validate 함수가 4로 강제하게 되어 스키마 default(12)가 무의미해진다.

**수정 방향**: `workspace.js`의 fallback 값을 스키마와 동일하게 12로 맞춘다. `return 4` → `return 12`, `if (isNullOrNaN(n)) return 4;` → `return 12;`

**추가 작업**: 이미 DB에 `topN=4`(또는 null)로 저장된 기존 워크스페이스를 12로 올리는 Prisma 마이그레이션을 하나 추가한다. 예:
```sql
UPDATE workspaces SET topN = 12 WHERE topN IS NULL OR topN = 4;
```
단, 사용자가 의도적으로 4로 설정한 워크스페이스가 있을 수 있으므로 이 마이그레이션이 안전한지 재확인 필요 — 현재 상황에서는 대부분의 워크스페이스가 검토 없이 기본값을 쓰고 있을 가능성이 높아 이 UPDATE가 합리적이라고 판단되나, 실행 전 실제 DB의 topN 분포를 조회해서 사용자 커스텀 설정처럼 보이는 값(예: 8, 20 등 4가 아닌 값)은 건드리지 않을 것.

### 3-3. Reranker 메모리 임계값 재검토 (선택적, 저위험)

**파일**: `server/utils/EmbeddingRerankers/native/index.js:36-39`

```js
static assertLoadMemory() {
  const configured = Number(process.env.RERANKER_MIN_FREE_MEMORY_MB);
  const minimumMb = Number.isFinite(configured) ? configured : 3_200;
  ...
}
```

이 값은 코드 변경 없이 `.env`에서 `RERANKER_MIN_FREE_MEMORY_MB`를 낮게(예: 1800~2000) 설정하는 것만으로 조정 가능하다. 코드 수정이 아니라 **운영 환경 설정 변경**이므로, 이 브리핑에서는 실제 값 변경보다는 "로컬 개발 환경에서 이 값이 자주 걸린다면 낮춰서 재시도해볼 것"이라는 권고만 남긴다. 강제로 낮추면 실제로 메모리가 부족한 상황에서 프로세스가 죽거나 응답이 매우 느려질 위험이 있으므로, **이 항목은 코드 수정 대상이 아니라 운영 튜닝 권고 사항**으로 별도 처리.

---

## Phase 4: 검증 및 모니터링

### 4-1. 기존 XLSX 재업로드로 복구

Phase 1-2에서 만든 진단 목록을 바탕으로, `_samples`에 원본이 남아있는 손상된 XLSX 파일들을 Phase 1-1의 수정된 코드로 재업로드한다. 재업로드 전 서버가 재시작되어 새 코드가 반영됐는지 확인할 것.

재업로드 후 각 파일의 시트 개수만큼 JSON이 정상 생성됐는지, 분류 검수 화면에 나타나는지, 채팅 검색이 정상 동작하는지 순서대로 확인.

### 4-2. 분류 검수 화면에 "숨은 문서" 점검 기능 추가 (선택적 개선)

**목적**: `content_hash`가 없어서 `archiveDocuments()`에서 스킵되는 workspace_documents 레코드를 관리자가 찾을 수 있게 한다.

**구현 방향**:
- `server/endpoints/classification.js`에 새 엔드포인트(예: `GET /classification/orphaned`)를 추가해서, 특정 워크스페이스(또는 전체)의 `workspace_documents` 중 `metadata.content_hash`가 없는 레코드 목록을 반환.
- 프론트엔드 분류 검수 화면(`frontend/src/pages/GeneralSettings/Classification/index.jsx`)에 경고 배너나 별도 섹션으로 "분류 목록에 없는 문서 N건 발견" 같은 안내를 추가하는 것은 이번 지시서의 필수 범위는 아니며, 백엔드 API만 우선 추가하고 프론트엔드 노출은 다음 스텝으로 미뤄도 무방. 구현자가 시간 여유에 따라 판단.

이 항목은 "있으면 좋음" 수준이며, Phase 1~3이 모두 끝난 뒤 여유가 있으면 진행. 필수 아님.

### 4-3. 전체 재검증 체크리스트

- [ ] **`yarn test` (루트) — asXlsx.js 파일명 충돌 테스트, TextSplitter 표 헤더 테스트 모두 통과 (필수, 이번 작업의 핵심 성공 기준)**
- [ ] `yarn lint` (server), `yarn lint:check` (server) 통과
- [ ] `yarn lint` (collector), `yarn lint:check` (collector) 통과
- [ ] `yarn lint` (frontend), `yarn lint:check` (frontend) 통과 (4-2를 프론트까지 구현한 경우)
- [ ] 여러 시트(한글 이름 포함) XLSX 업로드 → 모든 시트가 개별 JSON으로 생존하는지 확인 (수동 재확인, 테스트로 자동화됐어도 실제 서버로 한 번 더 확인)
- [ ] 새로 업로드된 XLSX가 분류 검수 화면(`/settings/classification`)에 나타나는지 확인
- [ ] 표 형식 데이터 채팅 질문 시 헤더 컨텍스트를 포함한 정확한 답변이 나오는지 확인 (예: "2025년 국수 출하량은?" → "98,426.8kg")
- [ ] 기존에 손상된 XLSX 중 복구 가능한 것들을 재업로드하고 동일하게 확인
- [ ] `git status`, `git diff --check` 확인 후 논리 단위로 커밋 (신규 테스트 파일도 반드시 커밋에 포함)

---

## 작업 순서 요약

1. Phase 1-1: `asXlsx.js` 파일명 충돌 수정 (최우선, uuid 접미어 방식 — 기존 관례 그대로) **+ 재현 테스트를 먼저 작성해 실패 확인 → 코드 수정 → 테스트 통과 확인**
2. Phase 1-2: 손상 데이터 진단 (읽기 전용 조사, 사용자에게 보고)
3. Phase 2: TextSplitter 표 헤더 보존 로직 추가 (옵션 A 우선 시도) **+ 재현 테스트를 먼저 작성해 실패 확인 → 코드 수정 → 테스트 통과 확인 (오탐 방지 테스트 포함)**
4. Phase 3-2: topN 기본값 통일 + 마이그레이션
5. Phase 3-1: Reranker candidate limit 조정
6. Phase 4-1: 손상 데이터 재업로드 및 검증
7. Phase 4-2: (선택) 숨은 문서 점검 API
8. Phase 4-3: `yarn test` 전체 통과 확인 + 전체 체크리스트 확인 후 커밋/Push

각 Phase 완료 시마다 서버 재기동, lint 확인, 실제 API/화면으로 재현 검증을 거칠 것. 특히 Phase 2(TextSplitter 변경)는 다른 모든 문서 형식의 flat 분할 경로에 영향을 줄 수 있으므로, 기존 PDF/DOCX 등의 검색이 회귀하지 않았는지 반드시 확인할 것.

**이번 작업의 최종 성공 기준**: 사용자가 요구한 "앞으로 엑셀 자료들에 대해서 동일한 문제가 발생하지 않아야 한다"는 것은, 코드가 고쳐졌다는 사실만으로는 충분하지 않다. `yarn test`로 실행되는 자동 회귀 테스트 2건(asXlsx.js 파일명 충돌 방지, TextSplitter 표 헤더 보존)이 저장소에 커밋되어, 앞으로 누군가 이 파일들을 다시 수정해도 CI/로컬 테스트가 즉시 재발을 잡아낼 수 있는 상태가 되어야 이번 작업이 완료된 것으로 간주한다.
