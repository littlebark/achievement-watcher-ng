// detect-steam-game.mjs
// 零依赖：从任意游戏目录识别 Steam AppID（仅此而已，不涉及存档/成就路径）。
// 逻辑搬运自 AW2（emugen.js / discover.js 的 appid 识别部分），
// 但不 import 项目内任何模块，可被任何外部程序调用。
//
// ⚠️ 本文件是 AW2 appid 识别逻辑的【独立副本】。AW2 主仓库改了识别逻辑（如把按层数扫描
//    改成 findFiles 全树搜索、新增 RUNE 的 steam_emu.ini 解析）时必须同步改这里，否则会脱钩。
//
// 作为模块使用：
//   import { detectSteamGame } from "./detect-steam-game.mjs";
//   const appid = await detectSteamGame("F:/Games/SomeGame");
//   // → "2288630" 或 null
//
// 作为 CLI 使用：
//   node detect-steam-game.mjs <游戏目录>
//   → 仅打印 appid（无则打印空行）

import path from "node:path";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";

// ============================================================
// 按文件名全树搜索（不限深度）。游戏目录里我们只关心少数固定文件名
// （steam_appid.txt / steam_emu.ini / rune.ini / steam_api*.dll 等），
// 用文件名直接定位，无论埋多深都能找到，避免“层数不够导致漏识别”。
// maxFiles 为安全上限：极端大目录扫描到上限即停止（best-effort）。
// skip 跳过绝不可能是模拟器配置的目录；符号链接目录 isDirectory() 为 false，天然不跟随（防环）。
// —— 与 AW2 src/shared/fsx.js 的 findFiles 行为一致。
// ============================================================
const DEFAULT_FIND_SKIP = /^(node_modules|\.git|\.svn|\.hg|__MACOSX)$/i;

async function findFiles(root, { names = [], maxFiles = 200000, skip = DEFAULT_FIND_SKIP } = {}) {
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

// ============================================================
// AppID 识别（四路 fallback，与 AW2 行为一致）
// ============================================================

// 直接读本目录或 steam_settings 下的 steam_appid.txt（浅层快捷路径）
async function readAppidIn(dir) {
  for (const rel of ["steam_appid.txt", path.join("steam_settings", "steam_appid.txt")]) {
    try {
      const txt = (await fsp.readFile(path.join(dir, rel), "utf8")).trim();
      if (/^\d+$/.test(txt)) return txt;
    } catch { /* next */ }
  }
  return null;
}

// 1) 优先 steam_appid.txt：本目录优先，否则全树找（不限深度），路径更浅的优先
async function detectGameAppid(gameDir) {
  const direct = await readAppidIn(gameDir);
  if (direct) return direct;

  const files = await findFiles(gameDir, { names: [/^steam_appid\.txt$/i] });
  if (!files.length) return null;
  files.sort((a, b) => path.resolve(a).split(path.sep).length - path.resolve(b).split(path.sep).length);
  for (const f of files) {
    try {
      const txt = (await fsp.readFile(f, "utf8")).trim();
      if (/^\d+$/.test(txt)) return txt;
    } catch { /* next */ }
  }
  return null;
}

// 从 ini 文本取 AppId=（兼容 AppID / appid / 不同空白写法）
function readAppIdLine(txt) {
  const m = txt.match(/^\s*AppId\s*=\s*(\d{3,8})\s*$/im);
  return m ? m[1] : null;
}

// 2) RUNE 等模拟器的专属 ini：RUNE 不生成 steam_appid.txt，AppID 写在 steam_emu.ini 的 AppId= 行。
//    这些 ini 可能埋在任意深度（如 UE 的 Engine/Binaries/.../Win64/），故全树找，
//    并优先选与 steam_api*.dll 同目录的那份（最贴近游戏本体）。
async function readAppidFromEmuIni(gameDir) {
  const iniFiles = await findFiles(gameDir, { names: [/^steam_emu\.ini$/i, /^rune\.ini$/i] });
  if (!iniFiles.length) return null;
  const dllDirs = new Set(
    (await findFiles(gameDir, { names: [/^steam_api(64)?\.dll$/i] })).map((f) => path.dirname(f).toLowerCase())
  );
  for (const f of iniFiles) {
    if (dllDirs.has(path.dirname(f).toLowerCase())) {
      const v = readAppIdLine(await fsp.readFile(f, "utf8"));
      if (v) return v;
    }
  }
  for (const f of iniFiles) {
    const v = readAppIdLine(await fsp.readFile(f, "utf8"));
    if (v) return v;
  }
  return null;
}

// 3) 上游配置（SmartSteamEmu 的 SteamConfig.ini / SmartSteamEmu.ini / flt.ini，或 steam_appid.txt）。
//    这些文件可能埋在任意深度（如 FF IX 的 x64\SteamConfig.ini），故全树找。
async function appidFromConfig(dir) {
  const files = await findFiles(dir, {
    names: [/^SteamConfig\.ini$/i, /^SmartSteamEmu\.ini$/i, /^steam_appid\.txt$/i, /^flt\.ini$/i],
  });
  for (const f of files) {
    try {
      const m = (await fsp.readFile(f, "utf8")).match(/(?:^\s*(?:AppID|AppId|appid)\s*=\s*|^\s*)(\d{3,8})\s*$/im);
      if (m) return m[1];
    } catch { /* next */ }
  }
  return null;
}

// 4) 路径末尾数字段（如 .../2288630）
function appidFromPath(dirPath) {
  const m = dirPath
    .replace(/(\\stats$)|(\\SteamEmu$)|(\\SteamEmu\\UserStats$)/g, "")
    .match(/([0-9]+)$/);
  return m ? m[0] : null;
}

// ============================================================
// 主入口：输入文件夹 → 返回 appid（string | null）
// ============================================================
export async function detectSteamGame(dir) {
  const gameDir = path.resolve(dir);
  let st;
  try { st = await fsp.stat(gameDir); } catch { st = null; }
  if (!st?.isDirectory()) throw new Error(`目录不存在：${gameDir}`);

  const appid =
    (await detectGameAppid(gameDir))
    || (await readAppidFromEmuIni(gameDir))
    || (await appidFromConfig(gameDir))
    || appidFromPath(gameDir)
    || null;
  return appid;
}

// ============================================================
// CLI
// ============================================================
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) {
    console.error("用法: node detect-steam-game.mjs <游戏目录>");
    process.exit(1);
  }
  try {
    const appid = await detectSteamGame(target);
    if (appid) console.log(appid);
    else { console.error("未能识别到 Steam AppID"); process.exit(2); }
  } catch (e) {
    console.error("错误:", e.message);
    process.exit(1);
  }
}
