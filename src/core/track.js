// 成就状态缓存（防重复通知）—— 兼容原版 steam_cache/data/<appid>.db 格式
import path from "node:path";
import { fsp, exists } from "../shared/fsx.js";
import { dataRoot } from "./schema.js";

const cacheDir = () => path.join(dataRoot(), "steam_cache", "data");

export async function load(appID) {
  try {
    return JSON.parse(await fsp.readFile(path.join(cacheDir(), `${appID}.db`), "utf8"));
  } catch {
    return [];
  }
}

export async function save(appID, achievements) {
  const { writeJSON } = await import("../shared/fsx.js");
  await writeJSON(path.join(cacheDir(), `${appID}.db`), achievements, null);
}

export async function existsCache(appID) {
  return exists(path.join(cacheDir(), `${appID}.db`));
}
