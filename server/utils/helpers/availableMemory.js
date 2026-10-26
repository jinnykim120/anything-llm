// [auto-docu] "지금 새로 쓸 수 있는 메모리" — 모델 로딩 가드와 Docling 켜기 확인용.
//
// os.freemem() 은 윈도/리눅스에서는 사실상 쓸 수 있는 메모리지만, macOS 에서는
// 파일 캐시·비활성 페이지를 뺀 "완전히 빈 페이지"만 돌려줘서 평소에도 수백 MB 로
// 보인다. 그대로 쓰면 리랭커(RERANKER_MIN_FREE_MEMORY_MB)·Docling 켜기 가드가
// 항상 걸려 조용히 품질이 떨어진다. macOS 에서는 vm_stat 으로
// free + inactive + speculative + purgeable 페이지를 합산한다.
const os = require("os");
const { execFileSync } = require("child_process");

const CACHE_MS = 3000;
let cached = { at: 0, bytes: 0 };

function parseVmStat(output) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]) || 16384;
  const pages = (label) =>
    Number(new RegExp(`${label}:\\s+(\\d+)`).exec(output)?.[1]) || 0;
  const total =
    pages("Pages free") +
    pages("Pages inactive") +
    pages("Pages speculative") +
    pages("Pages purgeable");
  return total * pageSize;
}

function darwinAvailableBytes() {
  try {
    const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 });
    const bytes = parseVmStat(out);
    return bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

function availableMemoryBytes() {
  if (process.platform !== "darwin") return os.freemem();
  const now = Date.now();
  if (now - cached.at < CACHE_MS && cached.bytes > 0) return cached.bytes;
  const bytes = darwinAvailableBytes() ?? os.freemem();
  cached = { at: now, bytes };
  return bytes;
}

const availableMemoryMb = () => Math.floor(availableMemoryBytes() / 1024 / 1024);
const availableMemoryGb = () => availableMemoryBytes() / 1024 ** 3;

module.exports = {
  availableMemoryBytes,
  availableMemoryMb,
  availableMemoryGb,
  parseVmStat,
};
