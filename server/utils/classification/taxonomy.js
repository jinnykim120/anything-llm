// [auto-docu P4] The classification axes. See classification-scheme memory.
//
//   sensitivity — CLOSED. drives workspace routing + access control.
//   doc_type    — SUGGESTED list; the classifier may propose another value.
//   domain      — SUGGESTED list; the classifier may propose another value.
//   tags        — free-form keywords.

const SENSITIVITY = {
  values: ["general", "confidential", "unclassified"],
  labels: {
    general: "일반 범용",
    confidential: "격리·민감",
    unclassified: "미분류",
  },
  // Anything not clearly `general` is treated as `confidential` until a human
  // confirms. `unclassified` is the pre-classification state only.
  conservativeDefault: "confidential",
  rule: [
    "국가가 공개 배포한 문서(법률·시행령·시행규칙·예규·고시·지침·가이드라인·공개 보도자료 등)는 general.",
    "출처가 국가법령정보센터·관보·부처 홈페이지면 general 신호가 강함.",
    "내부 보고서·계약서·품의서·인사·재무·미공개 실적 등은 confidential.",
    "확신이 서지 않으면 confidential.",
  ],
};

const DOC_TYPE = {
  suggested: [
    "법령", // 법률·시행령·시행규칙
    "행정규칙", // 예규·고시·훈령·지침·가이드라인
    "보고서",
    "계획서",
    "회의자료",
    "계약서",
    "품의서",
    "협약서",
    "실적자료", // 데이터표·증빙
    "교육자료",
    "제안서",
    "기타",
  ],
};

const DOMAIN = {
  suggested: [
    "공정거래",
    "유통",
    "동반성장",
    "홈쇼핑",
    "인사",
    "재무",
    "법무",
    "교육",
    "예산",
    "ESG",
    "기타",
  ],
};

/** Everything a UI or the classifier prompt needs. */
function taxonomy() {
  return {
    sensitivity: {
      values: SENSITIVITY.values,
      labels: SENSITIVITY.labels,
      conservativeDefault: SENSITIVITY.conservativeDefault,
      rule: SENSITIVITY.rule,
    },
    doc_type: { suggested: DOC_TYPE.suggested },
    domain: { suggested: DOMAIN.suggested },
  };
}

/** Coerce a classifier/user value onto the allowed sensitivity set. */
function normalizeSensitivity(v) {
  const s = String(v || "").toLowerCase();
  if (s === "general" || s === "일반" || s === "일반 범용") return "general";
  if (
    s === "confidential" ||
    s === "민감" ||
    s === "격리" ||
    s === "대외비" ||
    s === "격리·민감"
  )
    return "confidential";
  return SENSITIVITY.conservativeDefault;
}

module.exports = {
  taxonomy,
  normalizeSensitivity,
  SENSITIVITY,
  DOC_TYPE,
  DOMAIN,
};
