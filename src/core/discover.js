// 成就来源发现器：内置模拟器目录表 + 用户自定义目录 → 监视/扫描条目
import path from "node:path";
import { walkDirs, exists, readJSON, fsp } from "../shared/fsx.js";
import { getMyDocuments } from "../shared/win.js";
import { scanPatchedGames } from "./emugen.js";
import table from "./emu-paths.json" with { type: "json" };

// GSE 存档目录里承载 <appid> 子文件夹的判定（路径末尾为数字段）
const APPID_DIR_RE = /(?:^|[\\/])[0-9]+$/;
// GSE 系进度文件名（与 emu-paths.json 的 gbe_fork 项一致）
const GSE_FILES = ["achievements.json", "achievements.ini"];

// 解析 gbe_fork/GSE 的 steam_settings/configs.user.ini，取出生效(未注释)的 local_save_path。
// gbe_fork 把该键放在 [user::saves] 段（也可能在 [user] 等以 [user 开头的段），故按前缀匹配。
// 没有则返回 null（经典 Goldberg / 未重定向的 GSE 走到这里）。
export function parseLocalSavePath(text) {
  let inUser = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("[") && t.endsWith("]")) {
      inUser = t.toLowerCase().startsWith("[user");
      continue;
    }
    if (!inUser) continue;
    if (t.startsWith("#") || t.startsWith(";")) continue; // 注释行跳过
    const m = t.match(/^local_save_path\s*=\s*(.+)$/i);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// gbe_fork 文档：local_save_path 相对路径以 steam_api.dll 所在目录为基准（已用星之海洋实测印证）。
export function resolveGseSaveBase(dllDir, localSavePath) {
  if (path.isAbsolute(localSavePath)) return path.resolve(localSavePath);
  return path.resolve(dllDir, localSavePath);
}

// 展开 %ENV% 与 {mydocs} 占位
async function expandDir(dirTemplate, mydocs) {
  return dirTemplate
    .replace(/\{mydocs\}/g, mydocs)
    .replace(/%([^%]+)%/g, (_, env) => process.env[env] ?? "");
}

// 从路径中提取最后的数字段作为 appid（与原版逻辑一致）
export function appidFromPath(dirPath) {
  const m = dirPath.replace(/(\\stats$)|(\\SteamEmu$)|(\\SteamEmu\\UserStats$)/g, "").match(/([0-9]+)$/);
  return m ? m[0] : null;
}

