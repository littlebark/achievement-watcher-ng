// Steam schema 获取 + 本地缓存（兼容原版缓存格式与目录）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fsp, exists, readJSON, writeJSON, isYoungerThan } from "../shared/fsx.js";
import { log } from "../shared/log.js";
import { httpFetch as fetch } from "../shared/http.js";

const SCHEMA_TTL = 6 * 30 * 24 * 3600 * 1000; // 6 个月，与原版一致

// 项目根（src 的上一级），用于便携模式
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 数据目录优先级：
//   1) 环境变量 AW2_DATA_ROOT（测试/高级用法）
//   2) 默认 <项目>/data —— 便携优先：配置、缓存、成就墙全部在项目文件夹内，
//      不在系统里留任何东西，不想要了直接删项目文件夹即彻底清空。
//      （旧版本曾默认 %APPDATA%\Achievement Watcher，现仅当用户手动设 AW2_DATA_ROOT 指过去时使用）
export function dataRoot() {
  if (process.env.AW2_DATA_ROOT) return process.env.AW2_DATA_ROOT;
  return path.join(projectRoot, "data");
}

// 成就墙默认目录：未在配置中显式设置时，落到数据目录内（同样随项目走）
export function defaultWallDir() {
  return path.join(dataRoot(), "AchievementWall");
}

// languages: 与原版 steam.json 的 api 字段一致（schinese 等），此处校验交给 config
export async function getGameData({ appID, lang, apiKey, fallbackKey, force = false }) {
  const cacheDir = path.join(dataRoot(), "steam_cache", "schema", lang);
  const filePath = path.join(cacheDir, `${appID}.db`);

  if (!force && (await isYoungerThan(filePath, SCHEMA_TTL))) {
    try { return JSON.parse(await fsp.readFile(filePath, "utf8")); }
    catch (e) { log.warn(`schema cache corrupt for ${appID}: ${e.message}`); }
  }

  const key = apiKey || fallbackKey;

  try {
    if (!key) throw new Error(`NO_STEAM_API_KEY: 需要在配置中设置 steamApiKey（https://steamcommunity.com/dev/apikey 免费申请）`);
    const result = await fetchSchema(appID, lang, key);
    writeJSON(filePath, result).catch((e) => log.warn(`write schema cache failed: ${e.message}`));
    return result;
  } catch (e) {
    // 网络失败时回退到过期缓存（比直接报错好——原版没有这个容错）
    if (await exists(filePath)) {
      log.warn(`在线获取 schema 失败（${e.message}），使用本地过期缓存`);
      return JSON.parse(await fsp.readFile(filePath, "utf8"));
    }
    if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|UND_ERR/i.test(e.message))
      throw new Error(`网络请求失败（${e.message}）：无法拉取 app ${appID} 的成就 schema，且本地没有缓存。请检查网络；如开了代理软件，请确认系统代理已开启（桌面版自动跟随系统代理）`);
    throw e;
  }
}

// 批量预取成就 schema：watchdog 启动 / 网页点"下载成就"时调用。
// 目的：不要在首次解锁时才联网——网络差会让通知延迟甚至丢通知。
export async function prefetchSchemas({
  appids = [],
  lang,
  apiKey,
  fallbackKey,
  concurrency = 3,
  force = false,
  onProgress,
} = {}) {
  const cacheDir = path.join(dataRoot(), "steam_cache", "schema", lang);
  const queue = [...new Set(appids.map(String))];
  const result = { total: queue.length, ok: [], cached: [], failed: [] };
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const appid = queue[cursor++];
      const file = path.join(cacheDir, `${appid}.db`);
      try {
        if (!force && (await isYoungerThan(file, SCHEMA_TTL))) {
          result.cached.push(appid);
          onProgress?.({ appid, status: "cached" });
          continue;
        }
        const data = await getGameData({ appID: appid, lang, apiKey, fallbackKey, force });
        result.ok.push(appid);
        onProgress?.({ appid, status: "ok", name: data.name });
        // 顺带预热全球解锁率（稀有度判定用）；失败不影响主流程
        if (apiKey) {
          try { await getGlobalPercentages({ appID: appid, apiKey }); } catch { /* ignore */ }
        }
      } catch (e) {
        result.failed.push({ appid, error: e.message });
        onProgress?.({ appid, status: "failed", error: e.message });
      }
    }
  }

  const lanes = Math.max(1, Math.min(concurrency, queue.length || 1));
  await Promise.all(Array.from({ length: lanes }, worker));
  return result;
}

const RETRY_DELAYS = [400, 1200, 2500]; // 网络抖动重试（Steam API 偶发 TLS/连接重置）

// 全球解锁率（稀有度判定）：ISteamUserStats/GetGlobalAchievementPercentagesForApp
// 返回 { [apiname]: 全球解锁百分比 }；缓存 30 天（该数据变化极慢）；失败返回 null，绝不阻塞通知
const GLOBAL_TTL = 30 * 24 * 3600 * 1000;

