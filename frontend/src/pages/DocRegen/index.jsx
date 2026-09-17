// [auto-docu 전사문서작성tool] 정기 문서 갱신 작성 — 작년(기준) 문서를
// 양식/구조로 삼아, 신규 기준/가이던스에 맞춰 아카이브 전체에서 근거를
// 찾아 절별로 다시 채워 넣는다. 근거가 부족한 절은 "[자료 필요: ...]"로
// 표시되고, 클릭하면 근거(신규 기준)와 과거 참고자료를 보여준다.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Buildings,
  CaretDown,
  CaretRight,
  CheckCircle,
  CheckSquare,
  CircleNotch,
  Circle,
  DownloadSimple,
  FileDoc,
  FileHtml,
  FileXls,
  FileText,
  FilePpt,
  Folder,
  Presentation,
  Sparkle,
  Square,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import paths from "@/utils/paths";
import Workspace from "@/models/workspace";
import Classification from "@/models/classification";
import DOMPurify from "@/utils/chat/purify";
import showToast from "@/utils/toast";
import ScopedEditOverlay, {
  computeRelativeRect,
} from "@/components/WorkspaceChat/ChatContainer/DraftPanel/ScopedEditOverlay";
import {
  patchSlideSpec,
  blockTextFor,
} from "@/components/WorkspaceChat/ChatContainer/DraftPanel/pptSlideSpecPatch";
import {
  resultBodyHtml,
  linkifyNeedsMarkers,
  downloadDocRegenHtml,
  downloadRequestSheet,
} from "./exporters";

const STATUS_LABEL = { keep: "유지", update: "갱신", new: "신규" };
const CHART_TYPE_LABEL = {
  bar: "막대 그래프",
  line: "선 그래프",
  pie: "원형 그래프",
};
const STATUS_STYLE = {
  keep: "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400",
  update:
    "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  new: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
};

// [auto-docu PPT 생성 Phase 2] server/endpoints/pptDraft.js의 PPT_TEMPLATES와
// 라벨을 맞춘 프론트엔드 전용 목록.
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
const PPT_MIN_SLIDES = 4;
const PPT_MAX_SLIDES = 20;

function docTitleOf(doc) {
  try {
    return JSON.parse(doc?.metadata || "{}").title || doc?.filename || "문서";
  } catch {
    return doc?.filename || "문서";
  }
}

function docContentHashOf(doc) {
  try {
    return JSON.parse(doc?.metadata || "{}").content_hash || null;
  } catch {
    return null;
  }
}

