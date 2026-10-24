// emu-gen：为 Goldberg/gbe_fork 系模拟器一键生成 steam_settings 成就配置
// 复用 aw2 的 schema 缓存与 API Key，生成 achievements.json（gbe_fork 官方格式）+ 下载图标
// 用法: node src/cli.js emu-gen <appid> [游戏目录] [--no-icons]
import path from "node:path";
import fsp from "node:fs/promises";
import { exists, writeJSON } from "../shared/fsx.js";
import { getGameData } from "./schema.js";
import { loadConfig, resolvedPaths } from "./config.js";

async function downloadTo(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error("文件过小，疑似 CDN 异常");
  await fsp.writeFile(filePath, buf);
}

// 在根目录下找包含 steam_api*.dll 的游戏目录（限深 5 层）
async function findGameDirs(root, depth = 5, out = []) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return out; }
  const hasDll = entries.some((e) => e.isFile() && /^steam_api(\d{2})?\.dll$/i.test(e.name));
  if (hasDll) { out.push(root); return out; } // DLL 所在层即游戏根，不再深入
  if (depth <= 0) return out;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith(".")) {
      await findGameDirs(path.join(root, e.name), depth - 1, out);
    }
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
