import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  ArrowLeft,
  Sparkle,
  FileHtml,
  FileDoc,
  FileXls,
  FilePpt,
  Presentation,
  CircleNotch,
  PencilSimple,
  Eye,
  FolderOpen,
} from "@phosphor-icons/react";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import DOMPurify from "@/utils/chat/purify";
import Modal, { ModalHeader, ModalBody } from "@/components/lib/Modal";
import {
  draftBodyHtmlBlocks,
  downloadDraftHtml,
  extractDraftTitle,
  detectDesignRequest,
  DRAFT_ACCENT,
} from "./exporters";
import ScopedEditOverlay, { computeRelativeRect } from "./ScopedEditOverlay";
import { patchSlideSpec, blockTextFor } from "./pptSlideSpecPatch";
import StatsMethodPicker from "./StatsMethodPicker";

// [auto-docu 목표 3] 검색 답변 아래에서 열리는 하단 분할 패널.
// 답변 액션줄의 "문서 작성" 버튼이 아래 이벤트를 쏘면 ChatContainer 가 이 패널을 띄운다.
export const ARCHIVE_DRAFT_EVENT = "archive-open-draft";

export function openDraftPanel({ message, sources = [], chatId = null }) {
  window.dispatchEvent(
    new CustomEvent(ARCHIVE_DRAFT_EVENT, {
      detail: { message, sources, chatId },
    })
  );
}

// 1단계: 어떤 자료를 근거로 쓸지.
const DATA_SCOPES = [
  {
    key: "answer_only",
    label: "답변 내용 기반으로",
    desc: "지금 답변에만 근거해서 작성합니다 · 새로운 사실은 추가하지 않음",
  },
  {
    key: "answer_plus_web",
    label: "답변 내용 + 외부 데이터",
    desc: "답변 내용에 최신 웹 검색 자료를 더해 내용을 보강합니다",
  },
];
const DATA_SCOPE_LABEL = {
  answer_only: "답변 내용 기반으로",
  answer_plus_web: "답변 내용 + 외부 데이터",
};

// 드래그로 패널 높이를 조절할 수 있게 — 마지막 높이는 기억해둔다.
const PANEL_HEIGHT_STORAGE_KEY = "archive-draft-panel-height";
const MIN_PANEL_HEIGHT = 220;

// PPT 미리보기는 실제 슬라이드를 시각적으로 흉내내지 않는 구조화된 목록이므로
// (기존 표 미리보기와 같은 원칙), 차트도 실제 그래프를 그리는 대신 라벨이
// 붙은 자리표시자로만 보여준다.
const CHART_TYPE_LABEL = {
  bar: "막대 그래프",
  line: "선 그래프",
  pie: "원형 그래프",
};

function clampPanelHeight(height) {
  const max = Math.round(window.innerHeight * 0.85);
  return Math.min(Math.max(height, MIN_PANEL_HEIGHT), max);
}

// 2단계: 어떤 형태의 문서로 만들지 — 1단계 선택에 따라 설명이 달라진다.
// [auto-docu 통계분석] 통계분석 보고서 유형 — 실제 scikit-learn/statsmodels
// 계산을 거친 서술을 만든다(기본/분석보고서처럼 LLM이 통째로 지어내지 않음).
// PPT 쪽에는 의도적으로 없음(사용자 결정 — PPT에서는 이 기능의 가치가 낮음).
const STATS_REPORT_TYPE = {
  key: "stats",
  label: "통계분석",
  desc: "회귀·군집분석 등 실제 통계 계산을 거쳐 수치를 분석합니다.",
};
const REPORT_TYPES = {
  answer_only: [
    {
      key: "basic",
      label: "기본보고서",
      desc: "답변 내용을 목적 / 배경 / 현황 구조로 정리합니다.",
    },
    {
      key: "analysis",
      label: "분석보고서",
      desc: "위 내용에 시사점 · 검토의견 · 향후조치(건의)를 덧붙입니다.",
    },
    STATS_REPORT_TYPE,
  ],
  answer_plus_web: [
    {
      key: "basic",
      label: "기본보고서",
      desc: "답변 + 외부 자료를 종합해 더 풍부한 현황으로 정리합니다.",
    },
    {
      key: "analysis",
      label: "분석보고서",
      desc: "위 내용에 관련 동향 · 문제점 및 리스크 파악을 덧붙입니다.",
    },
    STATS_REPORT_TYPE,
  ],
};
const REPORT_TYPE_LABEL = {
  basic: "기본보고서",
  analysis: "분석보고서",
  stats: "통계분석",
};

// PPT 목적별 템플릿 — server/endpoints/pptDraft.js의 PPT_TEMPLATES와 라벨을
// 맞춘 프론트엔드 전용 목록(서버 설정을 그대로 불러오지 않고 문구만 맞춤).
const PPT_TEMPLATES = [
  {
    key: "analysis",
    label: "내용 분석",
    desc: "자료를 구조적으로 분석해 핵심 내용을 정리합니다.",
  },
  {
    key: "proposal",
    label: "제안",
    desc: "문제 제기부터 제안 내용, 기대효과까지 구성합니다.",
  },
  {
    key: "performance",
    label: "성과보고",
    desc: "주요 성과와 지표를 중심으로 보고합니다.",
  },
  {
    key: "status",
    label: "현황보고",
    desc: "현재 상태와 진행 상황을 정리해 보고합니다.",
  },
  {
    key: "data",
    label: "데이터 분석",
    desc: "수치·통계 자료를 표와 함께 분석적으로 제시합니다.",
  },
];
const PPT_TEMPLATE_LABEL = Object.fromEntries(
  PPT_TEMPLATES.map((t) => [t.key, t.label])
);
const MIN_SLIDE_COUNT = 4;
const MAX_SLIDE_COUNT = 20;

