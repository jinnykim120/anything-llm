// [auto-docu 자료 추출하기] RAG 유사도검색이 아니라, 사용자가 정확히 고른
// 문서 집합을 전부 훑어(exhaustive) 요청한 항목을 뽑아낸다 — 문서가 많거나
// 길면 RAG top-K가 특정 수치를 놓칠 수 있다는 문제를 "검색하지 않고 전부
// 읽는다"로 해결한다. 문서별로 독립적으로 LLM 추출을 돌리므로 한 문서에서
// 못 찾은 값이 다른 문서의 결과에 영향을 주지 않는다.
//
//   POST /workspace/:slug/extract-data/upload   multipart: file(단건 — 기존
//     handleFileUpload 미들웨어가 "file" 필드 하나만 받으므로, 여러 파일을
//     올릴 땐 프론트가 파일마다 이 엔드포인트를 반복 호출한다. 새 멀터
//     설정을 추가하지 않고 기존 단일 업로드 패턴을 그대로 재사용하기 위함)
//     -> { title, pageContent }  (아카이브에 저장되지 않음 — 이번 추출
//         1회용. 계속 보관하려면 기존 "자료 업로드"를 쓸 것)
//   POST /workspace/:slug/extract-data/run
//     { fields, uploadedDocs?: [{title,pageContent}], folderKeys?: string[] }
//     -> { fields, documents: [{title, values:{field:{value,evidence}|null}}] }
const { reqBody, safeJsonParse } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { getLLMProvider, stripThinkingFromText } = require("../utils/helpers");
const { handleFileUpload } = require("../utils/files/multer");
const { parseUploadEphemeral } = require("../utils/files/parseUploadEphemeral");
const { COMPANY_GLOSSARY } = require("../utils/prompts/companyGlossary");
const { resolveFolderDocIds } = require("../utils/classification/folderFilter");
const { resolveOwnedArchiveDocs } = require("../utils/docRegen");
const prisma = require("../utils/prisma");
const { extractLimits } = require("../utils/extractLimits");
const { excerptRelevant } = require("../utils/textExcerpt");

const CHUNK_CHARS = 10000;

function extractJsonObject(text = "") {
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match ? match[0] : cleaned;
}

function chunkText(text, size = CHUNK_CHARS) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size)
    chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : [""];
}

