// 本地 Web GUI：游戏库 + 成就详情 + 设置
// 只监听 127.0.0.1，供浏览器访问；数据全部复用 core 层
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, encrypt, resolvedPaths, resolveWallDir, soundsDir } from "./core/config.js";
import { getWatchFolders, loadUserDirs } from "./core/discover.js";
import { parseAchievementFile } from "./core/normalize/file-parsers.js";
import { getGameData, prefetchSchemas, dataRoot } from "./core/schema.js";
import { matchAchievements } from "./core/match.js";
import { detectGameAppid, scanPatchedGames } from "./core/emugen.js";
import { applyEmu } from "./core/emuinstall.js";
import { log } from "./shared/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");
const START_PORT = Number(process.env.AW2_UI_PORT) || 5179;

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
    offline: false,
  };

  let entries;

  try {
    const file = path.join(folder.dir, folder.files[0]);
    entries = await parseAchievementFile(file);
  } catch (e) {
    return { ...base, name: `App ${appid}`, error: `存档解析失败：${e.message}` };
  }

  try {
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
    // schema 拿不到（断网/接口异常）：用本地存档降级展示，名称回退为存档里的条目名
    if (entries.length) {
      const done = entries.filter((x) => x.Achieved);
      return {
        ...base,
        name: `App ${appid}`,
        header: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
        total: entries.length,
        unlocked: done.length,
        percent: Math.round((done.length / entries.length) * 100),
        lastUnlock: done.reduce((m, x) => Math.max(m, +x.UnlockTime || 0), 0),
        offline: true,
        offlineReason: e.message,
      };
    }
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
      name: (cfg.profile?.name || "").trim() || process.env.USERNAME || "Player",
      custom: !!(cfg.profile?.name || "").trim(),
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

  let game;
  try {
    game = await getGameData({
      appID: appid,
      lang: cfg.lang,
      apiKey: cfg._primaryKey,
      fallbackKey: cfg._fallbackKey,
    });
  } catch (e) {
    // schema 不可用：用本地存档键名降级展示，至少能看到解锁了什么
    if (!entries.length) throw e;
    const done = entries.filter((x) => x.Achieved);
    return {
      appid,
      name: `App ${appid}`,
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
      source: folder.source,
      dir: folder.dir,
      total: entries.length,
      unlocked: done.length,
      offline: true,
      offlineReason: e.message,
      achievements: done
        .sort((a, b) => (+b.UnlockTime || 0) - (+a.UnlockTime || 0))
        .map((x) => ({
          name: x.Name,
          displayName: x.Name,
          description: "",
          hidden: false,
          icon: null,
          icongray: null,
          achieved: true,
          unlockTime: +x.UnlockTime || 0,
          cur: +x.CurProgress || 0,
          max: +x.MaxProgress || 0,
        })),
    };
  }
  const pairs = matchAchievements(game.achievement.list, entries);
  const localByName = new Map(pairs.map((p) => [String(p.schemaAchievement.name).toUpperCase(), p.local]));

  // 以 Steam schema 为准列出全部成就（未解锁的也展示，而不是只显示已解锁的）
  const achievements = game.achievement.list.map((a) => {
    const local = localByName.get(String(a.name).toUpperCase()) || {};
    return {
      name: a.name,
      displayName: a.displayName || a.name,
      description: a.description || "",
      hidden: !!a.hidden,
      icon: a.icon || null,
      icongray: a.icongray || null,
      achieved: !!local.Achieved,
      unlockTime: +local.UnlockTime || 0,
      cur: +local.CurProgress || 0,
      max: +local.MaxProgress || 0,
    };
  });

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

// ---------- 成就预下载（不懒加载：提前把 schema 落到本地，解锁时不依赖网络） ----------
let prefetchState = { running: false, at: 0, result: null };

async function prefetchAllAchievements(force = false) {
  if (prefetchState.running) return { alreadyRunning: true, at: prefetchState.at };

  const cfg = await loadConfig();
  const userDirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
  const folders = await getWatchFolders({ userDirs });
  const known = new Set(folders.map((f) => String(f.appid)).filter(Boolean));

  // 自动扫描游戏目录里"已打补丁但还没运行"的游戏（appid 来自 emu 必需的 steam_appid.txt，零输入）
  const scanned = (await scanPatchedGames(resolvedPaths(cfg).gameSearchDirs))
    .map((s) => s.appid)
    .filter((id) => !known.has(String(id)));

  const appids = [
    ...new Set([
      ...known,
      ...(await cachedSchemaAppids(cfg.lang)),
      ...scanned,
    ]),
  ];

  prefetchState = { running: true, at: Date.now(), result: null };
  try {
    const result = await prefetchSchemas({
      appids,
      lang: cfg.lang,
      apiKey: cfg._primaryKey,
      fallbackKey: cfg._fallbackKey,
      concurrency: 3,
      force,
      onProgress: (x) => log.info(`[PREFETCH] ${x.appid} ${x.status}${x.name ? " " + x.name : ""}`),
    });
    prefetchState = { running: false, at: Date.now(), result: { ...result, scanned } };
    libCache = { at: 0, data: null };
    return result;
  } catch (e) {
    prefetchState = { running: false, at: Date.now(), result: null };
    throw e;
  }
}

// 检测游戏目录是否已被打过补丁（轻量：只看当前目录的文件，不递归）
function detectPatchState(dir, entries) {
  const has = (name) => entries.some((e) => e.isFile() && e.name.toLowerCase() === name);
  const dllName = ["steam_api64.dll", "steam_api.dll"].find(has) || null;

  let goldbergDll = false;
  if (dllName) {
    try {
      const buf = fs.readFileSync(path.join(dir, dllName));
      const ascii = buf.toString("latin1");
      goldbergDll = /goldberg|gbe_fork|steam_settings|steam_settings_path/i.test(ascii);
    } catch { /* 读不到就当未知 */ }
  }

  return {
    dll: dllName,
    goldbergDll,                                        // DLL 本身像 Goldberg/gbe_fork 系
    achConfig: has(path.join("steam_settings", "achievements.json")), // 成就清单已生成
    backup: ["steam_api64.dll.aw2bak", "steam_api.dll.aw2bak"].some(has), // aw2 打过补丁（有备份）
  };
}

// ---------- 模拟器补丁（网页端选目录 → 生成成就配置 → 替换 DLL 并备份） ----------
async function emuApplyDir({ dir, withIcons = true, mode = "regular" } = {}) {
  if (!dir || typeof dir !== "string") throw new Error("请提供游戏目录");
  const gameDir = path.resolve(dir.trim());
  const st = await fsp.stat(gameDir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`目录不存在：${gameDir}`);

  const appid = await detectGameAppid(gameDir);
  if (!appid) {
    throw new Error("在所选目录里没找到 steam_appid.txt，无法确定 AppID。请选游戏根目录（通常能看到 steam_api64.dll 或游戏 exe）");
  }

  const cfg = await loadConfig();
  const preState = detectPatchState(gameDir, await fsp.readdir(gameDir, { withFileTypes: true }));

  const r = await applyEmu({
    appid,
    gameDir,
    mode,
    withIcons: !!withIcons,
    lang: cfg.lang,
    apiKey: cfg._primaryKey,
    fallbackKey: cfg._fallbackKey,
  });

  // 打完补丁顺手把该游戏的成就 schema 拉全（之后离线也能立刻弹通知）
  const pre = await prefetchSchemas({
    appids: [appid],
    lang: cfg.lang,
    apiKey: cfg._primaryKey,
    fallbackKey: cfg._fallbackKey,
    force: true,
  });

  libCache = { at: 0, data: null };

  return {
    appid,
    gameDir,
    exeDir: r.exeDir,
    mode: r.mode,
    detectedBefore: preState, // 打补丁前的状态（是否已有 goldberg DLL / 成就清单 / aw2 备份）
    replaced: r.applied.filter((x) => x.backup).length,
    written: r.applied.filter((x) => !x.backup).length,
    settingsDirs: r.genResults.map((g) => ({ dir: g.dir, total: g.total, icons: g.icons })),
    manifest: r.manifestFile,
    schema: pre.ok.length ? "downloaded" : pre.cached.length ? "cached" : "failed",
    schemaError: pre.failed[0]?.error || null,
  };
}

// ---------- 目录浏览（给网页选游戏目录用） ----------
async function listFsDir(rawPath) {
  if (!rawPath) {
    const dirs = [];
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const p = `${letter}:\\`;
      try { await fsp.access(p); dirs.push({ name: `${letter}:`, path: p }); } catch { /* 不存在 */ }
    }
    return { path: "", parent: null, dirs, appid: null, isGame: false };
  }

  const full = path.resolve(rawPath);
  const entries = await fsp.readdir(full, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("$") && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(full, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  // 轻量判断当前目录是不是游戏根（不做递归，避免浏览大目录变慢）
  let appid = null;
  for (const rel of ["steam_appid.txt", path.join("steam_settings", "steam_appid.txt")]) {
    try {
      const txt = (await fsp.readFile(path.join(full, rel), "utf8")).trim();
      if (/^\d+$/.test(txt)) { appid = txt; break; }
    } catch { /* next */ }
  }
  const patch = detectPatchState(full, entries);

  const parent = path.dirname(full);
  const cfg = await loadConfig();
  return {
    path: full,
    parent: full === parent ? "" : parent,
    dirs,
    appid,
    isGame: !!patch.dll || !!appid,
    patch,
    wallSet: resolveWallDir(cfg) !== null,
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
    sound: {
      rareThreshold: cfg.sound?.rareThreshold ?? 10,
      normal: cfg.sound?.normal ?? "",
      rare: cfg.sound?.rare ?? "",
    },
    hasKey: !!cfg._primaryKey,
    keyMasked: maskKey(cfg._primaryKey),
    hasFallbackKey: !!cfg._fallbackKey,
    fallbackKeyMasked: maskKey(cfg._fallbackKey),
    profileName: cfg.profile?.name || "",
    defaultProfileName: process.env.USERNAME || "Player",
    soundsDir: soundsDir(),
    dataRoot: dataRoot(),
    userDirs,
    uiPort: cfg.ui?.port || 0,
    wall: { dir: cfg.wall?.dir || "", enabled: cfg.wall?.enabled !== false, effective: resolveWallDir(cfg) },
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
  if (typeof body.profileName === "string") cfg.profile = { name: body.profileName.trim() };
  if (body.sound && typeof body.sound === "object") {
    cfg.sound = {
      rareThreshold: Number.isFinite(+body.sound.rareThreshold) && +body.sound.rareThreshold >= 0 && +body.sound.rareThreshold <= 100
        ? +body.sound.rareThreshold : (cfg.sound?.rareThreshold ?? 10),
      normal: typeof body.sound.normal === "string" ? body.sound.normal.trim() : (cfg.sound?.normal ?? null),
      rare: typeof body.sound.rare === "string" ? body.sound.rare.trim() : (cfg.sound?.rare ?? null),
    };
  }
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

  // 面板端口（0 = 恢复内置默认 5179）
  if (body.ui && typeof body.ui === "object") {
    const port = Math.floor(Number(body.ui.port) || 0);
    if (port !== 0 && (port < 1024 || port > 65535)) {
      throw new Error("面板端口需要在 1024-65535 之间（或填 0 使用默认 5179）");
    }
    cfg.ui = { port };
  }

  // 可配置路径
  if (body.wall && typeof body.wall === "object") {
    if (typeof body.wall.dir === "string") cfg.wall = { ...cfg.wall, dir: body.wall.dir.trim() };
    if (typeof body.wall.enabled === "boolean") cfg.wall = { ...cfg.wall, enabled: body.wall.enabled };
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

    if (p === "/api/schema/prefetch" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      // 支持只下指定 appid（详情页单个游戏补齐）
      const ids = Array.isArray(body.appids) ? body.appids.filter((x) => /^\d+$/.test(String(x))) : null;
      if (ids?.length) {
        const cfg = await loadConfig();
        const r = await prefetchSchemas({
          appids: ids,
          lang: cfg.lang,
          apiKey: cfg._primaryKey,
          fallbackKey: cfg._fallbackKey,
          force: body.force !== false,
        });
        libCache = { at: 0, data: null };
        return sendJSON(res, 200, r);
      }
      return sendJSON(res, 200, await prefetchAllAchievements(!!body.force));
    }

    if (p === "/api/fs/list") {
      return sendJSON(res, 200, await listFsDir(url.searchParams.get("path") || ""));
    }

    if (p === "/api/emu/apply" && req.method === "POST") {
      const body = await readBody(req);
      return sendJSON(res, 200, await emuApplyDir(body));
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

function listen(port) {
  // 端口固定不自动跳号：跳号会让用户不知道面板在哪。被占用时明确报错。
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(`[UI] 端口 ${port} 被占用。请关掉占用它的程序，或用环境变量 AW2_UI_PORT 指定其他端口后重试。`);
      console.error(`\n端口 ${port} 已被占用，面板无法启动。`);
      console.error(`  - 关闭占用该端口的程序后重试，或`);
      console.error(`  - 临时换端口：set AW2_UI_PORT=5180 && node src\\cli.js ui\n`);
    } else {
      log.error(`[UI] ${err.message}`);
    }
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
