// [auto-docu] Docling(고급 문서 파서)을 화면 버튼으로 켜고 끄는 제어기.
// 켜기/끄기는 저장소 루트의 start-docling.ps1 / stop-docling.ps1 을 그대로 쓴다
// (경로·환경변수·OOM 튜닝이 거기 한 곳에 모여 있다).
//
// 안전장치 (16GB 작업 PC에서 Docling 워커가 1GB+ 상주하며 서버를 불안정하게 함):
//   1. 켜기 전 여유 메모리 확인 — 부족하면 force 확인을 요구.
//   2. 유휴 자동 종료 — docling-serve 로그가 DOCLING_IDLE_STOP_MIN(기본 30)분
//      동안 갱신되지 않으면 끈다. 0 이면 자동 종료 안 함.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const LOG_DIR = path.join(REPO_ROOT, ".local-cache", "docling");
const LOGS = ["serve.stdout.log", "serve.stderr.log"].map((f) =>
  path.join(LOG_DIR, f)
);
const MIN_FREE_GB = Number(process.env.DOCLING_MIN_FREE_GB) || 2;

const baseUrl = () =>
  (process.env.DOCLING_SERVE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const idleStopMin = () => {
  const v = process.env.DOCLING_IDLE_STOP_MIN;
  return v === undefined || v === "" ? 30 : Number(v) || 0;
};

let starting = null; // { since } while start script is running
let lastStartError = null;
let startedAt = null;

async function isHealthy(timeoutMs = 2000) {
  try {
    const res = await fetch(`${baseUrl()}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function lastActivityMs() {
  let latest = startedAt || 0;
  for (const f of LOGS) {
    try {
      latest = Math.max(latest, fs.statSync(f).mtimeMs);
    } catch {
      /* log not created yet */
    }
  }
  return latest || null;
}

const freeGb = () => os.freemem() / 1024 ** 3;

async function status() {
  const running = await isHealthy();
  if (running && starting) starting = null;
  const last = running ? lastActivityMs() : null;
  const stopMin = idleStopMin();
  return {
    running,
    starting: !!starting,
    startingSince: starting?.since || null,
    error: running ? null : lastStartError,
    freeGb: Number(freeGb().toFixed(1)),
    minFreeGb: MIN_FREE_GB,
    idleMinutes: last ? Math.floor((Date.now() - last) / 60000) : null,
    autoStopMinutes: stopMin,
  };
}

function runScript(name) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(REPO_ROOT, name),
      ],
      { cwd: REPO_ROOT, windowsHide: true }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: -1, out: e.message }));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

/** @returns {{ok:boolean, needsConfirm?:boolean, message?:string}} */
async function start({ force = false } = {}) {
  if (await isHealthy()) return { ok: true, message: "이미 켜져 있습니다." };
  if (starting) return { ok: true, message: "켜는 중입니다." };
  if (!force && freeGb() < MIN_FREE_GB)
    return {
      ok: false,
      needsConfirm: true,
      message: `여유 메모리가 ${freeGb().toFixed(1)}GB로 부족합니다(권장 ${MIN_FREE_GB}GB 이상). 켜면 서버가 느려지거나 멈출 수 있습니다.`,
    };
  starting = { since: Date.now() };
  lastStartError = null;
  // 모델 로딩은 첫 파싱 때 일어나므로 보통 수 초~수십 초면 끝난다. 완료는
  // 화면이 status 를 폴링해서 확인한다 — 여기서는 기다리지 않고 바로 반환.
  runScript("start-docling.ps1").then(({ code, out }) => {
    if (code === 0) startedAt = Date.now();
    else lastStartError = out.split("\n").pop() || "시작 실패";
    starting = null;
  });
  return { ok: true, message: "켜는 중입니다." };
}

async function stop() {
  const { code, out } = await runScript("stop-docling.ps1");
  startedAt = null;
  if (code !== 0)
    return { ok: false, message: out.split("\n").pop() || "끄기 실패" };
  return { ok: true, message: out.split("\n").pop() };
}

let timer = null;
function startIdleWatcher() {
  if (timer || process.env.NODE_ENV === "test") return;
  timer = setInterval(async () => {
    try {
      const min = idleStopMin();
      if (!min || starting) return;
      if (!(await isHealthy())) return;
      const last = lastActivityMs();
      if (last && Date.now() - last > min * 60000) {
        console.log(`[docling] ${min}분 유휴 — 자동 종료합니다.`);
        await stop();
      }
    } catch (e) {
      console.error("[docling] idle watcher:", e.message);
    }
  }, 60000);
  timer.unref();
}

module.exports = { status, start, stop, startIdleWatcher };