export default function DraftPanel({ source, workspace, onClose }) {
  // [auto-docu PPT 생성 Phase 1] 무엇을 만들지부터 고른다 — "doc"(기존 문서
  // 초안 흐름) | "ppt"(새 PPT 흐름). null이면 아직 선택 전(0단계).
  const [outputFormat, setOutputFormat] = useState(null);
  const [dataScope, setDataScope] = useState(null);
  const [reportType, setReportType] = useState(null);
  const [instructions, setInstructions] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState(null); // { markdown, title, designed }
  const [editing, setEditing] = useState(false);
  const [exportingDocx, setExportingDocx] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [pptPurpose, setPptPurpose] = useState(null);
  const [slideCount, setSlideCount] = useState(8);
  const [pptInstructions, setPptInstructions] = useState("");
  const [generatingPpt, setGeneratingPpt] = useState(false);
  const [pptDraft, setPptDraft] = useState(null); // { slideSpec, title, purpose, slideCount }
  const [exportingPptx, setExportingPptx] = useState(false);
  // [auto-docu 통계분석] 마법사 단계에서 "통계분석" 보고서를 고른 경우의
  // 방법 선택 + 요청사항 — 생성되면 draft.markdown에 서술이 들어가고, 그
  // 뒤로는 기본/분석보고서와 완전히 같은 미리보기·클릭편집·내보내기를 탄다.
  const [statsMethod, setStatsMethod] = useState(null);
  const [statsInstruction, setStatsInstruction] = useState("");
  const [generatingStats, setGeneratingStats] = useState(false);
  // [auto-docu 통계분석] 근거 자료(채팅 답변)에 없는 원자료가 필요하면 파일을
  // 올려서 params 추출 LLM에게 그대로 넘긴다 — "자료 추출하기"가 이미 쓰는
  // 범용 업로드+파싱(collector, PDF·엑셀·워드·HWP 등 지원)을 그대로 재사용.
  const [statsUploadedData, setStatsUploadedData] = useState([]); // [{filename, text}]
  const [statsUploading, setStatsUploading] = useState(false);
  // [auto-docu 통계분석] 새 업로드뿐 아니라 이미 아카이브에 있는 문서도
  // 근거 자료로 고를 수 있게 — PrioritySourcesBar의 아카이브 선택과 같은
  // 패턴(검색+목록)이지만, 한 번에 여러 개를 고를 수 있는 다중 선택.
  const [statsArchiveDocs, setStatsArchiveDocs] = useState([]); // [{id, title}]
  const [showStatsArchivePicker, setShowStatsArchivePicker] = useState(false);
  // [auto-docu 통계분석] 블록별 "통계 분석" 애드혹 요청 — 3a(HTML) 전용,
  // ScopedEditOverlay의 텍스트 입력 옆에 보조 버튼으로 뜬다.
  const [blockStatsMode, setBlockStatsMode] = useState(false);
  const [blockStatsMethod, setBlockStatsMethod] = useState(null);
  // [auto-docu HTML→PPT 연결] "이 내용으로 PPT 만들기" — 원본 채팅 답변
  // 대신, 지금 화면에 있는(통계분석 결과가 반영됐을 수도, 손으로 고쳤을
  // 수도 있는) draft.markdown을 PPT 생성의 근거로 쓴다.
  const [pptSourceOverride, setPptSourceOverride] = useState(null);
  const [panelHeight, setPanelHeight] = useState(() => {
    const stored = Number(localStorage.getItem(PANEL_HEIGHT_STORAGE_KEY));
    return clampPanelHeight(
      stored > 0 ? stored : Math.round(window.innerHeight * 0.5)
    );
  });

  function startResize(event) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panelHeight;
    function onMove(moveEvent) {
      setPanelHeight(
        clampPanelHeight(startHeight - (moveEvent.clientY - startY))
      );
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setPanelHeight((current) => {
        localStorage.setItem(PANEL_HEIGHT_STORAGE_KEY, String(current));
        return current;
      });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const designed = !!draft?.designed;
  const accent = DRAFT_ACCENT[reportType] || DRAFT_ACCENT.basic;
  const comboLabel =
    dataScope && reportType
      ? `${DATA_SCOPE_LABEL[dataScope]} · ${REPORT_TYPE_LABEL[reportType]}`
      : null;
  const headerLabel =
    comboLabel ||
    (dataScope ? DATA_SCOPE_LABEL[dataScope] : null) ||
    (pptPurpose ? `PPT · ${PPT_TEMPLATE_LABEL[pptPurpose]}` : null);
  const displayTitle = draft
    ? extractDraftTitle(draft.markdown, draft.title)
    : "";
  // [auto-docu 화면 편집 Phase 3a] 블록별 data-block-id + 원본 마크다운 위치
  // — 클릭한 블록만 스코프 잡아 대화로 수정하는 데 쓴다.
  const previewData = useMemo(() => {
    if (!draft) return { html: "", blocks: [] };
    const { html, blocks } = draftBodyHtmlBlocks(draft.markdown);
    return { html: DOMPurify.sanitize(html), blocks };
  }, [draft]);
  const previewHtml = previewData.html;
  const previewWrapperRef = useRef(null);
  const [activeBlock, setActiveBlock] = useState(null); // {id, source, startLine, endLine, rect}
  const [blockInstruction, setBlockInstruction] = useState("");
  const [revisingBlock, setRevisingBlock] = useState(false);
  const [blockUndoStack, setBlockUndoStack] = useState([]); // markdown 스냅샷 배열
  // [auto-docu PPT 화면 편집 Phase 3b] PPT 목록 미리보기 쪽의 같은 흐름 —
  // 스타일은 기존 목록 미리보기 그대로 두고, 요소별 클릭 편집만 추가한다.
  const pptPreviewWrapperRef = useRef(null);
  const [pptActiveBlock, setPptActiveBlock] = useState(null); // {id, text, rect}
  const [pptBlockInstruction, setPptBlockInstruction] = useState("");
  const [pptRevisingBlock, setPptRevisingBlock] = useState(false);

  async function generate() {
    if (!dataScope || !reportType) return;
    setGenerating(true);
    setDraft(null);
    setEditing(false);
    const res = await Workspace.generateDraft(workspace.slug, {
      sourceText: source.message,
      citations: source.sources || [],
      dataScope,
      reportType,
      instructions: instructions.trim(),
    });
    setGenerating(false);
    if (res?.error || !res?.draft)
      return showToast(
        res?.error || "초안 생성에 실패했습니다. 다시 시도해 주세요.",
        "error"
      );
    setDraft({
      markdown: res.draft,
      title: res.title || `${comboLabel} 초안`,
      designed: detectDesignRequest(instructions),
    });
    showToast(
      res.externalSourcesUsed
        ? `초안이 생성되었습니다. 외부 자료 ${res.externalSourcesUsed}건을 참고했습니다.`
        : "초안이 생성되었습니다. 필요하면 내용을 직접 수정할 수 있습니다.",
      "success"
    );
  }

  function updateDraftMarkdown(value) {
    setDraft((prev) => (prev ? { ...prev, markdown: value } : prev));
  }

  // [auto-docu 화면 편집 Phase 3a] — 직접 클릭이든 호버 라벨의 "이
  // 부분만"/"전체 블록" 선택이든 이 하나로 처리한다(id+el만 있으면 됨).
  function selectBlock(id, el) {
    if (!el || !previewWrapperRef.current) return;
    const block = previewData.blocks.find((b) => b.id === id);
    if (!block) return;
    const rect = computeRelativeRect(el, previewWrapperRef.current);
    setActiveBlock({ ...block, rect });
    setBlockInstruction("");
    setBlockStatsMode(false);
    setBlockStatsMethod(null);
  }

  function patchMarkdownBlock(markdown, block, revisedText) {
    const lines = markdown.split("\n");
    return [
      ...lines.slice(0, block.startLine),
      revisedText,
      ...lines.slice(block.endLine),
    ].join("\n");
  }

  async function reviseActiveBlock() {
    if (!activeBlock || !blockInstruction.trim() || revisingBlock) return;
    setRevisingBlock(true);
    const res = await Workspace.reviseDraftBlock(workspace.slug, {
      blockMarkdown: activeBlock.source,
      instruction: blockInstruction.trim(),
      surroundingContext: draft.markdown.slice(0, 1500),
    });
    setRevisingBlock(false);
    if (res?.error || !res?.revised) {
      showToast(
        res?.error || "수정에 실패했습니다. 다시 시도해 주세요.",
        "error"
      );
      return;
    }
    setBlockUndoStack((prev) => [...prev, draft.markdown].slice(-10));
    updateDraftMarkdown(
      patchMarkdownBlock(draft.markdown, activeBlock, res.revised)
    );
    setActiveBlock(null);
    setBlockInstruction("");
    showToast("선택한 부분을 수정했습니다.", "success");
  }

  function undoBlockEdit() {
    setBlockUndoStack((prev) => {
      if (!prev.length) return prev;
      updateDraftMarkdown(prev[prev.length - 1]);
      return prev.slice(0, -1);
    });
  }

  // [auto-docu 통계분석] "통계분석" 보고서 유형 — draft.js 대신
  // stats/analyze를 호출한다. 결과(revised 마크다운)를 그대로 draft.markdown
  // 으로 써서, 이후 미리보기/클릭편집/내보내기는 기본/분석보고서와 동일하게
  // 재사용한다(별도 렌더러를 새로 만들지 않음).
  async function generateStatsReport() {
    if (!statsMethod || !statsInstruction.trim()) return;
    setGeneratingStats(true);
    setDraft(null);
    setEditing(false);
    const res = await Workspace.runStatsAnalysis(workspace.slug, {
      instruction: statsInstruction.trim(),
      method: statsMethod,
      sourceText: source.message,
      uploadedData: statsUploadedData,
      archiveDocIds: statsArchiveDocs.map((d) => d.id),
    });
    setGeneratingStats(false);
    if (res?.error || !res?.revised)
      return showToast(
        res?.error || "통계 분석에 실패했습니다. 다시 시도해 주세요.",
        "error"
      );
    setDraft({
      markdown: res.revised,
      title: `${res.methodLabel || "통계분석"} 결과`,
      designed: false,
    });
    showToast(
      `${res.methodLabel} 분석이 완료되었습니다(실제 계산 기반). 필요하면 내용을 직접 수정할 수 있습니다.`,
      "success"
    );
  }

  // 블록별 애드혹 "통계 분석" — 선택한 블록 자리에 통계 서술을 끼워 넣는다.
  // patchMarkdownBlock으로 같은 라인 스플라이스 패치를 재사용한다.
  async function runBlockStatsAnalysis() {
    if (
      !activeBlock ||
      !blockStatsMethod ||
      !blockInstruction.trim() ||
      revisingBlock
    )
      return;
    setRevisingBlock(true);
    const res = await Workspace.runStatsAnalysis(workspace.slug, {
      instruction: blockInstruction.trim(),
      method: blockStatsMethod,
      sourceText: source.message,
      surroundingContext: draft.markdown.slice(0, 1500),
    });
    setRevisingBlock(false);
    if (res?.error || !res?.revised) {
      showToast(
        res?.error || "통계 분석에 실패했습니다. 다시 시도해 주세요.",
        "error"
      );
      return;
    }
    setBlockUndoStack((prev) => [...prev, draft.markdown].slice(-10));
    updateDraftMarkdown(
      patchMarkdownBlock(draft.markdown, activeBlock, res.revised)
    );
    setActiveBlock(null);
    setBlockInstruction("");
    setBlockStatsMode(false);
    setBlockStatsMethod(null);
    showToast(`${res.methodLabel} 분석 결과를 반영했습니다.`, "success");
  }

  // [auto-docu PPT 화면 편집 Phase 3b] 기존 PPT 목록 미리보기의 요소(제목/
  // 불릿/표 셀 — 항목 단위)와 그걸 감싸는 블록 전체(불릿 목록 전체, 표
  // 전체 — 블록 단위)를 둘 다 선택할 수 있다. data-block-text는 항목 단위
  // 요소엔 그 항목 텍스트, 블록 단위 요소(ul/table)엔 blockTextFor로 만든
  // 직렬화 텍스트가 미리 박혀 있다.
  function selectPptBlock(id, el) {
    if (!el || !pptPreviewWrapperRef.current) return;
    const text = el.getAttribute("data-block-text") || "";
    const rect = computeRelativeRect(el, pptPreviewWrapperRef.current);
    setPptActiveBlock({ id, text, rect });
    setPptBlockInstruction("");
  }

  async function revisePptActiveBlock() {
    if (!pptActiveBlock || !pptBlockInstruction.trim() || pptRevisingBlock)
      return;
    setPptRevisingBlock(true);
    const res = await Workspace.reviseDraftBlock(workspace.slug, {
      blockMarkdown: pptActiveBlock.text,
      instruction: pptBlockInstruction.trim(),
    });
    setPptRevisingBlock(false);
    if (res?.error || !res?.revised) {
      showToast(
        res?.error || "수정에 실패했습니다. 다시 시도해 주세요.",
        "error"
      );
      return;
    }
    setPptDraft((prev) =>
      prev
        ? {
            ...prev,
            slideSpec: patchSlideSpec(
              prev.slideSpec,
              pptActiveBlock.id,
              res.revised
            ),
          }
        : prev
    );
    setPptActiveBlock(null);
    setPptBlockInstruction("");
    showToast("선택한 부분을 수정했습니다.", "success");
  }

  function archiveDraftInBackground() {
    // [auto-docu 내부생성자료] 다운로드와 별개로 백그라운드에서 아카이빙 —
    // 실패해도 다운로드 자체엔 영향 없음(await 안 함).
    Workspace.archiveGenerated(workspace.slug, {
      title: draft.title,
      markdown: draft.markdown,
      kind: "draft",
    }).then((res) => {
      if (res?.success)
        showToast(
          "내부생성자료 폴더에 보관했습니다(검수 후 검색에 반영).",
          "info"
        );
    });
    // [auto-docu 문서 연계성 학습] 이 답변이 여러 문서를 같이 인용했고,
    // 지금 실제로 결과물 다운로드까지 이어졌다 — "검증된 연계"로 기록한다.
    const citedDocIds = [
      ...new Set((source.sources || []).map((s) => s.doc_id).filter(Boolean)),
    ];
    if (citedDocIds.length > 1)
      Workspace.recordValidatedAffinity(workspace.slug, {
        docIds: citedDocIds,
      });
  }

  function downloadHtml() {
    if (!draft) return;
    downloadDraftHtml({
      markdown: draft.markdown,
      title: draft.title,
      modeLabel: comboLabel,
      reportType,
      designed,
    });
    showToast("HTML 파일을 내려받았습니다.", "success");
    archiveDraftInBackground();
  }

  async function downloadDocx() {
    if (!draft || exportingDocx) return;
    setExportingDocx(true);
    const res = await Workspace.downloadAsDocx({
      title: extractDraftTitle(draft.markdown, draft.title),
      markdown: draft.markdown,
    });
    setExportingDocx(false);
    if (!res?.success)
      return showToast(res?.error || "DOCX 다운로드에 실패했습니다.", "error");
    showToast("DOCX 파일을 내려받았습니다.", "success");
    archiveDraftInBackground();
  }

  async function downloadXlsx() {
    if (!draft || exportingXlsx) return;
    setExportingXlsx(true);
    const res = await Workspace.downloadAsXlsx({
      title: extractDraftTitle(draft.markdown, draft.title),
      markdown: draft.markdown,
    });
    setExportingXlsx(false);
    if (!res?.success)
      return showToast(res?.error || "XLSX 다운로드에 실패했습니다.", "error");
    showToast("XLSX 파일을 내려받았습니다.", "success");
    archiveDraftInBackground();
  }

  // [auto-docu PPT 생성 Phase 1] pptSourceOverride가 있으면(HTML→PPT 연결로
  // 넘어온 경우) 원본 채팅 답변 대신 그 문서 초안 내용을 근거로 쓴다.
  async function generatePpt() {
    if (!pptPurpose) return;
    setGeneratingPpt(true);
    setPptDraft(null);
    const res = await Workspace.generatePptDraft(workspace.slug, {
      sourceText: pptSourceOverride || source.message,
      citations: pptSourceOverride ? [] : source.sources || [],
      purpose: pptPurpose,
      slideCount,
      instructions: pptInstructions.trim(),
    });
    setGeneratingPpt(false);
    if (res?.error || !res?.slideSpec)
      return showToast(
        res?.error || "PPT 생성에 실패했습니다. 다시 시도해 주세요.",
        "error"
      );
    setPptDraft(res);
    showToast(
      "PPT 초안이 생성되었습니다. 아래에서 슬라이드를 확인하세요.",
      "success"
    );
    if (res.warning) showToast(res.warning, "warning");
  }

  function archivePptInBackground() {
    if (!pptDraft?.slideSpec) return;
    // [auto-docu 내부생성자료] 문서 초안과 같은 게이트 — "제안" 상태로만
    // 넣고 검수 전에는 검색에 노출되지 않는다. 마크다운 본문은 슬라이드
    // 내용을 간단히 개요화한 텍스트(실제 파일은 pptx이지만 아카이브
    // 색인은 markdown 텍스트만 받으므로).
    const outline = pptDraft.slideSpec.slides
      .map((s, i) => {
        const body = s.table
          ? [
              s.table.headers.join(" | "),
              ...s.table.rows.map((r) => r.join(" | ")),
            ].join("\n")
          : (s.content || []).map((c) => `- ${c}`).join("\n");
        return `## ${i + 1}. ${s.title || ""}\n${body}`;
      })
      .join("\n\n");
    Workspace.archiveGenerated(workspace.slug, {
      title: pptDraft.title,
      markdown: `# ${pptDraft.title}\n\n${outline}`,
      kind: "ppt_draft",
    }).then((res) => {
      if (res?.success)
        showToast(
          "내부생성자료 폴더에 보관했습니다(검수 후 검색에 반영).",
          "info"
        );
    });
  }

  async function downloadPptx() {
    if (!pptDraft?.slideSpec || exportingPptx) return;
    setExportingPptx(true);
    const res = await Workspace.downloadAsPptx({
      slideSpec: pptDraft.slideSpec,
    });
    setExportingPptx(false);
    if (!res?.success)
      return showToast(res?.error || "PPTX 다운로드에 실패했습니다.", "error");
    showToast("PPTX 파일을 내려받았습니다.", "success");
    archivePptInBackground();
  }

  return (
    <div
      className="flex shrink-0 flex-col bg-white light:bg-white dark:bg-zinc-950"
      style={{ height: panelHeight }}
    >
      {/* 크기 조절 핸들 */}
      <div
        onMouseDown={startResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="문서 초안 패널 크기 조절"
        className="h-1.5 shrink-0 cursor-ns-resize bg-blue-500/40 hover:bg-blue-500/70 active:bg-blue-500"
      />
      {/* 헤더 */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-zinc-100">
          <Sparkle size={16} weight="fill" className="text-blue-500" />
          Reporting
          {headerLabel && (
            <span
              className="rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
              style={{
                borderColor: `${accent.accent}40`,
                color: accent.accent,
              }}
            >
              {headerLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {draft && !generating && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-300"
            >
              {editing ? (
                <>
                  <Eye size={12} /> 미리보기
                </>
              ) : (
                <>
                  <PencilSimple size={12} /> 내용 수정
                </>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-zinc-800"
            aria-label="초안 패널 닫기"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* 본문 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* 0단계: 무엇을 만들지 선택 */}
        {!outputFormat && (
          <div className="mx-auto flex max-w-xl flex-col gap-3 py-2">
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              위 답변을 바탕으로 무엇을 만들까요?
            </p>
            <button
              type="button"
              onClick={() => setOutputFormat("doc")}
              className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-zinc-100">
                <FileDoc size={15} weight="fill" className="text-blue-600" />
                문서 (보고서)
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
                목적/배경/현황 구조의 텍스트 보고서를 만듭니다. HTML·DOCX로
                내려받습니다.
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setPptSourceOverride(null);
                setOutputFormat("ppt");
              }}
              className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-zinc-100">
                <Presentation
                  size={15}
                  weight="fill"
                  className="text-blue-600"
                />
                PPT (프레젠테이션)
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
                목적에 맞는 슬라이드 흐름으로 PPT 초안을 만듭니다. PPTX로
                내려받습니다.
              </span>
            </button>
          </div>
        )}

        {/* 1단계: 자료 범위 선택 */}
        {outputFormat === "doc" && !dataScope && (
          <div className="mx-auto flex max-w-xl flex-col gap-3 py-2">
            <button
              type="button"
              onClick={() => setOutputFormat(null)}
              className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              <ArrowLeft size={12} /> 다른 형식 선택
            </button>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              위 답변을 바탕으로 문서를 만듭니다. 먼저 어떤 자료를 근거로 쓸지
              골라주세요.
            </p>
            {DATA_SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setDataScope(s.key)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
              >
                <span className="block text-sm font-semibold text-slate-800 dark:text-zinc-100">
                  {s.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
                  {s.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 2단계: 문서 유형 선택 — 1단계 선택에 따라 설명이 달라진다 */}
        {dataScope && !reportType && (
          <div className="mx-auto flex max-w-xl flex-col gap-3 py-2">
            <button
              type="button"
              onClick={() => setDataScope(null)}
              className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              <ArrowLeft size={12} /> 자료 범위 다시 선택
            </button>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              어떤 형태의 문서로 만들까요? 사실 내용은 그대로 두고 형식과 표현만
              다듬습니다.
            </p>
            {REPORT_TYPES[dataScope].map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setReportType(r.key)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
              >
                <span className="block text-sm font-semibold text-slate-800 dark:text-zinc-100">
                  {r.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
                  {r.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 3단계(통계분석): 방법 선택 + 분석 요청 */}
        {dataScope && reportType === "stats" && !draft && !generatingStats && (
          <div className="mx-auto flex max-w-5xl flex-col gap-3 py-2">
            <button
              type="button"
              onClick={() => setReportType(null)}
              className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              <ArrowLeft size={12} /> 문서 유형 다시 선택
            </button>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              통계 방법을 고르세요. 실제 계산(scikit-learn/statsmodels)을 거친
              결과만 서술로 옮깁니다 — 방법을 모르면 "미정"을 고르면 목적에 맞춰
              자동으로 골라 줍니다.
            </p>
            <StatsMethodPicker
              selected={statsMethod}
              onSelect={setStatsMethod}
            />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                분석 요청 사항
              </span>
              <textarea
                value={statsInstruction}
                onChange={(e) => setStatsInstruction(e.target.value)}
                rows={3}
                placeholder="예: 월별 매출과 광고비 데이터로 광고비가 매출에 미치는 영향을 분석해줘"
                className="resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-800 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                추가 자료 업로드 (선택)
              </span>
              <span className="text-[11px] text-slate-500 dark:text-zinc-500">
                답변 내용에 분석에 필요한 원자료가 부족하면 파일을 올려주세요
                (PDF·엑셀·워드·HWP 등 — 이번 분석에만 쓰고 아카이브에는 저장되지
                않습니다).
              </span>
              <input
                type="file"
                multiple
                disabled={statsUploading}
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  if (!files.length) return;
                  e.target.value = "";
                  setStatsUploading(true);
                  for (const file of files) {
                    const res = await Workspace.uploadExtractFile(
                      workspace.slug,
                      file
                    );
                    if (res?.error || !res?.pageContent) {
                      showToast(
                        `${file.name}: ${res?.error || "파일을 읽지 못했습니다."}`,
                        "error"
                      );
                      continue;
                    }
                    setStatsUploadedData((prev) => [
                      ...prev,
                      {
                        filename: res.title || file.name,
                        text: res.pageContent,
                      },
                    ]);
                    showToast(`${file.name}을 불러왔습니다.`, "success");
                  }
                  setStatsUploading(false);
                }}
                className="text-[11px] text-slate-500 disabled:opacity-50 dark:text-zinc-400"
              />
              {statsUploading && (
                <span className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-zinc-400">
                  <CircleNotch size={12} className="animate-spin" />
                  파일 읽는 중…
                </span>
              )}
              {statsUploadedData.length > 0 && (
                <div className="flex flex-col gap-1">
                  {statsUploadedData.map((f, idx) => (
                    <span
                      key={`${f.filename}-${idx}`}
                      className="flex items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400"
                    >
                      {f.filename}
                      <button
                        type="button"
                        onClick={() =>
                          setStatsUploadedData((prev) =>
                            prev.filter((_, i) => i !== idx)
                          )
                        }
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setShowStatsArchivePicker(true)}
                className="flex w-fit items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-500 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-400"
              >
                <FolderOpen size={12} /> 아카이브에서 선택
              </button>
              {statsArchiveDocs.length > 0 && (
                <div className="flex flex-col gap-1">
                  {statsArchiveDocs.map((d) => (
                    <span
                      key={d.id}
                      className="flex items-center gap-1.5 text-[11px] text-violet-600 dark:text-violet-400"
                    >
                      {d.title}
                      <button
                        type="button"
                        onClick={() =>
                          setStatsArchiveDocs((prev) =>
                            prev.filter((x) => x.id !== d.id)
                          )
                        }
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </label>
            {showStatsArchivePicker && (
              <StatsArchiveDocPickerModal
                workspace={workspace}
                alreadyPicked={statsArchiveDocs}
                onClose={() => setShowStatsArchivePicker(false)}
                onConfirm={(docs) => {
                  setStatsArchiveDocs((prev) => {
                    const merged = [...prev];
                    for (const d of docs) {
                      if (!merged.some((x) => x.id === d.id)) merged.push(d);
                    }
                    return merged;
                  });
                  setShowStatsArchivePicker(false);
                }}
              />
            )}
            <button
              type="button"
              onClick={generateStatsReport}
              disabled={!statsMethod || !statsInstruction.trim()}
              className="flex w-fit items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkle size={14} weight="fill" /> 분석 시작
            </button>
          </div>
        )}

        {/* 3단계: 추가 요청 + 생성 */}
        {dataScope &&
          reportType &&
          reportType !== "stats" &&
          !draft &&
          !generating && (
            <div className="mx-auto flex max-w-xl flex-col gap-3 py-2">
              <button
                type="button"
                onClick={() => setReportType(null)}
                className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
              >
                <ArrowLeft size={12} /> 문서 유형 다시 선택
              </button>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                  추가 요청 사항 (선택)
                </span>
                <span className="text-[11px] text-slate-500 dark:text-zinc-500">
                  기본은 텍스트 중심으로 만들어지고, "디자인 요소를
                  추가해줘"처럼 요청하면 색이 들어간 스타일로 만들어 드립니다.
                </span>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={4}
                  placeholder="예: 색상 강조 같은 디자인 요소를 추가해줘 / A4 1장 분량으로 / 핵심만 간결하게 / 수신처는 OO부"
                  className="resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-800 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>
              <button
                type="button"
                onClick={generate}
                className="flex w-fit items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
              >
                <Sparkle size={14} weight="fill" /> 초안 생성
              </button>
            </div>
          )}

        {/* 통계 분석 중 */}
        {generatingStats && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500 dark:text-zinc-400">
            <CircleNotch size={22} className="animate-spin" />
            <p className="text-xs">실제 통계 계산 중입니다...</p>
          </div>
        )}

        {/* 생성 중 */}
        {generating && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500 dark:text-zinc-400">
            <CircleNotch size={22} className="animate-spin" />
            <p className="text-xs">{comboLabel} 초안을 작성하고 있습니다…</p>
            {dataScope === "answer_plus_web" && (
              <p className="text-[11px] text-slate-500 dark:text-zinc-500">
                외부 자료를 검색하고 있어 조금 더 걸릴 수 있습니다.
              </p>
            )}
          </div>
        )}

        {/* 결과: 미리보기(디자인 적용) 또는 편집 */}
        {draft && !generating && (
          <div className="mx-auto max-w-7xl">
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setEditing(false);
              }}
              className="mb-2 flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              <ArrowLeft size={12} /> 요청 수정 / 다시 생성
            </button>

            {editing ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                  마크다운으로 직접 수정합니다. 첫 줄의{" "}
                  <code className="rounded bg-slate-100 px-1 dark:bg-zinc-800">
                    #
                  </code>{" "}
                  은 제목,{" "}
                  <code className="rounded bg-slate-100 px-1 dark:bg-zinc-800">
                    ##
                  </code>{" "}
                  은 소제목입니다.
                </p>
                <textarea
                  value={draft.markdown}
                  onChange={(e) => updateDraftMarkdown(e.target.value)}
                  rows={16}
                  className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs leading-5 text-slate-800 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            ) : (
              <>
                {designed && (
                  <DraftCover
                    label={comboLabel}
                    title={displayTitle}
                    accent={accent}
                  />
                )}
                <style>{`
                  .draft-preview [data-block-id] { cursor: pointer; }
                `}</style>
                <p className="mb-1.5 text-[11px] text-slate-500 dark:text-zinc-500">
                  원하는 부분에 마우스를 올리면 수정할 수 있는 범위가 보입니다.
                  목록 항목처럼 더 큰 블록에 속한 부분은 항목만 또는 전체 블록을
                  골라 수정할 수 있습니다.
                </p>
                <ScopedEditOverlay
                  containerRef={previewWrapperRef}
                  onSelect={selectBlock}
                  activeId={activeBlock?.id || null}
                  activeRect={activeBlock?.rect || null}
                  previewText={activeBlock?.source || ""}
                  value={blockInstruction}
                  onChange={setBlockInstruction}
                  onSubmit={
                    blockStatsMode ? runBlockStatsAnalysis : reviseActiveBlock
                  }
                  submitting={revisingBlock}
                  onClose={() => {
                    setActiveBlock(null);
                    setBlockStatsMode(false);
                    setBlockStatsMethod(null);
                  }}
                  submitLabel={blockStatsMode ? "분석 실행" : "수정"}
                  submitDisabled={blockStatsMode && !blockStatsMethod}
                  placeholder={
                    blockStatsMode
                      ? "예: 월별 매출 추세를 분석해줘"
                      : "예: 더 간결하게"
                  }
                  extraButton={{
                    label: blockStatsMode ? "일반 수정으로" : "통계 분석",
                    onClick: () => setBlockStatsMode((v) => !v),
                    active: blockStatsMode,
                  }}
                  extraContent={
                    blockStatsMode && (
                      <StatsMethodPicker
                        selected={blockStatsMethod}
                        onSelect={setBlockStatsMethod}
                      />
                    )
                  }
                >
                  <div
                    className={`draft-preview rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm leading-7 text-slate-800 ${
                      designed ? "designed rounded-t-none border-t-0" : ""
                    }`}
                    style={
                      designed
                        ? {
                            "--accent": accent.accent,
                            "--accent-soft": accent.accentSoft,
                            "--accent-dark": accent.accentDark,
                          }
                        : undefined
                    }
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                </ScopedEditOverlay>
                {blockUndoStack.length > 0 && !activeBlock && (
                  <button
                    type="button"
                    onClick={undoBlockEdit}
                    className="mt-2 flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
                  >
                    <ArrowLeft size={11} /> 방금 수정 취소
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* PPT 1단계: 목적 선택 */}
        {outputFormat === "ppt" && !pptPurpose && (
          <div className="mx-auto flex max-w-xl flex-col gap-3 py-2">
            <button
              type="button"
              onClick={() => setOutputFormat(null)}
              className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              <ArrowLeft size={12} /> 다른 형식 선택
            </button>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              어떤 목적의 PPT인가요? 목적에 맞는 슬라이드 흐름으로 초안을
              만듭니다.
            </p>
            {pptSourceOverride && (
              <p className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
                방금 만든 문서 초안 내용을 근거로 사용합니다(원본 채팅 답변
                대신).
              </p>
            )}
            {PPT_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setPptPurpose(t.key)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
              >
                <span className="block text-sm font-semibold text-slate-800 dark:text-zinc-100">
                  {t.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
                  {t.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* PPT 2단계: 페이지 수 + 추가 요청 + 생성 */}
        {outputFormat === "ppt" &&
          pptPurpose &&
          !pptDraft &&
          !generatingPpt && (
            <div className="mx-auto flex max-w-xl flex-col gap-3 py-2">
              <button
                type="button"
                onClick={() => setPptPurpose(null)}
                className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
              >
                <ArrowLeft size={12} /> 목적 다시 선택
              </button>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                  페이지 수 (표지 제외)
                </span>
                <input
                  type="number"
                  min={MIN_SLIDE_COUNT}
                  max={MAX_SLIDE_COUNT}
                  value={slideCount}
                  onChange={(e) =>
                    setSlideCount(
                      Math.min(
                        MAX_SLIDE_COUNT,
                        Math.max(
                          MIN_SLIDE_COUNT,
                          Number(e.target.value) || MIN_SLIDE_COUNT
                        )
                      )
                    )
                  }
                  className="w-24 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                />
                <span className="text-[11px] text-slate-500 dark:text-zinc-500">
                  {MIN_SLIDE_COUNT}~{MAX_SLIDE_COUNT}장 사이로 조절할 수
                  있습니다.
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                  추가 요청 사항 (선택)
                </span>
                <span className="text-[11px] text-slate-500 dark:text-zinc-500">
                  페이지별로 꼭 들어갔으면 하는 내용이나 흐름을 적어주세요.
                </span>
                <textarea
                  value={pptInstructions}
                  onChange={(e) => setPptInstructions(e.target.value)}
                  rows={4}
                  placeholder="예: 표지 다음에 배경 슬라이드를 먼저 넣어줘 / 3번째 슬라이드는 표로 정리해줘"
                  className="resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-800 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>
              <button
                type="button"
                onClick={generatePpt}
                className="flex w-fit items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
              >
                <Sparkle size={14} weight="fill" /> PPT 초안 생성
              </button>
            </div>
          )}

        {/* PPT 생성 중 */}
        {generatingPpt && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500 dark:text-zinc-400">
            <CircleNotch size={22} className="animate-spin" />
            <p className="text-xs">
              {PPT_TEMPLATE_LABEL[pptPurpose]} PPT 초안을 작성하고 있습니다…
            </p>
          </div>
        )}

        {/* PPT 결과: 슬라이드별 구조화 미리보기 */}
        {pptDraft && !generatingPpt && (
          <div className="mx-auto flex max-w-7xl flex-col gap-3">
            <button
              type="button"
              onClick={() => setPptDraft(null)}
              className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              <ArrowLeft size={12} /> 요청 수정 / 다시 생성
            </button>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
              {pptDraft.title}
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-zinc-500">
              원하는 부분에 마우스를 올리면 수정할 수 있는 범위가 보입니다. 불릿
              하나/표 칸 하나만, 또는 불릿 목록 전체/표 전체를 골라 수정할 수
              있습니다.
            </p>
            <style>{`
              .ppt-list-preview [data-block-id] { cursor: pointer; }
            `}</style>
            <ScopedEditOverlay
              containerRef={pptPreviewWrapperRef}
              className="ppt-list-preview flex flex-col gap-3"
              onSelect={selectPptBlock}
              activeId={pptActiveBlock?.id || null}
              activeRect={pptActiveBlock?.rect || null}
              previewText={pptActiveBlock?.text || ""}
              value={pptBlockInstruction}
              onChange={setPptBlockInstruction}
              onSubmit={revisePptActiveBlock}
              submitting={pptRevisingBlock}
              onClose={() => setPptActiveBlock(null)}
            >
              {pptDraft.slideSpec.slides.map((slide, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-slate-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded-md border border-blue-200 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:border-blue-900 dark:text-blue-400">
                      {i + 1} / {slide.layout === "section" ? "구분" : "내용"}
                    </span>
                    <span
                      data-block-id={`${i}.title`}
                      data-block-text={slide.title || ""}
                      className="text-sm font-semibold text-slate-800 dark:text-zinc-100"
                    >
                      {slide.title}
                    </span>
                  </div>
                  {slide.subtitle && (
                    <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                      {slide.subtitle}
                    </p>
                  )}
                  {Array.isArray(slide.content) && slide.content.length > 0 && (
                    <ul
                      data-block-id={`${i}.content`}
                      data-block-text={blockTextFor(slide, "content")}
                      className="mt-2 list-disc space-y-1 rounded px-5 py-1 text-xs leading-5 text-slate-700 dark:text-zinc-300"
                    >
                      {slide.content.map((c, ci) => (
                        <li
                          key={ci}
                          data-block-id={`${i}.bullet.${ci}`}
                          data-block-text={c}
                        >
                          {c}
                        </li>
                      ))}
                    </ul>
                  )}
                  {slide.table && (
                    <div
                      data-block-id={`${i}.table`}
                      data-block-text={blockTextFor(slide, "table")}
                      className="mt-2 overflow-x-auto rounded p-1"
                    >
                      <table className="w-full border-collapse text-xs">
                        <thead>
                          <tr>
                            {slide.table.headers.map((h, hi) => (
                              <th
                                key={hi}
                                data-block-id={`${i}.header.${hi}`}
                                data-block-text={h}
                                className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold text-slate-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {slide.table.rows.map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td
                                  key={ci}
                                  data-block-id={`${i}.cell.${ri}.${ci}`}
                                  data-block-text={cell}
                                  className="border border-slate-200 px-2 py-1 text-slate-600 dark:border-zinc-800 dark:text-zinc-400"
                                >
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {slide.chart && (
                    <div
                      data-block-id={`${i}.chart`}
                      data-block-text={blockTextFor(slide, "chart")}
                      className="mt-2 rounded border border-dashed border-blue-300 bg-blue-50/50 px-3 py-2 text-xs text-slate-600 dark:border-blue-900 dark:bg-blue-950/20 dark:text-zinc-300"
                    >
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                        {CHART_TYPE_LABEL[slide.chart.type] || "차트"}
                      </span>
                      <span className="ml-1.5">
                        {(slide.chart.categories || []).join(", ")}
                        {slide.chart.series?.length
                          ? ` · ${slide.chart.series
                              .map((s) => s.name)
                              .filter(Boolean)
                              .join(", ")}`
                          : ""}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </ScopedEditOverlay>
          </div>
        )}
      </div>

      {/* 다운로드 바 */}
      {draft && !generating && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-2.5 dark:border-zinc-800">
          <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">
            내보내기
          </span>
          <button
            type="button"
            onClick={downloadHtml}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            <FileHtml size={15} weight="fill" /> HTML 다운로드
          </button>
          <button
            type="button"
            onClick={downloadDocx}
            disabled={exportingDocx}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
          >
            {exportingDocx ? (
              <CircleNotch size={15} className="animate-spin" />
            ) : (
              <FileDoc size={15} weight="fill" />
            )}
            DOCX 다운로드
          </button>
          <button
            type="button"
            onClick={downloadXlsx}
            disabled={exportingXlsx}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
          >
            {exportingXlsx ? (
              <CircleNotch size={15} className="animate-spin" />
            ) : (
              <FileXls size={15} weight="fill" />
            )}
            XLSX 다운로드
          </button>
          <button
            type="button"
            onClick={() => {
              setPptSourceOverride(draft.markdown);
              setPptDraft(null);
              setPptPurpose(null);
              setOutputFormat("ppt");
            }}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-300"
          >
            <Presentation size={15} weight="fill" /> 이 내용으로 PPT 만들기
          </button>
        </div>
      )}
      {pptDraft && !generatingPpt && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-2.5 dark:border-zinc-800">
          <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">
            내보내기
          </span>
          <button
            type="button"
            onClick={downloadPptx}
            disabled={exportingPptx}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exportingPptx ? (
              <CircleNotch size={15} className="animate-spin" />
            ) : (
              <FilePpt size={15} weight="fill" />
            )}
            PPTX 다운로드
          </button>
        </div>
      )}
    </div>
  );
}

/** 다운로드되는 HTML의 표지 배너와 같은 모양을 패널 안에서 미리 보여준다. */
function DraftCover({ label, title, accent }) {
  return (
    <div
      className="rounded-t-lg px-5 py-4 text-white"
      style={{
        background: `linear-gradient(135deg, ${accent.accent}, ${accent.accentDark})`,
      }}
    >
      <span className="inline-flex items-center rounded-full bg-white/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
        {label || "문서 초안"}
      </span>
      <h3 className="mt-1.5 text-base font-extrabold leading-snug">{title}</h3>
      <p className="mt-0.5 text-[11px] text-white/80">
        {new Date().toLocaleString("ko-KR")} · Recode
      </p>
    </div>
  );
}

// [auto-docu 통계분석] 아카이브 문서 다중 선택 — PrioritySourcesBar의
// 아카이브-선택 화면과 같은 검색+목록 패턴이지만, 체크박스로 여러 개를
// 한 번에 고르고 "선택 완료"를 눌러야 확정된다(우선 자료는 하나씩 바로
// 반영되지만, 이건 통계 분석 요청 하나에 여러 문서를 함께 쓰는 경우가
// 많아 다중 선택이 더 자연스럽다).
function StatsArchiveDocPickerModal({
  workspace,
  alreadyPicked,
  onClose,
  onConfirm,
}) {
  const [documents, setDocuments] = useState([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    Workspace.bySlug(workspace.slug).then((ws) => {
      setDocuments(Array.isArray(ws?.documents) ? ws.documents : []);
    });
  }, [workspace.slug]);

  function docTitleOf(doc) {
    try {
      return JSON.parse(doc?.metadata || "{}").title || doc?.filename || "문서";
    } catch {
      return doc?.filename || "문서";
    }
  }

  const alreadyPickedIds = useMemo(
    () => new Set(alreadyPicked.map((d) => d.id)),
    [alreadyPicked]
  );

  const filteredDocuments = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? documents.filter((d) => docTitleOf(d).toLowerCase().includes(q))
      : documents;
    return list.filter((d) => !alreadyPickedIds.has(d.id));
  }, [documents, query, alreadyPickedIds]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    const docs = documents
      .filter((d) => selected.has(d.id))
      .map((d) => ({ id: d.id, title: docTitleOf(d) }));
    onConfirm(docs);
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <ModalHeader
        title="아카이브에서 선택"
        subtitle="이번 분석에만 근거 자료로 쓰입니다(별도로 다시 저장되지 않습니다)."
        onClose={onClose}
      />
      <ModalBody>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="문서 이름으로 찾기"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 dark:border-zinc-800">
            {filteredDocuments.length === 0 && (
              <p className="p-3 text-xs text-slate-400 dark:text-zinc-600">
                문서를 찾을 수 없습니다.
              </p>
            )}
            {filteredDocuments.map((doc) => (
              <label
                key={doc.id}
                className="flex w-full cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-blue-50 dark:border-zinc-800 dark:hover:bg-blue-950/20"
              >
                <input
                  type="checkbox"
                  checked={selected.has(doc.id)}
                  onChange={() => toggle(doc.id)}
                />
                <span className="truncate">{docTitleOf(doc)}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={handleConfirm}
            className="flex w-fit items-center gap-1.5 self-end rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            선택 완료{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>
      </ModalBody>
    </Modal>
  );
}
