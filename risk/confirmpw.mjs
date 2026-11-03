// 사건 카드 '확정' 때 다시 입력하는 비밀번호.
//  - 별도로 정한 값이 없으면 입장 비밀번호(secrets/access.json 의 scrypt 해시)와 같은 값을 쓴다.
//  - 따로 바꾸면 settings 테이블(key='confirm_pw')에 salt/hash 만 저장한다. 평문은 어디에도 저장하지 않는다.
//  - 틀리게 입력하면 IP 별로 10분에 5번까지만 허용한다.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { _db, HttpError } from "./store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ACCESS = join(here, "secrets", "access.json");
const { q1, run, nowIso } = _db;

const check = (pw, c) => { const h = scryptSync(String(pw), Buffer.from(c.salt, "hex"), 32), e = Buffer.from(c.hash, "hex"); return h.length === e.length && timingSafeEqual(h, e); };
function current() {
  const r = q1("SELECT value FROM settings WHERE key='confirm_pw'");
  if (r) { try { return { custom: true, cred: JSON.parse(r.value) }; } catch {} }
  if (!existsSync(ACCESS)) throw new HttpError(500, "접속 비밀번호 설정이 없습니다");
  return { custom: false, cred: JSON.parse(readFileSync(ACCESS, "utf8")) };
}

const fails = new Map();
const locked = (ip) => { const f = fails.get(ip); return f && f.n >= 5 && Date.now() - f.at < 10 * 60e3; };
export function verifyConfirm(pw, ip = "") {
  if (locked(ip)) throw new HttpError(429, "비밀번호를 여러 번 틀렸습니다. 10분 뒤에 다시 하세요");
  if (!pw) throw new HttpError(400, "확정 비밀번호를 입력하세요");
  if (check(pw, current().cred)) { fails.delete(ip); return true; }
  const f = fails.get(ip) || { n: 0, at: 0 }; fails.set(ip, { n: f.n + 1, at: Date.now() });
  throw new HttpError(403, "확정 비밀번호가 맞지 않습니다");
}
export const confirmPwInfo = () => ({ custom: current().custom });
export function setConfirmPassword(cur, next, ip = "") {
  verifyConfirm(cur, ip);
  if (String(next || "").length < 6) throw new HttpError(400, "새 확정 비밀번호는 6자 이상이어야 합니다");
  const salt = randomBytes(16);
  run("INSERT INTO settings (key,value,updated_at) VALUES ('confirm_pw',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    JSON.stringify({ salt: salt.toString("hex"), hash: scryptSync(String(next), salt, 32).toString("hex") }), nowIso());
  return { custom: true };
}
export function resetConfirmPassword(cur, ip = "") {   // 별도 설정을 지우고 입장 비밀번호와 같은 값으로 되돌린다
  verifyConfirm(cur, ip); run("DELETE FROM settings WHERE key='confirm_pw'"); return { custom: false };
}
