// 配置加载：兼容读取原版 options.ini，叠加 aw2.json 覆盖项
// Steam Key 沿用原版 AES-256-CBC 混淆存储（仅防误读，非安全边界）
import path from "node:path";
import crypto from "node:crypto";
import * as ini from "../shared/ini.js";
import { fsp, exists, readJSON, writeJSON } from "../shared/fsx.js";
import { dataRoot } from "./schema.js";

const AES_KEY = "xfW!+Bn3E@Luu#^vj3$7wZRqRgACQeCu"; // 与原版一致，便于迁移

export function encrypt(str) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(AES_KEY), iv);
  return iv.toString("hex") + ":" + Buffer.concat([cipher.update(String(str)), cipher.final()]).toString("hex");
}

export function decrypt(str) {
  const [ivHex, ...rest] = String(str).split(":");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(AES_KEY), Buffer.from(ivHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(rest.join(":"), "hex")), decipher.final()]).toString();
}

export const DEFAULTS = {
  lang: "schinese",
  steamApiKey: "",        // 加密串
  steamApiFallbackKey: "",// 备用 key（加密串）
  timeThreshold: 10,      // 解锁时间超过 N 秒视为旧成就，不通知
  tick: 600,              // 防刷屏间隔 ms
  checkProcessRunning: false, // 依赖 gameIndex（原服务器已死），默认关闭
  iconPrefetch: true,
  notify: true,
  websocket: { enabled: true, port: 8082, auth: null },
  action: { target: "", cwd: "", hide: true }, // 解锁时执行的外部命令，注入 AW_* 环境变量
  toast: { appId: null },  // 自定义 AUMID；null=自动选 PowerShell AUMID
  wall: { dir: "" },       // 成就墙导出目录（空=关闭；watchdog 实时同步 + wall 命令全量导出）
  ui: { port: 0 },         // 面板端口；0 = 内置默认 5179
  paths: {
    // 全部可空 = 使用内置默认（见 PATH_DEFAULTS）；数组按顺序取优先级
    gameSearchDirs: [],    // emu-gen / emu-apply 自动找游戏的搜索根
    emuRoots: [],          // Goldberg 模拟器源安装根（emu-source 装这里，emu-apply 从这取 DLL）
    emuExtraSources: [],   // 额外 emu 源搜索目录（只读借用，如旧工具自带的 goldberg 目录）
  },
};

// paths.* 为空时的内置默认（通用值，刻意不含任何个人路径；
// 个人路径写在数据目录 aw2.json 的 paths.* 里，参考项目根 config.example.json）
export const PATH_DEFAULTS = {
  gameSearchDirs: [],  // 例：["D:\\Games", "E:\\SteamLibrary\\steamapps\\common"]
  emuRoots: [],        // 例：["D:\\GameTools\\steam-emu"]；无论配置与否都会兜底 <数据目录>/tools/steam-emu
  emuExtraSources: [], // 例：["D:\\Tools\\GoldbergGUI-0.3.0\\goldberg"]
};

// 合并用户配置与内置默认，得到最终生效路径
export function resolvedPaths(cfg) {
  const p = cfg?.paths || {};
  const list = (v, dft) => {
    const a = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
    return a.length ? a : [...dft];
  };
  return {
    gameSearchDirs: list(p.gameSearchDirs, PATH_DEFAULTS.gameSearchDirs),
    emuRoots: [...list(p.emuRoots, PATH_DEFAULTS.emuRoots), path.join(dataRoot(), "tools", "steam-emu")],
    emuExtraSources: list(p.emuExtraSources, PATH_DEFAULTS.emuExtraSources),
  };
}

export async function loadConfig() {
  const cfgFile = path.join(dataRoot(), "aw2.json");
  let cfg = { ...DEFAULTS };

  // 1) 从原版 options.ini 迁移基础项（lang 等）
  const legacyIni = path.join(dataRoot(), "cfg", "options.ini");
  if (await exists(legacyIni)) {
    try {
      const legacy = ini.parse(await fsp.readFile(legacyIni, "utf8"));
      if (legacy.achievement?.lang) cfg.lang = legacy.achievement.lang;
      if (legacy.steam?.apiKey?.includes(":")) {
        try { cfg._legacyEncryptedKey = legacy.steam.apiKey; } catch { /* ignore */ }
      }
      if (legacy.notification_advanced?.timeTreshold) cfg.timeThreshold = +legacy.notification_advanced.timeTreshold;
      if (legacy.notification_advanced?.tick) cfg.tick = +legacy.notification_advanced.tick;
      if (legacy.notification_advanced?.iconPrefetch !== undefined) cfg.iconPrefetch = legacy.notification_advanced.iconPrefetch !== "false";
    } catch { /* ignore */ }
  }

  // 2) aw2.json 覆盖
  if (await exists(cfgFile)) {
    try {
      const saved = await readJSON(cfgFile);
      cfg = { ...cfg, ...saved };
    } catch (e) { console.warn(`aw2.json 损坏，使用默认配置: ${e.message}`); }
  }

  // 3) 解密 key：优先 aw2.json 里的，其次原版 options.ini 里的
  let primaryKey = null, fallbackKey = null;
  try { if (cfg.steamApiKey) primaryKey = decrypt(cfg.steamApiKey); } catch { /* ignore */ }
  try { if (cfg.steamApiFallbackKey) fallbackKey = decrypt(cfg.steamApiFallbackKey); } catch { /* ignore */ }
  if (!primaryKey && cfg._legacyEncryptedKey) {
    try {
      primaryKey = decrypt(cfg._legacyEncryptedKey);
      await saveConfig({ ...cfg, steamApiKey: encrypt(primaryKey) }); // 自动迁移写入
    } catch { /* ignore */ }
  }
  cfg._primaryKey = primaryKey || null;
  cfg._fallbackKey = fallbackKey || null;
  delete cfg._legacyEncryptedKey;

  return cfg;
}

export async function saveConfig(cfg) {
  const cfgFile = path.join(dataRoot(), "aw2.json");
  const { _primaryKey, _fallbackKey, ...persist } = cfg;
  await writeJSON(cfgFile, persist);
}