// 路径里没有数字时，从上游配置推断 appid：
// SmartSteamEmu 的 SteamConfig.ini / SmartSteamEmu.ini，或 steam_appid.txt
async function appidFromConfig(dir) {
  let cur = dir;
  for (let i = 0; i < 5; i++) {
    for (const f of ["SteamConfig.ini", "SmartSteamEmu.ini", "steam_appid.txt", "steam_settings/steam_appid.txt", "flt.ini"]) {
      try {
        const txt = await (await import("node:fs/promises")).readFile(path.join(cur, f), "utf8");
        const m = txt.match(/(?:^\s*(?:AppID|AppId|appid)\s*=\s*|^\s*)(\d{3,8})\s*$/im);
        if (m) return m[1];
      } catch { /* next */ }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// 该目录下存在哪些成就文件（按白名单顺序优先级）
export async function findAchievementFiles(dir, files) {
  const found = [];
  const seen = new Set(); // NTFS 大小写不敏感，同一文件可能被两种拼写同时命中
  for (const f of files) {
    if (seen.has(f.toLowerCase())) continue;
    if (await exists(path.join(dir, f))) { found.push(f); seen.add(f.toLowerCase()); }
  }
  return found;
}

// 枚举所有可监视的成就目录
// 返回: [{ source, dir, files:[filename...], appid?, disableProcessCheck, disableTimestampCheck }]
export async function getWatchFolders({ userDirs = [], includeBuiltin = true, gameSearchDirs = [] } = {}) {
  const mydocs = await getMyDocuments();
  const folders = [];

  if (includeBuiltin) {
    for (const entry of table.builtin) {
      for (const dirTpl of entry.dir) {
        const root = await expandDir(dirTpl, mydocs);
        if (!(await exists(root))) continue;

        const re = new RegExp(`(?:^|\\\\)${entry.watch.pathFilter}$`);
        const dirs = await walkDirs(root, {
          depth: 4,
          test: (full) => {
            const rel = full.slice(root.length);
            return re.test(rel);
          },
        });

        for (const dir of dirs) {
          const files = await findAchievementFiles(dir, entry.watch.files);
          if (files.length === 0) continue;
          folders.push({
            source: entry.source,
            dir,
            files,
            appid: appidFromPath(dir),
            disableProcessCheck: !!entry.watch.disableProcessCheck,
            disableTimestampCheck: !!entry.watch.disableTimestampCheck,
          });
        }
      }
    }
  }

  // GSE 存档重定向：破解组可能在 steam_settings/configs.user.ini 用 local_save_path
  // 把成就/存档写到 DLL 目录下的自定义路径（而非默认 %APPDATA%/GSE Saves）。
  // 不解析的话，这类游戏的成就文件 AW2 永远看不到 —— 表现为「能正常解锁却零通知」。
  if (includeBuiltin && gameSearchDirs.length) {
    const defaultGseRoot = path.resolve(await expandDir("%APPDATA%/GSE Saves", mydocs));
    try {
      const patched = await scanPatchedGames(gameSearchDirs);
      for (const { dir: dllDir } of patched) {
        let base = null;
        try {
          const iniPath = path.join(dllDir, "steam_settings", "configs.user.ini");
          if (await exists(iniPath)) {
            const lp = parseLocalSavePath(await fsp.readFile(iniPath, "utf8"));
            if (lp) base = resolveGseSaveBase(dllDir, lp);
          }
        } catch { /* 读配置失败则跳过该游戏 */ }
        if (!base) continue;
        // 重定向到默认 GSE 目录时由上方 builtin 已覆盖，跳过避免重复监视
        if (path.resolve(base) === defaultGseRoot) continue;
        const dirs = await walkDirs(base, {
          depth: 4,
          test: (full) => APPID_DIR_RE.test(full.slice(base.length)),
        });
        for (const dir of dirs) {
          const files = await findAchievementFiles(dir, GSE_FILES);
          if (files.length === 0) continue;
          folders.push({
            source: "GSE 重定向(local_save_path)",
            dir,
            files,
            appid: appidFromPath(dir),
            disableProcessCheck: false,
            disableTimestampCheck: false,
          });
        }
      }
    } catch (e) {
      console.warn("[DISCOVER] 重定向扫描失败：" + e.message);
    }
  }

  // 用户自定义目录（兼容原版 userdir.db）：通用递归扫描
  const fileSet = new Set(table.achievementFiles.map((f) => f.toLowerCase()));
  for (const userDir of userDirs) {
    if (!userDir.notify && userDir.notify !== undefined) continue;
    if (!(await exists(userDir.path))) continue;

    const dirs = await walkDirs(userDir.path, {
      depth: 5,
      test: async () => true,
    });
    dirs.push(userDir.path);

    for (const dir of dirs) {
      // steam_settings 是模拟器配置目录（成就定义），不是玩家存档，跳过避免同 appid 重复
      if (path.basename(dir).toLowerCase() === "steam_settings") continue;
      const names = await walkFiles(dir);
      const files = names.filter((f) => fileSet.has(f.toLowerCase()));
      if (files.length === 0) continue;
      // 先按路径末尾数字取 appid；取不到则读上游配置（SSE 的 SteamConfig.ini / steam_appid.txt）
      const appid = appidFromPath(dir) || (await appidFromConfig(dir));
      if (!appid) continue;
      folders.push({
        source: userDir.source || "User custom dir",
        dir,
        files,
        appid,
        disableProcessCheck: false,
        disableTimestampCheck: false,
      });
    }
  }

  // 按 dir 去重
  const seen = new Set();
  return folders.filter((f) => {
    const key = f.dir.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function walkFiles(dir) {
  const out = [];
  try {
    for (const e of await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true })) {
      if (e.isFile()) out.push(e.name);
    }
  } catch { /* ignore */ }
  return out;
}

// 读取原版 userdir.db（自定义目录列表）
export async function loadUserDirs(cfgDir) {
  try {
    const list = await readJSON(path.join(cfgDir, "userdir.db"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
