// Skyrim SE 风格 stats.bin 二进制解析（移植自原版 app/parser/sse.js）
// 每条目 24 字节；api_name 是 CRC32（存前 4 字节，需 reverse 取 hex）
import { crc32hex } from "../../shared/crc32.js";

export function readSSEBin(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("ERR_INVALID_ARGS");

  const header = buffer.slice(0, 4);
  const entryLen = 24;
  const body = buffer.slice(header.length);
  const chunks = [];
  for (let i = 0; i + entryLen <= body.length; i += entryLen) {
    chunks.push(body.slice(i, i + entryLen));
  }

  const expected = header.readInt32LE();
  if (chunks.length !== expected) throw new Error(`ERR_UNEXPECTED_STATS_COUNT (${chunks.length} != ${expected})`);

  const result = [];
  for (const chunk of chunks) {
    try {
      const value = chunk.slice(20, 24).readInt32LE();
      if (value > 1) continue; // >1 是普通统计数据，不是成就
      result.push({
        crc: crc32hex(Buffer.from([...chunk.slice(0, 4)].reverse())),
        Achieved: value,
        UnlockTime: chunk.slice(8, 12).readInt32LE(),
      });
    } catch { continue; }
  }
  return result;
}
