// 成就来源发现器：内置模拟器目录表 + 用户自定义目录 → 监视/扫描条目
import path from "node:path";
import { walkDirs, exists, readJSON } from "../shared/fsx.js";
import { getMyDocuments } from "../shared/win.js";
import table from "./emu-paths.json" with { type: "json" };

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
export async function getWatchFolders({ userDirs = [], includeBuiltin = true } = {}) {
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
