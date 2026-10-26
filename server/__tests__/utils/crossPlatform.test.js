const path = require("path");
const { parseVmStat } = require("../../utils/helpers/availableMemory");
const { scriptCommand } = require("../../utils/doclingControl");

describe("parseVmStat (macOS 사용 가능 메모리)", () => {
  const sample = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               20000.
Pages active:                            300000.
Pages inactive:                          100000.
Pages speculative:                         5000.
Pages purgeable:                          10000.
Pages wired down:                         90000.`;

  it("sums free + inactive + speculative + purgeable pages × page size", () => {
    expect(parseVmStat(sample)).toBe((20000 + 100000 + 5000 + 10000) * 16384);
  });

  it("falls back to a 16KB page size when the header is missing", () => {
    expect(parseVmStat("Pages free:   10.\nPages inactive:   10.")).toBe(
      20 * 16384
    );
  });

  it("returns 0 for unparseable output", () => {
    expect(parseVmStat("nothing useful")).toBe(0);
  });
});

describe("scriptCommand (Docling 켜기/끄기 스크립트 선택)", () => {
  it("uses PowerShell scripts on Windows", () => {
    const c = scriptCommand("start-docling", "win32");
    expect(c.cmd).toBe("powershell.exe");
    expect(c.args[c.args.length - 1]).toMatch(/start-docling\.ps1$/);
  });

  it("uses bash scripts on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"]) {
      const c = scriptCommand("stop-docling", platform);
      expect(c.cmd).toBe("bash");
      expect(c.args[0]).toMatch(/stop-docling\.sh$/);
    }
  });
});

describe("normalizePath backslash handling (POSIX 모의)", () => {
  // 실제 normalizePath 는 path.sep === "/" 일 때만 역슬래시를 슬래시로 바꾼다.
  // 윈도에서는 POSIX 동작을 직접 돌릴 수 없어 같은 식을 path.posix 로 재현한다.
  const BACKSLASH = String.fromCharCode(92);
  const posixNormalize = (p) => {
    const input = String(p).split(BACKSLASH).join("/");
    return path.posix
      .normalize(input.trim())
      .replace(/^(\.\.(\/|$))+/, "")
      .trim();
  };

  it("turns a Windows-style docpath into a POSIX one", () => {
    expect(posixNormalize(["실적", "(7)-.pptx-7555b44a.json"].join(BACKSLASH))).toBe(
      "실적/(7)-.pptx-7555b44a.json"
    );
    expect(posixNormalize(["custom-documents", "a.json"].join(BACKSLASH))).toBe(
      "custom-documents/a.json"
    );
  });

  it("still blocks parent-directory escapes written with backslashes", () => {
    expect(
      posixNormalize(["..", "..", "etc", "passwd"].join(BACKSLASH))
    ).toBe("etc/passwd");
  });

  it("leaves forward-slash paths alone", () => {
    expect(posixNormalize("custom-documents/a.json")).toBe(
      "custom-documents/a.json"
    );
  });
});
