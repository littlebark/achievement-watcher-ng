// Steam schema 获取 + 本地缓存（兼容原版缓存格式与目录）
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fsp, exists, readJSON, writeJSON, isYoungerThan } from "../shared/fsx.js";
import { log } from "../shared/log.js";

const SCHEMA_TTL = 6 * 30 * 24 * 3600 * 1000; // 6 个月，与原版一致

// 项目根（src 的上一级），用于便携模式
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 数据目录优先级：
//   1) 环境变量 AW2_DATA_ROOT（测试/高级用法）
//   2) 项目根存在 portable.flag → 数据随项目走（<项目>/data/），整个文件夹拷贝即迁移
//   3) 默认 %APPDATA%\Achievement Watcher
export function dataRoot() {
  if (process.env.AW2_DATA_ROOT) return process.env.AW2_DATA_ROOT;
  try {
    if (fs.existsSync(path.join(projectRoot, "portable.flag"))) {
      return path.join(projectRoot, "data");
    }
  } catch { /* fallthrough */ }
  return path.join(process.env.APPDATA, "Achievement Watcher");
}

// languages: 与原版 steam.json 的 api 字段一致（schinese 等），此处校验交给 config
export async function getGameData({ appID, lang, apiKey, fallbackKey }) {
  const cacheDir = path.join(dataRoot(), "steam_cache", "schema", lang);
  const filePath = path.join(cacheDir, `${appID}.db`);

  if (await isYoungerThan(filePath, SCHEMA_TTL)) {
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
      throw new Error(`网络请求失败（${e.message}）：无法拉取 app ${appID} 的成就 schema，且本地没有缓存。请联网后重试`);
    throw e;
  }
}

const RETRY_DELAYS = [400, 1200, 2500]; // 网络抖动重试（Steam API 偶发 TLS/连接重置）

async function fetchSchema(appID, lang, key) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v0002/?key=${key}&appid=${appID}&l=${lang}&format=json`;

  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fetchSchemaOnce(appID, url);
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

async function fetchSchemaOnce(appID, url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`STEAM_API_${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const schema = data.game?.availableGameStats;
  if (!(schema?.achievements?.length)) throw new Error(`SCHEMA_EMPTY: app ${appID} 没有成就数据（key 无效或游戏无成就）`);
  return {
    name: data.game.gameName || (await findInAppList(appID)),
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