export default function DocRegen() {
  const { slug = "archive-full" } = useParams();
  const [step, setStep] = useState("name"); // name | template | baseDoc | guidance | folder | progress | result | ppt
  const [title, setTitle] = useState("");
  const [documents, setDocuments] = useState([]);
  const [docQuery, setDocQuery] = useState("");
  const [baseDocs, setBaseDocs] = useState([]); // [{id, title, contentHash}] — 중복 선택 가능
  // [auto-docu 전사문서작성tool v2] 빈양식 — 있으면 목차/구조의 원천이 이
  // 서식으로 바뀌고(baseDocs는 참고용/선택 사항이 됨), null이면 기존과 동일.
  const [blankForm, setBlankForm] = useState(null); // {title, pageContent, blocks, contentHash}
  const [uploadingTemplate, setUploadingTemplate] = useState(false);
  const [classificationsByHash, setClassificationsByHash] = useState({});
  const [guidanceText, setGuidanceText] = useState("");
  const [guidanceFileName, setGuidanceFileName] = useState(null);
  const [uploadingGuidance, setUploadingGuidance] = useState(false);
  // [auto-docu 전사문서작성tool v2] 미리 자료를 모아둔 문서함 폴더 — 여러 개
  // 겹쳐서(work: 상위 폴더 + 다른 workType의 unit: 하위 폴더 등) 고를 수
  // 있다. 비어 있으면(또는 "전체" 포함) 아카이브 전체에서 검색한다.
  const [selectedFolders, setSelectedFolders] = useState([]);
  const [expandedWork, setExpandedWork] = useState(() => new Set());

  const [plan, setPlan] = useState([]); // [{title, status}]
  const [sections, setSections] = useState([]); // 채워지는 대로 index별로 들어감
  const [activeIndex, setActiveIndex] = useState(null);
  const [result, setResult] = useState(null); // {title, sections, markdown}
  const [error, setError] = useState(null);
  const [detailNeed, setDetailNeed] = useState(null); // {description, section}
  const [exportingDocx, setExportingDocx] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [exportingTemplate, setExportingTemplate] = useState(false);
  // [auto-docu PPT 생성 Phase 2] 문서 채우기와 별개의 산출물 — 폴더 지정 →
  // PPT 생성. selectedFolders/folderTree는 위 문서함 폴더 흐름과 공유한다.
  const [pptPurpose, setPptPurpose] = useState(null);
  const [pptSlideCount, setPptSlideCount] = useState(8);
  const [pptInstructions, setPptInstructions] = useState("");
  const [generatingPpt, setGeneratingPpt] = useState(false);
  const [pptDraft, setPptDraft] = useState(null); // { slideSpec, title, purpose, slideCount, docCount }
  const [exportingPptx, setExportingPptx] = useState(false);
  // [auto-docu PPT 화면 편집 Phase 3b] 기존 PPT 목록 미리보기 요소별 클릭
  // 편집 — DraftPanel과 같은 ScopedEditOverlay/patchSlideSpec 재사용.
  const pptPreviewWrapperRef = useRef(null);
  const [pptActiveBlock, setPptActiveBlock] = useState(null); // {id, text, rect}
  const [pptBlockInstruction, setPptBlockInstruction] = useState("");
  const [pptRevisingBlock, setPptRevisingBlock] = useState(false);
  const streamRef = useRef(null);

  useEffect(() => {
    Workspace.bySlug(slug).then((ws) => {
      setDocuments(Array.isArray(ws?.documents) ? ws.documents : []);
    });
    Classification.documents(slug).then((rows) => {
      const byHash = {};
      for (const row of rows || []) {
        if (row.contentHash && row.classification)
          byHash[row.contentHash] = row.classification;
      }
      setClassificationsByHash(byHash);
    });
  }, [slug]);

  useEffect(() => () => streamRef.current?.controller?.abort(), []);

  const filteredDocuments = useMemo(() => {
    const q = docQuery.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => docTitleOf(d).toLowerCase().includes(q));
  }, [documents, docQuery]);

  // 문서함(DocumentRoom)과 같은 업무분류 → 사업부 트리 — "미리 모아둔 폴더"를
  // 고를 때 쓴다. 문서함 폴더 자체(=classification 그룹)를 그대로 재사용하는
  // 것이므로, 여기서 documents/classificationsByHash로 매번 다시 계산한다.
  const folderTree = useMemo(() => {
    const workTypes = new Map();
    for (const doc of documents) {
      const hash = docContentHashOf(doc);
      const cls = hash && classificationsByHash[hash];
      const workType = cls?.workType?.trim() || "미분류";
      const businessUnit = cls?.businessUnit?.trim() || "미분류";
      if (!workTypes.has(workType)) workTypes.set(workType, new Map());
      const units = workTypes.get(workType);
      units.set(businessUnit, (units.get(businessUnit) || 0) + 1);
    }
    return [...workTypes.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "ko"))
      .map(([workType, units]) => ({
        workType,
        key: `work:${workType}`,
        count: [...units.values()].reduce((n, c) => n + c, 0),
        units: [...units.entries()]
          .sort(([a], [b]) => a.localeCompare(b, "ko"))
          .map(([businessUnit, count]) => ({
            businessUnit,
            key: `unit:${workType}:${businessUnit}`,
            count,
          })),
      }));
  }, [documents, classificationsByHash]);

  function toggleFolder(key) {
    setSelectedFolders((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  function toggleWorkExpanded(key) {
    setExpandedWork((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleBaseDoc(doc) {
    const id = doc.id;
    setBaseDocs((prev) =>
      prev.some((d) => d.id === id)
        ? prev.filter((d) => d.id !== id)
        : [
            ...prev,
            {
              id,
              title: docTitleOf(doc),
              contentHash: docContentHashOf(doc),
            },
          ]
    );
  }

  // 새 기준/가이던스 파일을 올릴 때 씌울 분류 — 고른 기준 문서들 중 이미
  // 분류가 확정된 첫 문서의 값을 그대로 물려받는다(= 같은 폴더에 들어감).
  const inheritedClassification = useMemo(() => {
    for (const doc of baseDocs) {
      const cls = doc.contentHash && classificationsByHash[doc.contentHash];
      if (cls) {
        return {
          sensitivity: cls.sensitivity,
          workType: cls.workType,
          businessUnit: cls.businessUnit,
          docType: cls.docType,
          domain: cls.domain,
          tags: (() => {
            try {
              return JSON.parse(cls.tags || "[]");
            } catch {
              return [];
            }
          })(),
        };
      }
    }
    return null;
  }, [baseDocs, classificationsByHash]);

  async function handleGuidanceFile(fileList) {
    const file = fileList?.[0];
    if (!file) return;
    setUploadingGuidance(true);
    const res = await Workspace.docRegenUploadGuidance(
      slug,
      file,
      inheritedClassification || {}
    );
    setUploadingGuidance(false);
    if (res?.error) {
      showToast(res.error, "error");
      return;
    }
    setGuidanceText(res.guidanceText || "");
    setGuidanceFileName(res.title || file.name);
    showToast(
      inheritedClassification
        ? "파일을 업로드했습니다. 기준 문서와 같은 분류로 아카이브에 추가했습니다."
        : "파일을 업로드했습니다.",
      "success"
    );
  }

  // [auto-docu 전사문서작성tool v2] 빈양식 업로드 — 기준 문서를 아직 고르기
  // 전 단계라 물려받을 분류가 없다(일반 업로드처럼 분류 검수 대기로 들어감).
  async function handleTemplateFile(fileList) {
    const file = fileList?.[0];
    if (!file) return;
    setUploadingTemplate(true);
    const res = await Workspace.docRegenUploadTemplate(slug, file, {});
    setUploadingTemplate(false);
    if (res?.error) {
      showToast(res.error, "error");
      return;
    }
    setBlankForm({
      title: res.title || file.name,
      pageContent: res.pageContent || "",
      blocks: res.blocks || [],
      contentHash: res.contentHash || null,
      // [auto-docu 빈양식 채우기 2단계] 원본 서식 그대로 다운로드할 때 이걸로
      // 원본 파일을 다시 찾아간다 — .docx일 때만 그 버튼이 뜬다.
      docId: res.docId || null,
      isDocx: /\.docx$/i.test(file.name),
    });
    showToast("빈양식을 업로드했습니다.", "success");
  }

  const previewHtml = useMemo(
    () =>
      result
        ? DOMPurify.sanitize(
            linkifyNeedsMarkers(resultBodyHtml(result.markdown))
          )
        : "",
    [result]
  );

  const totalNeeds = useMemo(
    () =>
      (result?.sections || []).reduce((n, s) => n + (s.needs?.length || 0), 0),
    [result]
  );

  function reset() {
    setStep("name");
    setTitle("");
    setBaseDocs([]);
    setBlankForm(null);
    setGuidanceText("");
    setGuidanceFileName(null);
    setSelectedFolders([]);
    setPlan([]);
    setSections([]);
    setResult(null);
    setError(null);
    setPptPurpose(null);
    setPptDraft(null);
    setPptInstructions("");
  }

  function startGeneration() {
    setError(null);
    setPlan([]);
    setSections([]);
    setStep("progress");
    const stream = Workspace.docRegenStream(
      slug,
      {
        title: title.trim(),
        baseDocIds: baseDocs.map((d) => d.id),
        blankForm,
        guidanceText: guidanceText.trim(),
        folderKeys: selectedFolders,
      },
      (event) => {
        if (event.type === "plan") {
          setPlan(event.plan);
        } else if (event.type === "section_start") {
          setActiveIndex(event.index);
        } else if (event.type === "section_done") {
          setSections((prev) => {
            const next = [...prev];
            next[event.index] = event.section;
            return next;
          });
        } else if (event.type === "done") {
          setResult(event);
          setStep("result");
        } else if (event.type === "error") {
          setError(event.error);
          setStep("folder");
        }
      }
    );
    streamRef.current = stream;
  }

  // [auto-docu PPT 생성 Phase 2]
  async function startPptGeneration() {
    if (!pptPurpose || !selectedFolders.filter((k) => k !== "전체").length) {
      showToast("PPT 근거로 쓸 문서함 폴더를 하나 이상 골라주세요.", "error");
      return;
    }
    setGeneratingPpt(true);
    setPptDraft(null);
    const res = await Workspace.generateFolderPptDraft(slug, {
      folderKeys: selectedFolders,
      purpose: pptPurpose,
      slideCount: pptSlideCount,
      instructions: pptInstructions.trim(),
      title: title.trim(),
    });
    setGeneratingPpt(false);
    if (res?.error || !res?.slideSpec)
      return showToast(
        res?.error || "PPT 생성에 실패했습니다. 다시 시도해 주세요.",
        "error"
      );
    setPptDraft(res);
    showToast(
      `PPT 초안이 생성되었습니다 (참고 문서 ${res.docCount || 0}건).`,
      "success"
    );
    if (res.warning) showToast(res.warning, "warning");
  }

  function archivePptInBackground() {
    if (!pptDraft?.slideSpec) return;
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
    Workspace.archiveGenerated(slug, {
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

  async function downloadPptDraft() {
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

  // [auto-docu PPT 화면 편집 Phase 3b] — 직접 클릭이든 호버 라벨의 "이
  // 부분만"/"전체 블록" 선택이든 이 하나로 처리한다.
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
    const res = await Workspace.reviseDraftBlock(slug, {
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

  function archiveResultInBackground() {
    // [auto-docu 내부생성자료] 다운로드와 별개로 백그라운드 아카이빙 —
    // 실패해도 다운로드 자체엔 영향 없음.
    Workspace.archiveGenerated(slug, {
      title: result.title,
      markdown: result.markdown,
      kind: "docregen",
    }).then((res) => {
      if (res?.success)
        showToast(
          "내부생성자료 폴더에 보관했습니다(검수 후 검색에 반영).",
          "info"
        );
    });
  }

  async function downloadDocx() {
    if (!result || exportingDocx) return;
    setExportingDocx(true);
    const res = await Workspace.downloadAsDocx({
      title: result.title,
      markdown: result.markdown,
    });
    setExportingDocx(false);
    if (!res?.success)
      return showToast(res?.error || "DOCX 다운로드에 실패했습니다.", "error");
    showToast("DOCX 파일을 내려받았습니다.", "success");
    archiveResultInBackground();
  }

  async function downloadXlsx() {
    if (!result || exportingXlsx) return;
    setExportingXlsx(true);
    const res = await Workspace.downloadAsXlsx({
      title: result.title,
      markdown: result.markdown,
    });
    setExportingXlsx(false);
    if (!res?.success)
      return showToast(res?.error || "XLSX 다운로드에 실패했습니다.", "error");
    showToast("XLSX 파일을 내려받았습니다.", "success");
    archiveResultInBackground();
  }

  async function downloadFilledTemplate() {
    if (!result || !blankForm?.docId || exportingTemplate) return;
    setExportingTemplate(true);
    const res = await Workspace.downloadFilledTemplate(slug, {
      docId: blankForm.docId,
      sections: result.sections,
      title: blankForm.title,
    });
    setExportingTemplate(false);
    if (!res?.success)
      return showToast(
        res?.error || "원본 서식 다운로드에 실패했습니다.",
        "error"
      );
    showToast(
      `원본 서식에 ${res.inserted}/${res.total}개 항목을 채워 내려받았습니다.`,
      "success"
    );
    archiveResultInBackground();
  }

  function handleResultClick(clickEvent) {
    const marker = clickEvent.target.closest?.(".needs-ref");
    if (!marker) return;
    const description = marker.dataset.need;
    const section = (result?.sections || []).find((s) =>
      (s.needs || []).includes(description)
    );
    setDetailNeed({ description, section });
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ArchiveSidebar slug={slug} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
          <Link
            to={paths.workspace.chat(slug)}
            className="mb-3 flex w-fit items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-violet-600 dark:text-zinc-400 dark:hover:text-violet-400"
          >
            <ArrowLeft size={12} /> 질문창으로 돌아가기
          </Link>
          <div className="mb-7 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">
            <Buildings size={15} weight="bold" /> 전사문서작성tool
          </div>

          {error && (
            <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          {step === "name" && (
            <StepCard
              heading="어떤 문서를 만들까요?"
              description="작년(기준) 문서를 뼈대로, 올해 새 기준에 맞춰 다시 채워 넣습니다."
            >
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 2026년 공정거래협약이행평가"
                className="w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && title.trim()) setStep("template");
                }}
              />
              <NextButton
                disabled={!title.trim()}
                onClick={() => setStep("template")}
              />
              <button
                type="button"
                onClick={() => setStep("ppt")}
                className="mt-3 flex w-fit items-center gap-1.5 text-[11px] font-medium text-slate-500 hover:text-violet-600 dark:text-zinc-400 dark:hover:text-violet-400"
              >
                <Presentation size={13} weight="fill" />
                문서 대신 PPT를 만들까요? — 폴더 지정으로 바로 만들기
              </button>
            </StepCard>
          )}

          {step === "ppt" && (
            <StepCard
              heading="PPT로 만들까요?"
              description="원하는 자료가 모인 문서함 폴더를 지정하면, 그 폴더 안 자료만 근거로 PPT 초안을 만듭니다."
              onBack={() => setStep("name")}
            >
              <div className="flex flex-col gap-3">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-600 dark:text-zinc-300">
                    근거로 쓸 문서함 폴더 (필수)
                  </p>
                  <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-zinc-800">
                    {folderTree.map((work) => {
                      const expanded = expandedWork.has(work.key);
                      return (
                        <div key={work.key}>
                          <FolderRow
                            label={work.workType}
                            count={work.count}
                            checked={selectedFolders.includes(work.key)}
                            onToggle={() => toggleFolder(work.key)}
                            expandable={work.units.length > 1}
                            expanded={expanded}
                            onExpand={() => toggleWorkExpanded(work.key)}
                          />
                          {expanded &&
                            work.units.map((unit) => (
                              <FolderRow
                                key={unit.key}
                                label={unit.businessUnit}
                                count={unit.count}
                                indent
                                checked={selectedFolders.includes(unit.key)}
                                onToggle={() => toggleFolder(unit.key)}
                              />
                            ))}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-600 dark:text-zinc-300">
                    목적
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {PPT_TEMPLATES.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setPptPurpose(t.key)}
                        className={`rounded-lg border px-3 py-2 text-left transition ${
                          pptPurpose === t.key
                            ? "border-violet-400 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/30"
                            : "border-slate-200 bg-white hover:border-violet-300 dark:border-zinc-800 dark:bg-zinc-900"
                        }`}
                      >
                        <span className="block text-xs font-semibold text-slate-800 dark:text-zinc-100">
                          {t.label}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-slate-500 dark:text-zinc-400">
                          {t.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                    페이지 수 (표지 제외)
                  </span>
                  <input
                    type="number"
                    min={PPT_MIN_SLIDES}
                    max={PPT_MAX_SLIDES}
                    value={pptSlideCount}
                    onChange={(e) =>
                      setPptSlideCount(
                        Math.min(
                          PPT_MAX_SLIDES,
                          Math.max(
                            PPT_MIN_SLIDES,
                            Number(e.target.value) || PPT_MIN_SLIDES
                          )
                        )
                      )
                    }
                    className="w-24 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none focus:border-violet-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                    추가 요청 사항 (선택)
                  </span>
                  <textarea
                    value={pptInstructions}
                    onChange={(e) => setPptInstructions(e.target.value)}
                    rows={3}
                    placeholder="예: 표지 다음에 배경 슬라이드를 먼저 넣어줘"
                    className="resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-800 outline-none focus:border-violet-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>

                <button
                  type="button"
                  onClick={startPptGeneration}
                  disabled={generatingPpt}
                  className="flex w-fit items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generatingPpt ? (
                    <CircleNotch size={15} className="animate-spin" />
                  ) : (
                    <Sparkle size={15} weight="fill" />
                  )}
                  {generatingPpt ? "PPT 생성 중…" : "PPT 초안 생성"}
                </button>

                {pptDraft && !generatingPpt && (
                  <div className="mt-2 flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-zinc-800">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                      {pptDraft.title}
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-zinc-500">
                      원하는 부분에 마우스를 올리면 수정할 수 있는 범위가
                      보입니다. 불릿/표 칸 하나만, 또는 불릿 목록 전체/표 전체를
                      골라 수정할 수 있습니다.
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
                            <span className="rounded-md border border-violet-200 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:border-violet-900 dark:text-violet-400">
                              {i + 1} /{" "}
                              {slide.layout === "section" ? "구분" : "내용"}
                            </span>
                            <span
                              data-block-id={`${i}.title`}
                              data-block-text={slide.title || ""}
                              className="text-sm font-semibold text-slate-800 dark:text-zinc-100"
                            >
                              {slide.title}
                            </span>
                          </div>
                          {Array.isArray(slide.content) &&
                            slide.content.length > 0 && (
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
                              className="mt-2 rounded border border-dashed border-violet-300 bg-violet-50/50 px-3 py-2 text-xs text-slate-600 dark:border-violet-900 dark:bg-violet-950/20 dark:text-zinc-300"
                            >
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
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
                    <button
                      type="button"
                      onClick={downloadPptDraft}
                      disabled={exportingPptx}
                      className="flex w-fit items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
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
            </StepCard>
          )}

          {step === "template" && (
            <StepCard
              heading="빈양식이 있으신가요?"
              description="이미 만들어진 서식/표에 자료를 채워 넣어야 하는 경우라면 그 파일을 올려주세요. 있으면 이 서식을 채우는 게 우선이 되고, 없으면 다음 단계에서 고를 작년 문서의 구조를 그대로 씁니다."
              onBack={() => setStep("name")}
            >
              <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2.5 text-sm text-slate-600 hover:border-violet-400 hover:text-violet-700 dark:border-zinc-700 dark:text-zinc-300">
                {uploadingTemplate ? (
                  <CircleNotch size={15} className="animate-spin" />
                ) : (
                  <UploadSimple size={15} />
                )}
                {uploadingTemplate
                  ? "업로드 중…"
                  : blankForm
                    ? `업로드됨: ${blankForm.title} (다시 올리기)`
                    : "빈양식 파일 업로드 (선택)"}
                <input
                  type="file"
                  className="hidden"
                  disabled={uploadingTemplate}
                  onChange={(e) => handleTemplateFile(e.target.files)}
                />
              </label>
              {blankForm && (
                <button
                  type="button"
                  onClick={() => setBlankForm(null)}
                  className="mt-2 flex items-center gap-1 text-xs text-slate-400 hover:text-red-600 dark:text-zinc-600"
                >
                  <X size={11} /> 빈양식 선택 해제
                </button>
              )}
              <NextButton
                disabled={uploadingTemplate}
                onClick={() => setStep("baseDoc")}
              />
            </StepCard>
          )}

          {step === "baseDoc" && (
            <StepCard
              heading={
                blankForm
                  ? "참고할 작년 문서가 있다면 골라주세요 (선택)"
                  : "기준이 될 작년 문서를 골라주세요"
              }
              description={
                blankForm
                  ? `빈양식(${blankForm.title})을 채우는 게 우선이라 이 선택은 참고용입니다 — 문서함에 있는 자료 중에서 여러 개를 함께 고를 수 있습니다.`
                  : "구조와 양식의 뼈대로 씁니다 — 문서함에 있는 자료 중에서 여러 개를 함께 고를 수 있습니다."
              }
              onBack={() => setStep("template")}
            >
              <input
                value={docQuery}
                onChange={(e) => setDocQuery(e.target.value)}
                placeholder="문서 이름으로 찾기"
                className="mb-3 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 dark:border-zinc-800">
                {filteredDocuments.length === 0 && (
                  <p className="p-4 text-xs text-slate-400 dark:text-zinc-600">
                    문서를 찾을 수 없습니다.
                  </p>
                )}
                {filteredDocuments.map((doc) => {
                  const checked = baseDocs.some((d) => d.id === doc.id);
                  return (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => toggleBaseDoc(doc)}
                      className={`flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2.5 text-left text-sm last:border-b-0 dark:border-zinc-800 ${
                        checked
                          ? "bg-violet-50 dark:bg-violet-950/20"
                          : "hover:bg-violet-50 dark:hover:bg-violet-950/20"
                      }`}
                    >
                      {checked ? (
                        <CheckSquare
                          size={16}
                          weight="fill"
                          className="shrink-0 text-violet-600"
                        />
                      ) : (
                        <Square
                          size={16}
                          className="shrink-0 text-slate-300 dark:text-zinc-700"
                        />
                      )}
                      <FileText
                        size={15}
                        className="shrink-0 text-slate-400 dark:text-zinc-500"
                      />
                      <span className="truncate">{docTitleOf(doc)}</span>
                    </button>
                  );
                })}
              </div>
              <NextButton
                disabled={!blankForm && baseDocs.length === 0}
                label={
                  baseDocs.length
                    ? `다음 (${baseDocs.length}개 선택)`
                    : blankForm
                      ? "다음 (건너뛰기)"
                      : "다음"
                }
                onClick={() => setStep("guidance")}
              />
            </StepCard>
          )}

          {step === "guidance" && (
            <StepCard
              heading="올해 새로 생긴 기준·가이던스를 입력해 주세요"
              description={
                blankForm && !baseDocs.length
                  ? `빈양식: "${blankForm.title}" — 이 내용에 맞춰 서식의 각 항목을 채웁니다.`
                  : `기준 문서: ${baseDocs
                      .map((d) => `"${d.title}"`)
                      .join(", ")} — 이 내용에 맞춰 절별로 다시 채웁니다.`
              }
              onBack={() => setStep("baseDoc")}
            >
              <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2.5 text-sm text-slate-600 hover:border-violet-400 hover:text-violet-700 dark:border-zinc-700 dark:text-zinc-300">
                {uploadingGuidance ? (
                  <CircleNotch size={15} className="animate-spin" />
                ) : (
                  <UploadSimple size={15} />
                )}
                {uploadingGuidance
                  ? "업로드 중…"
                  : guidanceFileName
                    ? `업로드됨: ${guidanceFileName} (다시 올리기)`
                    : "기준 파일 업로드 (선택)"}
                <input
                  type="file"
                  className="hidden"
                  disabled={uploadingGuidance}
                  onChange={(e) => handleGuidanceFile(e.target.files)}
                />
              </label>
              {inheritedClassification && (
                <p className="mt-1.5 text-[11px] text-slate-400 dark:text-zinc-600">
                  업로드하면 기준 문서와 같은 분류(
                  {inheritedClassification.workType} ·{" "}
                  {inheritedClassification.businessUnit})로 아카이브에
                  추가됩니다.
                </p>
              )}
              <textarea
                value={guidanceText}
                onChange={(e) => {
                  setGuidanceText(e.target.value);
                  setGuidanceFileName(null);
                }}
                rows={10}
                placeholder="올해 새로 생긴 기준, 가이던스, 양식 요구사항 등을 붙여넣거나, 위에서 파일을 업로드하세요."
                className="mt-3 w-full resize-none rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm leading-6 outline-none focus:border-violet-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <NextButton
                disabled={!guidanceText.trim() || uploadingGuidance}
                onClick={() => setStep("folder")}
              />
            </StepCard>
          )}

          {step === "folder" && (
            <StepCard
              heading="참고할 자료 범위를 좁힐까요?"
              description="이 작업에 쓸 자료를 미리 모아둔 문서함 폴더가 있다면 골라주세요. 여러 개를 겹쳐서 고를 수 있고, 아무것도 고르지 않으면 아카이브 전체에서 찾습니다."
              onBack={() => setStep("guidance")}
            >
              <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 dark:border-zinc-800">
                <FolderRow
                  label="전체 문서"
                  checked={selectedFolders.includes("전체")}
                  onToggle={() => toggleFolder("전체")}
                />
                {folderTree.map((work) => {
                  const expanded = expandedWork.has(work.key);
                  return (
                    <div key={work.key}>
                      <FolderRow
                        label={work.workType}
                        count={work.count}
                        checked={selectedFolders.includes(work.key)}
                        onToggle={() => toggleFolder(work.key)}
                        expandable={work.units.length > 1}
                        expanded={expanded}
                        onExpand={() => toggleWorkExpanded(work.key)}
                      />
                      {expanded &&
                        work.units.map((unit) => (
                          <FolderRow
                            key={unit.key}
                            label={unit.businessUnit}
                            count={unit.count}
                            indent
                            checked={selectedFolders.includes(unit.key)}
                            onToggle={() => toggleFolder(unit.key)}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
              <NextButton
                disabled={!guidanceText.trim() || uploadingGuidance}
                label="생성 시작"
                onClick={startGeneration}
              />
            </StepCard>
          )}

          {step === "progress" && (
            <StepCard
              heading={`"${title}" 작성 중…`}
              description="절마다 아카이브를 검색하고 내용을 채우고 있습니다. 절이 많으면 시간이 걸립니다."
            >
              {!plan.length && (
                <div className="flex items-center gap-2 py-6 text-sm text-slate-500 dark:text-zinc-400">
                  <CircleNotch size={16} className="animate-spin" /> 작년 문서의
                  목차를 분석하고 있습니다…
                </div>
              )}
              <ul className="flex flex-col gap-1.5">
                {plan.map((p, i) => {
                  const done = !!sections[i];
                  const active = !done && activeIndex === i;
                  return (
                    <li
                      key={`${p.title}-${i}`}
                      className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-sm dark:border-zinc-800"
                    >
                      {done ? (
                        <CheckCircle
                          size={16}
                          weight="fill"
                          className="shrink-0 text-emerald-500"
                        />
                      ) : active ? (
                        <CircleNotch
                          size={16}
                          className="shrink-0 animate-spin text-violet-500"
                        />
                      ) : (
                        <Circle
                          size={16}
                          className="shrink-0 text-slate-300 dark:text-zinc-700"
                        />
                      )}
                      <span className="flex-1 truncate">{p.title}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[p.status] || STATUS_STYLE.update}`}
                      >
                        {STATUS_LABEL[p.status] || "갱신"}
                      </span>
                      {done && (sections[i].needs || []).length > 0 && (
                        <span className="shrink-0 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                          자료 필요 {sections[i].needs.length}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </StepCard>
          )}

          {step === "result" && result && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-xl font-semibold">{result.title}</h1>
                  <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                    {totalNeeds > 0
                      ? `자료 필요 항목 ${totalNeeds}건 — 아래에서 [자료 필요] 표시를 눌러 확인하세요.`
                      : "모든 절이 아카이브 근거로 채워졌습니다."}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={reset}
                    className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-violet-300 hover:text-violet-700 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    <ArrowLeft size={13} /> 새로 만들기
                  </button>
                  {totalNeeds > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        downloadRequestSheet({
                          title: result.title,
                          sections: result.sections,
                        });
                        showToast("자료요청서를 내려받았습니다.", "success");
                      }}
                      className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400"
                    >
                      <DownloadSimple size={13} /> 자료요청서 다운로드
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      downloadDocRegenHtml({
                        markdown: result.markdown,
                        title: result.title,
                      });
                      showToast("HTML 파일을 내려받았습니다.", "success");
                      archiveResultInBackground();
                    }}
                    className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
                  >
                    <FileHtml size={13} weight="fill" /> HTML 다운로드
                  </button>
                  <button
                    type="button"
                    onClick={downloadDocx}
                    disabled={exportingDocx}
                    className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-violet-400 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    {exportingDocx ? (
                      <CircleNotch size={13} className="animate-spin" />
                    ) : (
                      <FileDoc size={13} weight="fill" />
                    )}
                    DOCX 다운로드
                  </button>
                  <button
                    type="button"
                    onClick={downloadXlsx}
                    disabled={exportingXlsx}
                    className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-violet-400 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    {exportingXlsx ? (
                      <CircleNotch size={13} className="animate-spin" />
                    ) : (
                      <FileXls size={13} weight="fill" />
                    )}
                    XLSX 다운로드
                  </button>
                  {blankForm?.docId && blankForm?.isDocx && (
                    <button
                      type="button"
                      onClick={downloadFilledTemplate}
                      disabled={exportingTemplate}
                      className="flex items-center gap-1.5 rounded-md border border-dashed border-violet-300 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30"
                      title="빈양식으로 올린 원본 파일 그대로, 채운 내용을 삽입해서 내려받습니다"
                    >
                      {exportingTemplate ? (
                        <CircleNotch size={13} className="animate-spin" />
                      ) : (
                        <FileDoc size={13} weight="duotone" />
                      )}
                      원본 서식으로 다운로드
                    </button>
                  )}
                </div>
              </div>

              <div
                onClick={handleResultClick}
                className="doc-regen-preview rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm leading-7 dark:border-zinc-800 dark:bg-zinc-900"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          )}
        </div>
      </main>

      {detailNeed && (
        <NeedDetailPanel
          need={detailNeed}
          onClose={() => setDetailNeed(null)}
        />
      )}
    </div>
  );
}

function StepCard({ heading, description, onBack, children }) {
  return (
    <div className="flex flex-col gap-4">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex w-fit items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:text-zinc-500 dark:hover:text-zinc-200"
        >
          <ArrowLeft size={12} /> 이전
        </button>
      )}
      <div>
        <h1 className="text-xl font-semibold">{heading}</h1>
        {description && (
          <p className="mt-1.5 text-sm text-slate-500 dark:text-zinc-400">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function NextButton({ onClick, disabled, label = "다음" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-4 flex w-fit items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label} <ArrowRight size={15} weight="bold" />
    </button>
  );
}

/** 문서함 폴더 선택 행 — 체크(선택, 중복 가능)와 펼치기(하위 폴더 보기)가
 * 분리된 별도 클릭 영역이다. "전체 문서"처럼 하위가 없으면 펼치기 버튼이 없다. */
function FolderRow({
  label,
  count,
  indent = false,
  checked,
  onToggle,
  expandable = false,
  expanded = false,
  onExpand,
}) {
  return (
    <div
      className={`flex w-full items-center gap-2 border-b border-slate-100 py-2.5 text-left text-sm last:border-b-0 dark:border-zinc-800 ${
        indent ? "pl-9 pr-3" : "pl-3 pr-3"
      } ${checked ? "bg-violet-50 dark:bg-violet-950/20" : ""}`}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onExpand}
          className="shrink-0 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-200"
        >
          {expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
        </button>
      ) : (
        <span className="inline-block w-[13px] shrink-0" />
      )}
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 items-center gap-2 hover:text-violet-700"
      >
        {checked ? (
          <CheckSquare
            size={16}
            weight="fill"
            className="shrink-0 text-violet-600"
          />
        ) : (
          <Square
            size={16}
            className="shrink-0 text-slate-300 dark:text-zinc-700"
          />
        )}
        <Folder
          size={15}
          className="shrink-0 text-slate-400 dark:text-zinc-500"
        />
        <span className="truncate">{label}</span>
      </button>
      {typeof count === "number" && (
        <span className="shrink-0 text-[11px] text-slate-400 dark:text-zinc-600">
          {count}건
        </span>
      )}
    </div>
  );
}

/** [자료 필요] 클릭 시 — 근거(신규 기준)와 과거 참고자료를 보여주는 패널. */
function NeedDetailPanel({ need, onClose }) {
  const { description, section } = need;

  function copyForRequest() {
    const lines = [
      `[${section?.title || "절"}] ${description}`,
      section?.guidanceExcerpt
        ? `근거(신규 기준): ${section.guidanceExcerpt}`
        : "",
      section?.priorContent
        ? `과거(작년) 참고자료: ${section.priorContent.slice(0, 500)}`
        : "과거 참고자료: 없음(완전 신규 항목)",
    ].filter(Boolean);
    navigator.clipboard?.writeText(lines.join("\n\n"));
    showToast("요청 문구를 복사했습니다.", "success");
  }

  return (
    <div className="fixed inset-y-0 right-0 z-30 flex w-[380px] flex-col border-l border-slate-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
        <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
          자료 필요
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <p className="text-xs text-slate-400 dark:text-zinc-600">
          {section?.title}
        </p>
        <p className="mt-1 text-sm font-medium">{description}</p>

        <div className="mt-5">
          <p className="text-xs font-semibold text-slate-500 dark:text-zinc-400">
            근거 (신규 기준/가이던스)
          </p>
          <p className="mt-1.5 whitespace-pre-line rounded-md bg-slate-50 p-3 text-xs leading-5 text-slate-700 dark:bg-zinc-900 dark:text-zinc-300">
            {section?.guidanceExcerpt ||
              "이 절과 직접 연결된 신규 기준 발췌가 없습니다."}
          </p>
        </div>

        <div className="mt-4">
          <p className="text-xs font-semibold text-slate-500 dark:text-zinc-400">
            과거(작년) 참고자료
          </p>
          {section?.priorContent ? (
            <p className="mt-1.5 whitespace-pre-line rounded-md bg-slate-50 p-3 text-xs leading-5 text-slate-700 dark:bg-zinc-900 dark:text-zinc-300">
              {section.priorContent.slice(0, 1500)}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-slate-400 dark:text-zinc-600">
              작년 문서에는 없던 완전 신규 항목입니다.
            </p>
          )}
        </div>
      </div>
      <div className="border-t border-slate-200 p-3 dark:border-zinc-800">
        <button
          type="button"
          onClick={copyForRequest}
          className="w-full rounded-md bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700"
        >
          이 항목 요청 문구 복사
        </button>
      </div>
    </div>
  );
}
