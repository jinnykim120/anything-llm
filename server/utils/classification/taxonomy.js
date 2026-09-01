// [auto-docu P4] The classification axes. See classification-scheme memory.
//
//   sensitivity — CLOSED. drives workspace routing + access control.
//   doc_type    — SUGGESTED list; the classifier may propose another value.
//   domain      — SUGGESTED list; the classifier may propose another value.
//   tags        — free-form keywords.

const SENSITIVITY = {
  // `uncertain` = the classifier couldn't tell — the doc is HELD (no tier
  // routing) and treated as confidential for access until a human decides.
  // `unclassified` = the pre-classification state only.
  values: ["general", "confidential", "uncertain", "unclassified"],
  // Values a human may confirm to (uncertain / unclassified are not choices).
  confirmable: ["general", "confidential"],
  labels: {
    general: "일반 범용",
    confidential: "격리·민감",
    uncertain: "판단 보류",
    unclassified: "미분류",
  },
  // For any access / routing decision, anything that isn't a confirmed
  // `general` is treated as confidential.
  conservativeDefault: "confidential",
  rule: [
    "국가가 공개 배포한 문서(법률·시행령·시행규칙·예규·고시·지침·가이드라인·공개 보도자료 등)는 general.",
    "출처가 국가법령정보센터·관보·부처 홈페이지면 general 신호가 강함.",
    "내부 보고서·계약서·품의서·인사·재무·미공개 실적 등은 confidential.",
    "명백히 어느 쪽인지 판단하기 어렵고 근거가 부족하면 uncertain — confidential로 뭉개지 말 것.",
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
      confirmable: SENSITIVITY.confirmable,
      labels: SENSITIVITY.labels,
      conservativeDefault: SENSITIVITY.conservativeDefault,
      rule: SENSITIVITY.rule,
    },
    doc_type: { suggested: DOC_TYPE.suggested },
    domain: { suggested: DOMAIN.suggested },
  };
}

/**
 * Coerce a classifier/user value onto the sensitivity set. `uncertain` is kept
 * (the classifier is allowed to say "I can't tell" — the doc is then held).
 */
function normalizeSensitivity(v) {
  const s = String(v || "")
    .toLowerCase()
    .trim();
  if (s === "general" || s === "일반" || s === "일반 범용") return "general";
  if (
    s === "confidential" ||
    s === "민감" ||
    s === "격리" ||
    s === "대외비" ||
    s === "격리·민감"
  )
    return "confidential";
  if (s === "uncertain" || s === "보류" || s === "판단 보류" || s === "unsure")
    return "uncertain";
  return SENSITIVITY.conservativeDefault;
}

/**
 * Resolve to the tier a document should be TREATED as right now. A confirmed
 * `general` is the only thing that opens up; anything else (uncertain, still
 * proposed, unclassified) is held at `confidential`.
 * @param {{sensitivity?:string, status?:string}|null} classification
 */
function sensitivityForAccess(classification) {
  if (
    classification?.status === "confirmed" &&
    classification.sensitivity === "general"
  )
    return "general";
  return "confidential";
}

module.exports = {
  taxonomy,
  normalizeSensitivity,
  sensitivityForAccess,
  SENSITIVITY,
  DOC_TYPE,
  DOMAIN,
};
