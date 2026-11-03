// 외부 라이브러리 없는 zip 읽기(docx·pptx·xlsx 는 zip). 중앙 디렉터리를 읽고 필요한 항목만 풀어 쓴다.
import { inflateRawSync } from "node:zlib";

const MAX_ENTRY = 60 * 1024 * 1024; // 항목 하나가 이보다 크게 풀리면 거부(zip 폭탄 방어)

export function openZip(buf) {
  let i = buf.length - 22;
  const lo = Math.max(0, buf.length - 65557);
  while (i >= lo && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < lo) throw new Error("zip 형식이 아닙니다");
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    entries.set(name, { name, method, csize, usize, off });
    p += 46 + nl + el + cl;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.usize > MAX_ENTRY) throw new Error(`zip 항목이 너무 큽니다: ${name}`);
    if (buf.readUInt32LE(e.off) !== 0x04034b50) throw new Error("zip 항목 헤더 오류");
    const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
    const raw = buf.subarray(start, start + e.csize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
    throw new Error(`지원하지 않는 압축 방식(${e.method})`);
  };
  return { names: [...entries.keys()], entries, read, readText: (n) => read(n)?.toString("utf8") ?? null };
}
