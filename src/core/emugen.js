// emu-gen：为 Goldberg/gbe_fork 系模拟器一键生成 steam_settings 成就配置
// 复用 aw2 的 schema 缓存与 API Key，生成 achievements.json（gbe_fork 官方格式）+ 下载图标
// 用法: node src/cli.js emu-gen <appid> [游戏目录] [--no-icons]
import path from "node:path";
import fsp from "node:fs/promises";
import { exists, writeJSON, findFiles } from "../shared/fsx.js";
import { log } from "../shared/log.js";
import { httpFetch as fetch } from "../shared/http.js";
import { getGameData } from "./schema.js";
import { loadConfig, resolvedPaths } from "./config.js";

async function downloadTo(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error("文件过小，疑似 CDN 异常");
  await fsp.writeFile(filePath, buf);
}

// 找游戏目录下所有含 steam_api*.dll 的目录（全树搜索，不限深度）
async function findGameDirs(root) {
  const files = await findFiles(root, { names: [/^steam_api(64)?\.dll$/i] });
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const d = path.dirname(f);
    const k = d.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(d); }
  }
  return out;
}

async function readAppidIn(dir) {
  for (const rel of ["steam_appid.txt", path.join("steam_settings", "steam_appid.txt")]) {
    try {
      const txt = (await fsp.readFile(path.join(dir, rel), "utf8")).trim();
      if (/^\d+$/.test(txt)) return txt;
    } catch { /* next */ }
  }
  return null;
}

