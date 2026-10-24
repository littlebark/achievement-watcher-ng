// fs / 路径工具 —— 替代 @xan105/fs
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export { fsp };

export async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

export async function readJSON(p) {
  return JSON.parse(await fsp.readFile(p, "utf8"));
}

export async function writeJSON(p, data, space = 2) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(data, null, space), "utf8");
}

// 缓存文件是否比 maxAgeMs 新
export async function isYoungerThan(p, maxAgeMs) {
  try {
    const st = await fsp.stat(p);
    return Date.now() - st.mtimeMs < maxAgeMs;
  } catch { return false; }
}

export async function mtimeMs(p) {
  try { return (await fsp.stat(p)).mtimeMs; } catch { return 0; }
}

// Windows 文件名非法字符清理（用于截图/文件名）
export function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "").trim();
}

// 递归列出 dir 下满足 test(目录绝对路径) 的目录（限制深度，避免全盘慢扫失控）
export async function walkDirs(dir, { depth = 3, test } = {}) {
  const found = [];
  async function rec(d, level) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (!test || test(full, e.name)) found.push(full);
      if (level < depth) await rec(full, level + 1);
    }
  }
  await rec(dir, 0);
  return found;
}
