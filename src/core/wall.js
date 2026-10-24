// 成就墙（Achievement Wall）：把所有模拟器/破解组的成就归一化为 Steam 成就字段标准，
// 落到用户指定目录，作为自建成就墙的数据源。
//
// 目录结构：
//   <wallDir>/index.json               — 全部游戏摘要（目录页用，按最近解锁排序）
//   <wallDir>/<appid>/schema.json      — Steam schema 标准（icon/icongray 改为本地相对路径 icons/xxx.png）
//   <wallDir>/<appid>/progress.json    — [{ name, achieved, unlockTime, curProgress, maxProgress }]
//                                        （name=Steam apiname，achieved=0/1，unlockTime=Unix 秒，Steam 字段的超集）
//   <wallDir>/<appid>/icons/           — 彩色+灰色图标（按 Steam CDN hash 命名）
import path from "node:path";
import fsp from "node:fs/promises";
import { exists, writeJSON } from "../shared/fsx.js";
import { getGameData } from "./schema.js";
import { getWatchFolders, loadUserDirs } from "./discover.js";
import { parseAchievementFile } from "./normalize/file-parsers.js";
import { matchAchievements } from "./match.js";
import * as track from "./track.js";
import { dataRoot } from "./schema.js";
import { log } from "../shared/log.js";

async function downloadTo(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error("文件过小，疑似 CDN 异常");
  await fsp.writeFile(filePath, buf);
}

// 下载缺失的图标（已存在的跳过，断点续传）
async function ensureIcons(dl, imgDir) {
  const missing = [];
  for (const [url, dest] of dl) {
    if (!(await exists(dest))) missing.push([url, dest]);
  }
  let ok = 0;
  const fail = [];
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(missing.slice(i, i + 8).map(async ([url, dest]) => {
      try { await downloadTo(url, dest); ok++; }
      catch (e) { fail.push(`${path.basename(dest)}: ${e.message}`); }
    }));
  }
  return { ok, fail };
}

// 归一化为 Steam 成就字段标准
// schemaList: Steam schema.achievement.list
// pairs: matchAchievements 的结果（当前成就文件里的状态）
// previous: track 缓存（watchdog 积累的历史状态，比单次解析更全）
export function normalizeProgress(schemaList, pairs, previous = []) {
  const localByName = new Map(pairs.map((p) => [String(p.schemaAchievement.name).toUpperCase(), p.local]));
  const prevByName = new Map(previous.map((a) => [String(a.name || "").toUpperCase(), a]));
  return schemaList.map((a) => {
    const key = a.name.toUpperCase();
    const src = localByName.get(key) || prevByName.get(key) || {};
    return {
      name: a.name,                                   // Steam apiname
      achieved: src.Achieved ? 1 : 0,                 // Steam: 0/1
      unlockTime: +src.UnlockTime || 0,               // Steam: Unix 秒
      curProgress: +src.CurProgress || 0,             // 扩展字段：进度型成就
      maxProgress: +src.MaxProgress || 0,
    };
  });
}

// 写单个游戏的墙数据（schema.json + progress.json + 缺失图标）
async function writeGame({ appid, game, progress, wallDir, withIcons = true }) {
  const dir = path.join(wallDir, String(appid));
  const imgDir = path.join(dir, "icons");
  await fsp.mkdir(imgDir, { recursive: true });

  const dl = [];
  const list = game.achievement.list.map((a) => {
    const o = { ...a };
    for (const k of ["icon", "icongray"]) {
      if (a[k]) {
        const file = a[k].split("/").pop();
        o[k] = `icons/${file}`;
        if (withIcons) dl.push([a[k], path.join(imgDir, file)]);
      }
    }
    return o;
  });

  await writeJSON(path.join(dir, "schema.json"), {
    name: game.name,
    appid: String(appid),
    img: game.img || {},
    achievement: { total: list.length, list },
  });
  await writeJSON(path.join(dir, "progress.json"), progress);

  const icons = withIcons ? await ensureIcons(dl, imgDir) : { ok: 0, fail: [] };

  const unlocked = progress.filter((p) => p.achieved).length;
  const lastUnlock = progress.reduce((m, p) => Math.max(m, p.unlockTime || 0), 0);
  return {
    appid: String(appid),
    name: game.name,
    total: list.length,
    unlocked,
    percent: list.length ? Math.round((unlocked / list.length) * 100) : 0,
    lastUnlock,
    header: game.img?.header || null,
    icons,
  };
}

// 全量导出：扫描所有监视目录 → 归一化 → 落盘
export async function exportWall({ cfg, wallDir, withIcons = true, appids = null }) {
  wallDir = path.resolve(wallDir);
  await fsp.mkdir(wallDir, { recursive: true });

  const userDirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
  const folders = await getWatchFolders({ userDirs });

  const byApp = new Map();
  for (const f of folders) {
    if (!f.appid) continue;
    if (appids && !appids.includes(String(f.appid))) continue;
    if (!byApp.has(f.appid)) byApp.set(f.appid, f);
  }
  if (!byApp.size) throw new Error("没有可导出的游戏（先跑 scan 确认监视目录）");

  const index = [];
  const errors = [];
  for (const [appid, folder] of byApp) {
    try {
      const game = await getGameData({
        appID: String(appid),
        lang: cfg.lang,
        apiKey: cfg._primaryKey,
        fallbackKey: cfg._fallbackKey,
      });
      const entries = await parseAchievementFile(path.join(folder.dir, folder.files[0]));
      const pairs = matchAchievements(game.achievement.list, entries || []);
      const previous = await track.load(appid);
      const progress = normalizeProgress(game.achievement.list, pairs, previous);
      const summary = await writeGame({ appid, game, progress, wallDir, withIcons });
      index.push(summary);
      log.info?.(`[WALL] ${summary.name}: ${summary.unlocked}/${summary.total}` +
        (summary.icons?.fail?.length ? `（图标失败 ${summary.icons.fail.length}）` : ""));
    } catch (e) {
      errors.push(`${appid}: ${e.message}`);
      log.warn?.(`[WALL] ${appid}: ${e.message}`);
    }
  }

  index.sort((a, b) => b.lastUnlock - a.lastUnlock || b.percent - a.percent);
  await writeJSON(path.join(wallDir, "index.json"), {
    updatedAt: new Date().toISOString(),
    dir: wallDir,
    games: index,
  });

  return { wallDir, games: index, errors };
}

// watchdog 实时同步：解锁后调用（轻量，只写受影响的游戏）
export async function syncGameWall({ appid, game, pairs, previous, cfg }) {
  const wallDir = cfg.wall?.dir;
  if (!wallDir) return null;
  try {
    const progress = normalizeProgress(game.achievement.list, pairs, previous);
    return await writeGame({ appid, game, progress, wallDir, withIcons: true });
  } catch (e) {
    log.warn(`[WALL] 同步 ${appid} 失败: ${e.message}`);
    return null;
  }
}
