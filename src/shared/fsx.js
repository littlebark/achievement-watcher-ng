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

// 按文件名全树搜索（不限深度）。游戏目录里我们只关心少数固定文件名
// （steam_appid.txt / steam_emu.ini / rune.ini / steam_api*.dll），用文件名直接定位，
// 无论埋多深都能找到，避免“层数不够导致漏识别”的反复修补。
// maxFiles 为安全上限：极端大目录扫描到上限即停止，返回已找到结果（best-effort）。
// skip 跳过绝不可能是模拟器配置的目录；符号链接目录 isDirectory() 为 false，天然不跟随（防环）。
const DEFAULT_FIND_SKIP = /^(node_modules|\.git|\.svn|\.hg|__MACOSX)$/i;

export async function findFiles(root, { names = [], maxFiles = 200000, skip = DEFAULT_FIND_SKIP } = {}) {
  const preds = names.map((n) =>
    n instanceof RegExp
      ? n
      : new RegExp("^" + String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i")
  );
  const out = [];
  let scanned = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (++scanned > maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.test(e.name)) continue;
        await walk(full);
      } else if (preds.some((re) => re.test(e.name))) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}