// 从游戏目录推断 appid：全树找 steam_appid.txt（不限深度），优先路径更浅的
// （Unity 游戏 steam_settings 可能在 Duckov_Data/Plugins/x86_64/ 第 5 层，深度不足会漏识别 —— 故全树搜）
export async function detectGameAppid(gameDir) {
  const direct = await readAppidIn(gameDir);
  if (direct) return direct;

  const files = await findFiles(gameDir, { names: [/^steam_appid\.txt$/i] });
  if (!files.length) return null;
  // 路径更浅的优先（根目录 / steam_settings 内的 steam_appid.txt 排前面）
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

// 从 RUNE 等模拟器的专属 ini 读取 AppID（纯读取，不写文件）。
// RUNE 不生成 steam_appid.txt，其 AppID 写在 steam_emu.ini 的 AppId= 行。
// 这些 ini 可能埋在任意深度（如 UE 的 Engine/Binaries/.../Win64/），故用 findFiles 全树查找，
// 并优先选与 steam_api*.dll 同目录的那份（最贴近游戏本体）。
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

// 打补丁流程解析 AppID：优先 steam_appid.txt；若游戏已被 RUNE 等模拟器接管但缺该文件，
// 则从 steam_emu.ini 推断并自动在游戏根目录补全 steam_appid.txt，使后续流程无感继续。
// 返回 appid 字符串；两者都失败则抛出明确错误。
export async function resolveAppidForPatch(gameDir) {
  const direct = await detectGameAppid(gameDir);
  if (direct) return direct;

  const emuAppid = await readAppidFromEmuIni(gameDir);
  if (emuAppid) {
    const appidFile = path.join(gameDir, "steam_appid.txt");
    if (!(await exists(appidFile))) {
      await fsp.writeFile(appidFile, emuAppid + "\n");
      log.info(`[PATCH] 检测到 RUNE 接管（steam_emu.ini AppId=${emuAppid}），已自动生成 ${appidFile}`);
    }
    return emuAppid;
  }
  throw new Error("在所选目录里没找到 steam_appid.txt，也无法从模拟器配置（steam_emu.ini）推断 AppID。请选游戏根目录（通常能看到 steam_api64.dll 或游戏 exe）");
}

// 扫描已打补丁（无论谁打的）但可能还没进面板的游戏：
// 找出游戏目录里所有 emu DLL 层，从 steam_appid.txt（emu 运行的必需品）读 appid。
// 返回 [{ appid, dir }]，按 appid 去重。
export async function scanPatchedGames(searchDirs = []) {
  const found = new Map();
  for (const root of searchDirs) {
    for (const dir of await findGameDirs(root)) {
      const appid = await readAppidIn(dir);
      if (appid && !found.has(appid)) found.set(appid, dir);
    }
  }
  return [...found.entries()].map(([appid, dir]) => ({ appid, dir }));
}

export async function generateEmuConfig({ appid, gameDir, lang, withIcons = true, apiKey, fallbackKey }) {
  const game = await getGameData({ appID: String(appid), lang, apiKey, fallbackKey });
  const list = game.achievement.list;
  if (!list?.length) throw new Error(`SCHEMA_EMPTY: appid=${appid} 无成就数据`);

  const settingsDir = path.join(gameDir, "steam_settings");
  const imgDir = path.join(settingsDir, "achievement_images");
  await fsp.mkdir(imgDir, { recursive: true });

  // 与旧配置 diff（如有）
  const oldFile = path.join(settingsDir, "achievements.json");
  let oldList = null;
  if (await exists(oldFile)) {
    try { oldList = JSON.parse(await fsp.readFile(oldFile, "utf8")); } catch { oldList = "损坏"; }
  }
  const oldNames = oldList instanceof Array ? new Set(oldList.map((a) => a.name)) : oldList;
  const oldByName = oldList instanceof Array ? new Map(oldList.map((a) => [a.name, a])) : new Map();

  const out = [];
  const dl = [];
  for (const a of list) {
    const o = {};
    o.description = a.description || "";
    o.displayName = a.displayName || a.name;
    o.hidden = a.hidden ? 1 : 0;
    const old = oldByName.get(a.name);
    for (const k of ["icon", "icongray"]) {
      // 沿用旧路径的条件：旧配置有同名项、其图标文件真实存在，且本次不下载图标
      const oldPath = old?.[k];
      if (oldPath && !withIcons && await exists(path.join(settingsDir, oldPath))) {
        o[k] = oldPath;
        continue;
      }
      if (a[k]) {
        const file = a[k].split("/").pop();
        o[k] = `achievement_images/${file}`;
        if (withIcons) dl.push([a[k], path.join(imgDir, file)]);
      }
    }
    o.name = a.name;
    out.push(o);
  }

  // 备份旧配置
  if (await exists(oldFile)) {
    await fsp.copyFile(oldFile, oldFile + ".bak");
  }
  await writeJSON(oldFile, out);

  // steam_appid.txt 一并保证
  const appidFile = path.join(settingsDir, "steam_appid.txt");
  if (!(await exists(appidFile))) {
    await fsp.writeFile(appidFile, String(appid) + "\n");
  }

  // 并发下载图标（每 8 个一批，防 CDN 限速）
  let ok = 0, fail = [];
  if (withIcons) {
    for (let i = 0; i < dl.length; i += 8) {
      await Promise.all(dl.slice(i, i + 8).map(async ([url, dest]) => {
        try { await downloadTo(url, dest); ok++; }
        catch (e) { fail.push(`${path.basename(dest)}: ${e.message}`); }
      }));
    }
  }

  const added = oldNames instanceof Set
    ? out.filter((a) => !oldNames.has(a.name)).map((a) => a.name)
    : [];
  const removed = oldNames instanceof Set
    ? [...oldNames].filter((n) => !out.some((a) => a.name === n))
    : [];

  return {
    gameName: game.name,
    total: out.length,
    settingsDir,
    overwritten: oldNames !== null,
    added, removed,
    icons: withIcons ? { ok, fail } : null,
  };
}

export async function autoFindGameDir(appid, scanRoots = null) {
  const roots = scanRoots?.length ? scanRoots : resolvedPaths(await loadConfig()).gameSearchDirs;
  for (const root of roots) {
    const dirs = await findGameDirs(root);
    for (const d of dirs) {
      if ((await readAppidIn(d)) === String(appid)) return d;
    }
  }
  return null;
}
