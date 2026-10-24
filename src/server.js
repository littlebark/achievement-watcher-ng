// 本地 Web GUI：游戏库 + 成就详情 + 设置
// 只监听 127.0.0.1，供浏览器访问；数据全部复用 core 层
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, encrypt, resolvedPaths } from "./core/config.js";
import { getWatchFolders, loadUserDirs } from "./core/discover.js";
import { parseAchievementFile } from "./core/normalize/file-parsers.js";
import { getGameData, dataRoot } from "./core/schema.js";
import { matchAchievements } from "./core/match.js";
import { log } from "./shared/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");
const START_PORT = Number(process.env.AW2_UI_PORT) || 8090;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

// ---------- 游戏库 ----------
let libCache = { at: 0, data: null };

async function loadOneGame(appid, folder, cfg) {
  const base = {
    appid,
    name: null,
    header: null,
    icon: null,
    total: 0,
    unlocked: 0,
    percent: 0,
    lastUnlock: 0,
    source: folder.source,
    dir: folder.dir,
    error: null,
  };

  try {
    const file = path.join(folder.dir, folder.files[0]);
    const entries = await parseAchievementFile(file);
    const game = await getGameData({
      appID: appid,
      lang: cfg.lang,
      apiKey: cfg._primaryKey,
      fallbackKey: cfg._fallbackKey,
    });
    const pairs = matchAchievements(game.achievement.list, entries);
    const unlockedPairs = pairs.filter((p) => p.local.Achieved);

    return {
      ...base,
      name: game.name,
      header: game.img?.header || null,
      icon: game.img?.icon || null,
      total: game.achievement.total || game.achievement.list.length,
      unlocked: unlockedPairs.length,
      percent: game.achievement.list.length
        ? Math.round((unlockedPairs.length / game.achievement.list.length) * 100)
        : 0,
      lastUnlock: unlockedPairs.reduce((m, p) => Math.max(m, +p.local.UnlockTime || 0), 0),
    };
  } catch (e) {
    return { ...base, name: `App ${appid}`, error: e.message };
  }
}

// 已缓存 schema 但当前没有成就存档的游戏（原版也会列出，显示 0%）
async function cachedSchemaAppids(lang) {
  const dir = path.join(dataRoot(), "steam_cache", "schema", lang);
  try {
    const files = await fsp.readdir(dir);
    return files.filter((f) => /^\d+\.db$/.test(f)).map((f) => f.replace(/\.db$/, ""));
  } catch {
    return [];
  }
}

