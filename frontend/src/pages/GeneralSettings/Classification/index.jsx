import { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import { Sparkle, ArrowClockwise } from "@phosphor-icons/react";
import CTAButton from "@/components/lib/CTAButton";
import showToast from "@/utils/toast";
import Classification from "@/models/classification";
import DocRow from "./DocRow";

export default function ClassificationReview() {
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState(false);
  const [docs, setDocs] = useState([]);
  const [taxonomy, setTaxonomy] = useState(null);

  async function load() {
    const [d, t] = await Promise.all([
      Classification.documents(),
      Classification.taxonomy(),
    ]);
    setDocs(d);
    setTaxonomy(t);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function proposeAll() {
    setProposing(true);
    const res = await Classification.propose();
    setProposing(false);
    if (res?.error) return showToast(`분류 실패: ${res.error}`, "error");
    showToast(`${res.proposed}건 분류 제안 완료`, "success");
    load();
  }

  const pending = docs.filter(
    (d) => !d.classification || d.classification.status !== "confirmed"
  ).length;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <div className="flex gap-x-4 items-center">
              <p className="text-lg leading-6 font-bold text-theme-text-primary">
                문서 분류 검수
              </p>
            </div>
            <p className="text-xs leading-[18px] font-base text-theme-text-secondary">
              아카이브의 문서를 민감도 · 종류 · 분야로 분류합니다. LLM이 제안한
              분류를 검토하고 확정하세요. 민감도는 워크스페이스 라우팅과 접근
              제어의 기준이 되며, 확신이 서지 않는 문서는{" "}
              <span className="font-semibold">격리·민감</span>으로 둡니다.
            </p>
          </div>

          <div className="flex items-center gap-x-3 my-4">
            <CTAButton
              onClick={proposeAll}
              disabled={proposing || pending === 0}
            >
              <Sparkle className="h-4 w-4" weight="bold" />
              {proposing ? "분류 중…" : `미확정 ${pending}건 분류 제안`}
            </CTAButton>
            <button
              onClick={load}
              className="flex items-center gap-x-1.5 text-xs text-theme-text-secondary hover:text-theme-text-primary"
            >
              <ArrowClockwise className="h-4 w-4" /> 새로고침
            </button>
          </div>

          {loading ? (
            <Skeleton.default
              height={90}
              count={4}
              baseColor="var(--theme-bg-primary)"
              highlightColor="var(--theme-bg-secondary)"
              className="mb-3"
            />
          ) : docs.length === 0 ? (
            <p className="text-sm text-theme-text-secondary py-8">
              아카이브에 문서가 없습니다.
            </p>
          ) : (
            <div className="flex flex-col gap-y-3">
              {docs.map((doc) => (
                <DocRow
                  key={doc.contentHash}
                  doc={doc}
                  taxonomy={taxonomy}
                  onConfirmed={(cls) =>
                    setDocs((prev) =>
                      prev.map((d) =>
                        d.contentHash === doc.contentHash
                          ? { ...d, classification: cls }
                          : d
                      )
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