function buildExtractMessages({
  fields,
  title,
  chunk,
  chunkIndex,
  chunkTotal,
}) {
  const system =
    [
      "당신은 문서 전문에서 사용자가 요청한 항목의 실제 수치·사실만 정확히 추출하는 보조자입니다.",
      "아래 '문서 전문'에 실제로 적혀 있는 내용만 추출하십시오 — 없는 값을 만들어 내지 마십시오.",
      "요청한 항목이 이 문서(이 부분)에 없으면 그 항목의 값을 null로 남기십시오.",
      "찾은 값은 어느 문장/구절에서 가져왔는지 evidence에 그대로 인용하십시오.",
      "반드시 아래 JSON 형식으로만 응답하십시오. 설명, 코드펜스 없이 JSON 객체 하나만:",
      `{"values": {"항목명": {"value": "...", "evidence": "..."} , "항목명2": null}}`,
    ].join("\n") + `\n\n${COMPANY_GLOSSARY}`;
  const user = [
    `## 추출할 항목\n${fields}`,
    `## 문서 제목\n${title}`,
    `## 문서 전문(${chunkIndex + 1}/${chunkTotal}부분)\n${chunk}`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// 문서 하나(청크 여러 개일 수 있음)를 exhaustively 훑어 항목별 값을 뽑는다.
// 이미 값을 찾은 항목은 다음 청크로 덮어쓰지 않는다(첫 발견 우선, 그렇다고
// 나머지 청크를 건너뛰지는 않음 — 못 찾은 항목이 있으면 계속 찾는다).
async function extractFromDocument({
  title,
  pageContent,
  fields,
  LLMConnector,
  temperature,
  limits = extractLimits(),
  budget = { calls: 0 },
}) {
  let text = String(pageContent || "");
  // 상한보다 긴 문서는 앞에서 자르지 않고 요청 항목과 관련 있는 구간만 남긴다.
  const chunkCap = limits.maxChunksPerDoc;
  let excerpted = false;
  if (Number.isFinite(chunkCap) && text.length > chunkCap * CHUNK_CHARS) {
    text = excerptRelevant(text, fields, chunkCap * CHUNK_CHARS);
    excerpted = true;
  }
  const chunks = chunkText(text);
  const values = {};
  let stoppedByCallCap = false;
  for (let i = 0; i < chunks.length; i++) {
    if (budget.calls >= limits.maxCalls) {
      stoppedByCallCap = true;
      break;
    }
    const stillMissing =
      Object.keys(values).length === 0 || Object.values(values).some((v) => !v);
    if (!stillMissing && i > 0) break;

    const messages = buildExtractMessages({
      fields,
      title,
      chunk: chunks[i],
      chunkIndex: i,
      chunkTotal: chunks.length,
    });
    budget.calls += 1;
    const { textResponse } = await LLMConnector.getChatCompletion(messages, {
      temperature: temperature ?? LLMConnector.defaultTemp,
    });
    const parsed = safeJsonParse(
      extractJsonObject(stripThinkingFromText(String(textResponse || ""))),
      null
    );
    if (!parsed?.values) continue;
    for (const [field, found] of Object.entries(parsed.values)) {
      if (!values[field] && found) values[field] = found;
      else if (!(field in values)) values[field] = found || null;
    }
  }
  return { title, values, excerpted, stoppedByCallCap };
}

// 폴더로 고른 문서 + 폴더를 열어 개별로 고른 문서(archiveDocIds)를 합쳐, 소유권
// 검증·연계성 기록·본문 로드는 resolveOwnedArchiveDocs 한 곳에서 처리한다.
async function gatherArchiveDocuments({
  workspace,
  folderKeys = [],
  archiveDocIds = [],
  recordAffinity = true,
}) {
  let ids = (Array.isArray(archiveDocIds) ? archiveDocIds : [])
    .map(Number)
    .filter(Number.isFinite);
  if (folderKeys?.length) {
    const docIds = await resolveFolderDocIds(workspace, folderKeys);
    if (Array.isArray(docIds) && docIds.length) {
      const rows = await prisma.workspace_documents.findMany({
        where: { workspaceId: workspace.id, docId: { in: docIds } },
        select: { id: true },
      });
      ids = [...ids, ...rows.map((r) => r.id)];
    }
  }
  ids = [...new Set(ids)].slice(0, extractLimits().maxDocs);
  return resolveOwnedArchiveDocs({
    workspaceId: workspace.id,
    docIds: ids,
    recordAffinity,
  });
}

function extractDataEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/extract-data/upload",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async (request, response) => {
      try {
        if (!request.file) throw new Error("업로드된 파일이 없습니다.");
        const doc = await parseUploadEphemeral(request.file.originalname);
        return response.status(200).json(doc);
      } catch (e) {
        console.error("POST /workspace/:slug/extract-data/upload", e);
        return response
          .status(500)
          .json({ error: e.message || "파일 업로드 중 오류가 발생했습니다." });
      }
    }
  );

  // 실행 전에 "최대 몇 회 호출될지"를 미리 알려준다. 업로드 문서는 본문이
  // 클라이언트에 있어 글자 수(uploadedChars)만 받는다.
  app.post(
    "/workspace/:slug/extract-data/estimate",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const {
          folderKeys = [],
          archiveDocIds = [],
          uploadedChars = [],
        } = reqBody(request);
        const limits = extractLimits();
        const archiveDocs =
          folderKeys?.length || archiveDocIds?.length
            ? await gatherArchiveDocuments({
                workspace,
                folderKeys: folderKeys || [],
                archiveDocIds,
                recordAffinity: false,
              })
            : [];
        const lengths = [
          ...(Array.isArray(uploadedChars) ? uploadedChars.map(Number) : []),
          ...archiveDocs.map((d) => String(d.pageContent || "").length),
        ].slice(0, limits.maxDocs);
        const perDoc = lengths.map((len) =>
          Math.min(Math.ceil(len / CHUNK_CHARS) || 1, limits.maxChunksPerDoc)
        );
        const worstCase = perDoc.reduce((a, b) => a + b, 0);
        const uncappedWorstCase = lengths.reduce(
          (a, len) => a + (Math.ceil(len / CHUNK_CHARS) || 1),
          0
        );
        return response.status(200).json({
          docs: lengths.length,
          maxCalls: Math.min(worstCase, limits.maxCalls),
          uncappedMaxCalls: uncappedWorstCase,
          limited: limits.limited,
          limits: {
            maxDocs: limits.maxDocs,
            maxChunksPerDoc: Number.isFinite(limits.maxChunksPerDoc)
              ? limits.maxChunksPerDoc
              : null,
            maxCalls: Number.isFinite(limits.maxCalls)
              ? limits.maxCalls
              : null,
          },
        });
      } catch (e) {
        console.error("POST /workspace/:slug/extract-data/estimate", e);
        return response.status(500).json({ error: e.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/extract-data/run",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const {
          fields = "",
          uploadedDocs = [],
          folderKeys = null,
          archiveDocIds = [],
        } = reqBody(request);
        if (!String(fields).trim())
          throw new Error("추출하고 싶은 항목을 입력해 주세요.");

        const archiveDocs =
          folderKeys?.length || archiveDocIds?.length
            ? await gatherArchiveDocuments({
                workspace,
                folderKeys: folderKeys || [],
                archiveDocIds,
              })
            : [];
        const limits = extractLimits();
        const combined = [...uploadedDocs, ...archiveDocs];
        const allDocs = combined.slice(0, limits.maxDocs);
        const docsDropped = combined.slice(limits.maxDocs).map((d) => d.title);
        if (!allDocs.length)
          throw new Error("추출할 자료(업로드 또는 아카이브 선택)가 없습니다.");

        const LLMConnector = getLLMProvider({
          provider: workspace?.chatProvider,
          model: workspace?.chatModel,
        });

        const documents = [];
        const budget = { calls: 0 };
        for (const doc of allDocs) {
          const out = await extractFromDocument({
            title: doc.title,
            pageContent: doc.pageContent,
            fields: String(fields).trim(),
            LLMConnector,
            temperature: workspace?.openAiTemp,
            limits,
            budget,
          });
          documents.push(out);
        }

        return response.status(200).json({
          fields: String(fields).trim(),
          documents,
          // 상한이 실제로 결과에 영향을 줬는지 화면에 알려주기 위한 요약.
          limits: {
            applied: limits.limited,
            maxDocs: limits.maxDocs,
            maxChunksPerDoc: Number.isFinite(limits.maxChunksPerDoc)
              ? limits.maxChunksPerDoc
              : null,
            maxCalls: Number.isFinite(limits.maxCalls) ? limits.maxCalls : null,
            callsUsed: budget.calls,
            docsDropped,
            docsExcerpted: documents
              .filter((d) => d.excerpted)
              .map((d) => d.title),
            docsCutByCallCap: documents
              .filter((d) => d.stoppedByCallCap)
              .map((d) => d.title),
          },
        });
      } catch (e) {
        console.error("POST /workspace/:slug/extract-data/run", e);
        return response
          .status(e.code === "RATE_LIMITED" ? 429 : 500)
          .json({ error: e.message || "자료 추출 중 오류가 발생했습니다." });
      }
    }
  );
}

module.exports = { extractDataEndpoints, extractFromDocument };