export async function getGlobalPercentages({ appID, apiKey }) {
  const filePath = path.join(dataRoot(), "steam_cache", "global", `${appID}.db`);
  if (await isYoungerThan(filePath, GLOBAL_TTL)) {
    try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { /* 重新拉取 */ }
  }
  try {
    // https 不通时降级 http（全球统计为非敏感数据；部分网络环境对 api.steampowered.com 的 TLS 很不稳）
    const urls = [
      `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?key=${apiKey}&gameid=${appID}&format=json`,
      `http://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?key=${apiKey}&gameid=${appID}&format=json`,
    ];
    let data = null, lastErr;
    outer: for (const url of urls) {
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`STEAM_API_${res.status}`);
          data = await res.json();
          break outer;
        } catch (e) {
          lastErr = e;
          if (attempt === RETRY_DELAYS.length) break;
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        }
      }
    }
    if (!data) throw lastErr || new Error("no response");
    const list = data?.achievementpercentages?.achievements || [];
    if (!list.length) return null;
    const map = {};
    for (const a of list) map[a.name] = +a.percent;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(map));
    return map;
  } catch (e) {
    log.warn(`全球解锁率获取失败 ${appID}: ${e.message}`);
    if (await exists(filePath)) {
      try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { /* ignore */ }
    }
    return null;
  }
}

async function fetchSchema(appID, lang, key) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v0002/?key=${key}&appid=${appID}&l=${lang}&format=json`;

  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fetchSchemaOnce(appID, url, lang);
    } catch (e) {
      lastError = e;
      // 只有网络类/服务端错误才重试；key 无效、无成就等确定性错误直接抛
      const retriable = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket|network|STEAM_API_5\d\d|STEAM_API_429/i.test(e.message);
      if (!retriable || attempt === RETRY_DELAYS.length) break;
      log.warn(`schema 请求失败（${e.message}），${RETRY_DELAYS[attempt]}ms 后重试 ${attempt + 1}/${RETRY_DELAYS.length}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  throw lastError;
}

async function fetchSchemaOnce(appID, url, lang) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`STEAM_API_${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const schema = data.game?.availableGameStats;
  if (!(schema?.achievements?.length)) throw new Error(`SCHEMA_EMPTY: app ${appID} 没有成就数据（key 无效或游戏无成就）`);

  // 游戏名取值优先级（根治内部名乱码）：
  //   1) 官方商店名 appdetails（最规范、随语言本地化，无需 API key）
  //   2) GetAppList 规范名（无需 key，已本地缓存）
  //   3) schema 的 gameName（内部名，部分游戏会返回占位/乱码，如 "ReD"，仅作最后兜底）
  // 前两者任一失败均返回 null，绝不影响主流程。
  const storeName = await getStoreName(appID, lang);
  const appListName = await safeAppListName(appID);
  const name = storeName || appListName || data.game.gameName || appListName || `app ${appID}`;

  return {
    name,
    appid: String(appID),
    binary: null,
    img: {
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${appID}/header.jpg`,
      background: `https://cdn.akamai.steamstatic.com/steam/apps/${appID}/page_bg_generated_v6b.jpg`,
      portrait: `https://cdn.akamai.steamstatic.com/steam/apps/${appID}/library_600x900.jpg`,
      icon: null,
    },
    achievement: {
      total: schema.achievements.length,
      list: schema.achievements,
    },
  };
}

// 游戏名兜底：官方 GetAppList（无需 key）+ 本地缓存
export async function findInAppList(appID) {
  const file = path.join(dataRoot(), "steam_cache", "schema", "appList.json");
  let list = null;
  try { list = JSON.parse(await fsp.readFile(file, "utf8")); } catch { /* refetch */ }

  if (!list) {
    const res = await fetch("https://api.steampowered.com/ISteamApps/GetAppList/v0002/?format=json");
    const data = await res.json();
    list = data.applist.apps;
    list.sort((a, b) => b.appid - a.appid); // 新游戏优先
    await writeJSON(file, list);
  }

  const app = list.find((a) => a.appid === +appID);
  if (!app) throw new Error(`ERR_NAME_NOT_FOUND: ${appID}`);
  return app.name;
}

// 官方商店名（appdetails，无需 API key）：最规范的游戏标题，随 l= 本地化。
// 任何失败都返回 null，绝不影响主流程（避免拖累成就 schema 拉取）。
async function getStoreName(appID, lang) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appID}&cc=us&l=${lang || "english"}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data?.[String(appID)];
    if (entry?.success && entry.data?.name) return String(entry.data.name).trim();
  } catch { /* ignore */ }
  return null;
}

// GetAppList 规范名兜底（无需 key，已本地缓存）：失败也返回 null，不抛出。
async function safeAppListName(appID) {
  try { return await findInAppList(appID); } catch { return null; }
}

// 下载图标到本地缓存（Toast 需要本地路径）
export async function fetchIcon(url, appID) {
  if (!/^https?:/.test(url)) return url;
  const cacheDir = path.join(dataRoot(), "steam_cache", "icon", String(appID));
  const filename = path.basename(new URL(url).pathname);
  const filePath = path.join(cacheDir, filename);
  if (await exists(filePath)) return filePath;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
    return filePath;
  } catch {
    return url;
  }
}
