// [auto-docu 전사문서작성tool] 정기 문서 갱신 작성 — 작년(기준) 문서를
// 양식/구조로 삼아, 신규 기준/가이던스에 맞춰 아카이브 전체에서 근거를
// 찾아 절별로 다시 채워 넣는다. 근거가 부족한 절은 "[자료 필요: ...]"로
// 표시되고, 클릭하면 근거(신규 기준)와 과거 참고자료를 보여준다.
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Buildings,
  CheckCircle,
  CircleNotch,
  Circle,
  DownloadSimple,
  FileHtml,
  FileText,
  X,
} from "@phosphor-icons/react";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import Workspace from "@/models/workspace";
import DOMPurify from "@/utils/chat/purify";
import showToast from "@/utils/toast";
import {
  resultBodyHtml,
  linkifyNeedsMarkers,
  downloadDocRegenHtml,
  downloadRequestSheet,
} from "./exporters";

const STATUS_LABEL = { keep: "유지", update: "갱신", new: "신규" };
const STATUS_STYLE = {
  keep: "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400",
  update:
    "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  new: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
};

function docTitleOf(doc) {
  try {
    return JSON.parse(doc?.metadata || "{}").title || doc?.filename || "문서";
  } catch {
    return doc?.filename || "문서";
  }
}

export default function DocRegen() {
  const { slug = "archive-full" } = useParams();
  const [step, setStep] = useState("name"); // name | baseDoc | guidance | progress | result
  const [title, setTitle] = useState("");
  const [documents, setDocuments] = useState([]);
  const [docQuery, setDocQuery] = useState("");
  const [baseDoc, setBaseDoc] = useState(null);
  const [guidanceText, setGuidanceText] = useState("");

  const [plan, setPlan] = useState([]); // [{title, status}]
  const [sections, setSections] = useState([]); // 채워지는 대로 index별로 들어감
  const [activeIndex, setActiveIndex] = useState(null);
  const [result, setResult] = useState(null); // {title, sections, markdown}
  const [error, setError] = useState(null);
  const [detailNeed, setDetailNeed] = useState(null); // {description, section}
  const streamRef = useRef(null);

  useEffect(() => {
    Workspace.bySlug(slug).then((ws) => {
      setDocuments(Array.isArray(ws?.documents) ? ws.documents : []);
    });
  }, [slug]);

  useEffect(() => () => streamRef.current?.controller?.abort(), []);

  const filteredDocuments = useMemo(() => {
    const q = docQuery.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => docTitleOf(d).toLowerCase().includes(q));
  }, [documents, docQuery]);

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
    setBaseDoc(null);
    setGuidanceText("");
    setPlan([]);
    setSections([]);
    setResult(null);
    setError(null);
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
        baseDocId: baseDoc.id,
        guidanceText: guidanceText.trim(),
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
          setStep("guidance");
        }
      }
    );
    streamRef.current = stream;
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
        <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-10 lg:px-10">
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
                placeholder="예: 2026년 지속가능경영보고서"
                className="w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-violet-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && title.trim()) setStep("baseDoc");
                }}
              />
              <NextButton
                disabled={!title.trim()}
                onClick={() => setStep("baseDoc")}
              />
            </StepCard>
          )}

          {step === "baseDoc" && (
            <StepCard
              heading="기준이 될 작년 문서를 골라주세요"
              description="구조와 양식의 뼈대로 씁니다 — 문서함에 있는 자료 중에서 선택합니다."
              onBack={() => setStep("name")}
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
                {filteredDocuments.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => {
                      setBaseDoc({ id: doc.id, title: docTitleOf(doc) });
                      setStep("guidance");
                    }}
                    className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2.5 text-left text-sm hover:bg-violet-50 last:border-b-0 dark:border-zinc-800 dark:hover:bg-violet-950/20"
                  >
                    <FileText
                      size={15}
                      className="shrink-0 text-slate-400 dark:text-zinc-500"
                    />
                    <span className="truncate">{docTitleOf(doc)}</span>
                  </button>
                ))}
              </div>
            </StepCard>
          )}

          {step === "guidance" && (
            <StepCard
              heading="올해 새로 생긴 기준·가이던스를 입력해 주세요"
              description={`기준 문서: "${baseDoc?.title}" — 이 내용에 맞춰 절별로 다시 채웁니다.`}
              onBack={() => setStep("baseDoc")}
            >
              <textarea
                autoFocus
                value={guidanceText}
                onChange={(e) => setGuidanceText(e.target.value)}
                rows={10}
                placeholder="올해 새로 생긴 기준, 가이던스, 양식 요구사항 등을 붙여넣어 주세요."
                className="w-full resize-none rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm leading-6 outline-none focus:border-violet-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <p className="mt-2 text-[11px] text-slate-400 dark:text-zinc-600">
                지금은 텍스트 입력만 지원합니다. 파일 업로드는 준비 중입니다.
              </p>
              <NextButton
                disabled={!guidanceText.trim()}
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
                    }}
                    className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
                  >
                    <FileHtml size={13} weight="fill" /> HTML 다운로드
                  </button>
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