async function readCachedSchema(appid, lang) {
  try {
    const p = path.join(dataRoot(), "steam_cache", "schema", lang, `${appid}.db`);
    return JSON.parse(await fsp.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function buildLibrary(force = false) {
  if (!force && libCache.data && Date.now() - libCache.at < 60_000) return libCache.data;

  const cfg = await loadConfig();
  const userDirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
  const folders = await getWatchFolders({ userDirs });

  const byApp = new Map();
  for (const f of folders) {
    if (!f.appid) continue;
    if (!byApp.has(f.appid)) byApp.set(f.appid, f);
  }

  const games = [];
  for (const [appid, folder] of byApp) {
    games.push(await loadOneGame(appid, folder, cfg));
  }

  // 补充：有缓存 schema 但没找到存档的游戏（保留在库里，标记 无存档）
  for (const appid of await cachedSchemaAppids(cfg.lang)) {
    if (byApp.has(appid)) continue;
    const cached = await readCachedSchema(appid, cfg.lang);
    if (!cached?.achievement?.list?.length) continue;
    games.push({
      appid,
      name: cached.name || `App ${appid}`,
      header: cached.img?.header || null,
      icon: cached.img?.icon || null,
      total: cached.achievement.list.length,
      unlocked: 0,
      percent: 0,
      lastUnlock: 0,
      source: "缓存",
      dir: "",
      noSave: true,
      error: null,
    });
  }

  games.sort((a, b) => (b.lastUnlock || 0) - (a.lastUnlock || 0) || String(a.name).localeCompare(String(b.name)));

  const totalUnlocked = games.reduce((s, g) => s + g.unlocked, 0);
  const perfect = games.filter((g) => g.total > 0 && g.unlocked >= g.total).length;
  const rated = games.filter((g) => g.total > 0);
  const avg = rated.length ? Math.round(rated.reduce((s, g) => s + g.percent, 0) / rated.length) : 0;

  const data = {
    games,
    profile: {
      name: process.env.USERNAME || "Player",
      gameCount: games.length,
      totalUnlocked,
      totalAchievements: games.reduce((s, g) => s + g.total, 0),
      perfect,
      avgCompletion: avg,
    },
    scannedAt: Date.now(),
  };

  libCache = { at: Date.now(), data };
  return data;
}

async function getGameDetail(appid) {
  const cfg = await loadConfig();
  const userDirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
  const folders = await getWatchFolders({ userDirs });
  const folder = folders.find((f) => f.appid === appid);

  // 无存档：只展示 schema（全部未解锁）
  if (!folder) {
    const cached = await readCachedSchema(appid, cfg.lang);
    if (!cached?.achievement?.list?.length) throw new Error(`未找到 appid=${appid} 的成就数据`);
    return {
      appid,
      name: cached.name || `App ${appid}`,
      header: cached.img?.header || null,
      source: "缓存（无存档）",
      dir: "",
      total: cached.achievement.list.length,
      unlocked: 0,
      achievements: cached.achievement.list.map((a) => ({
        name: a.name,
        displayName: a.displayName || a.name,
        description: a.description || "",
        hidden: !!a.hidden,
        icon: a.icon || null,
        icongray: a.icongray || null,
        achieved: false,
        unlockTime: 0,
        cur: 0,
        max: 0,
      })),
    };
  }

  const entries = await parseAchievementFile(path.join(folder.dir, folder.files[0]));
  const game = await getGameData({
    appID: appid,
    lang: cfg.lang,
    apiKey: cfg._primaryKey,
    fallbackKey: cfg._fallbackKey,
  });
  const pairs = matchAchievements(game.achievement.list, entries);

  const achievements = pairs.map((p) => ({
    name: p.schemaAchievement.name,
    displayName: p.schemaAchievement.displayName || p.schemaAchievement.name,
    description: p.schemaAchievement.description || "",
    hidden: !!p.schemaAchievement.hidden,
    icon: p.schemaAchievement.icon || null,
    icongray: p.schemaAchievement.icongray || null,
    achieved: !!p.local.Achieved,
    unlockTime: +p.local.UnlockTime || 0,
    cur: +p.local.CurProgress || 0,
    max: +p.local.MaxProgress || 0,
  }));

  achievements.sort((a, b) => (b.achieved - a.achieved) || (b.unlockTime - a.unlockTime));

  return {
    appid,
    name: game.name,
    header: game.img?.header || null,
    source: folder.source,
    dir: folder.dir,
    total: game.achievement.list.length,
    unlocked: achievements.filter((a) => a.achieved).length,
    achievements,
  };
}

// ---------- 设置 ----------
function maskKey(key) {
  if (!key) return null;
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

async function getSettings() {
  const cfg = await loadConfig();
  const userDirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
  return {
    lang: cfg.lang,
    notify: cfg.notify,
    iconPrefetch: cfg.iconPrefetch,
    timeThreshold: cfg.timeThreshold,
    tick: cfg.tick,
    websocket: cfg.websocket,
    toast: cfg.toast,
    hasKey: !!cfg._primaryKey,
    keyMasked: maskKey(cfg._primaryKey),
    hasFallbackKey: !!cfg._fallbackKey,
    fallbackKeyMasked: maskKey(cfg._fallbackKey),
    dataRoot: dataRoot(),
    userDirs,
    wall: cfg.wall || { dir: "" },
    paths: {
      emuRoots: resolvedPaths(cfg).emuRoots,
      emuExtraSources: resolvedPaths(cfg).emuExtraSources,
      gameSearchDirs: resolvedPaths(cfg).gameSearchDirs,
    },
    pathsCustom: {
      emuRoots: Array.isArray(cfg.paths?.emuRoots) && cfg.paths.emuRoots.length > 0,
      emuExtraSources: Array.isArray(cfg.paths?.emuExtraSources) && cfg.paths.emuExtraSources.length > 0,
      gameSearchDirs: Array.isArray(cfg.paths?.gameSearchDirs) && cfg.paths.gameSearchDirs.length > 0,
    },
  };
}

async function updateSettings(body) {
  const cfg = await loadConfig();

  if (typeof body.lang === "string" && body.lang) cfg.lang = body.lang;
  if (typeof body.notify === "boolean") cfg.notify = body.notify;
  if (typeof body.iconPrefetch === "boolean") cfg.iconPrefetch = body.iconPrefetch;
  if (Number.isFinite(+body.timeThreshold) && +body.timeThreshold >= 0) cfg.timeThreshold = +body.timeThreshold;
  if (Number.isFinite(+body.tick) && +body.tick >= 0) cfg.tick = +body.tick;
  if (body.websocket && typeof body.websocket === "object") {
    cfg.websocket = {
      enabled: !!body.websocket.enabled,
      port: Number(body.websocket.port) || 8082,
      auth: cfg.websocket?.auth ?? null,
    };
  }
  if (typeof body.steamApiKey === "string" && body.steamApiKey.trim()) {
    cfg.steamApiKey = encrypt(body.steamApiKey.trim());
  }
  if (typeof body.steamApiFallbackKey === "string" && body.steamApiFallbackKey.trim()) {
    cfg.steamApiFallbackKey = encrypt(body.steamApiFallbackKey.trim());
  }

  // 可配置路径
  if (body.wall && typeof body.wall === "object") {
    if (typeof body.wall.dir === "string") cfg.wall = { ...cfg.wall, dir: body.wall.dir.trim() };
  }
  if (body.paths && typeof body.paths === "object") {
    const clean = (v) => Array.isArray(v)
      ? v.map((s) => String(s).trim()).filter(Boolean)
      : null;
    for (const key of ["emuRoots", "emuExtraSources", "gameSearchDirs"]) {
      const v = clean(body.paths[key]);
      if (v) cfg.paths = { ...cfg.paths, [key]: v }; // 空数组 = 恢复内置默认
    }
  }

  await saveConfig(cfg);
  libCache = { at: 0, data: null }; // 语言/设置变更后重新扫描
  return getSettings();
}

// ---------- HTTP ----------
function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 1e6) throw new Error("payload too large");
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const full = path.resolve(WEB_DIR, rel);
  if (!full.startsWith(path.resolve(WEB_DIR))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const buf = await fsp.readFile(full);
    res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;

  try {
    if (p === "/api/library") {
      const force = url.searchParams.get("refresh") === "1";
      return sendJSON(res, 200, await buildLibrary(force));
    }

    if (p.startsWith("/api/game/")) {
      const appid = p.slice("/api/game/".length);
      if (!/^\d+$/.test(appid)) return sendJSON(res, 400, { error: "bad appid" });
      return sendJSON(res, 200, await getGameDetail(appid));
    }

    if (p === "/api/settings" && req.method === "GET") {
      return sendJSON(res, 200, await getSettings());
    }

    if (p === "/api/settings" && req.method === "POST") {
      const body = await readBody(req);
      return sendJSON(res, 200, await updateSettings(body));
    }

    if (p === "/api/health") {
      return sendJSON(res, 200, { ok: true, pid: process.pid });
    }

    return serveStatic(res, p);
  } catch (e) {
    log.error(`[UI] ${p}: ${e.message}`);
    return sendJSON(res, 500, { error: e.message });
  }
});

function listen(port, attempt = 0) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < 10) return listen(port + 1, attempt + 1);
    log.error(`[UI] ${err.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    log.info(`[UI] ${url}`);
    console.log(`aw2 面板已启动：${url}`);
    console.log("（关闭此窗口即停止面板；watchdog 可独立运行）");
    if (!process.env.AW2_NO_OPEN) openBrowser(url);
  });
}

function openBrowser(url) {
  try {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch { /* 用户手动打开 */ }
}

export function startUI(port = START_PORT) {
  listen(port);
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startUI();
}
