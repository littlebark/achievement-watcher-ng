// watchdog 主循环：监视成就文件 → 解析 → 比对 → 通知
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { exists, mtimeMs, sanitizeFileName } from "../shared/fsx.js";
import { log, setLogFile } from "../shared/log.js";
import { acquireSingleInstance } from "../shared/lock.js";
import { loadConfig } from "../core/config.js";
import { getWatchFolders, loadUserDirs } from "../core/discover.js";
import { parseAchievementFile } from "../core/normalize/file-parsers.js";
import { matchAchievements } from "../core/match.js";
import * as track from "../core/track.js";
import { getGameData, fetchIcon, prefetchSchemas, dataRoot } from "../core/schema.js";
import { sendToast } from "./notify/toast.js";
import { startWebSocket, broadcast } from "./notify/websocket.js";

const schemaCache = new Map(); // appid -> game schema
let lastTick = 0;

async function loadGame(appID, cfg) {
  if (schemaCache.has(appID)) return schemaCache.get(appID);
  const game = await getGameData({
    appID,
    lang: cfg.lang,
    apiKey: cfg._primaryKey,
    fallbackKey: cfg._fallbackKey,
  });
  schemaCache.set(appID, game);
  return game;
}

async function notify(achievement, game, options, delay = 0) {
  const isLast = options.isLast === true; // 全成就达成：固定按稀有处理
  const payload = {
    appID: Number(game.appid) || game.appid,
    game: game.name,
    achievement: achievement.schemaAchievement.name,
    displayName: achievement.schemaAchievement.displayName,
    description: achievement.schemaAchievement.description || "",
    icon: achievement.schemaAchievement.icon,
    time: achievement.local.UnlockTime || Math.floor(Date.now() / 1000),
  };

  // WebSocket 广播（不依赖图标本地化）
  if (options.cfg.websocket?.enabled) broadcast(payload);

  // 稀有度判定（Xbox 钻石成就式）：全球解锁率 ≤ 阈值视为稀有。
  // 数据来自 Steam 全球统计接口（缓存 30 天，启动时已预取），取不到就按普通处理，绝不阻塞通知。
  let rare = false, rarePercent = null;
  const threshold = options.cfg.sound?.rareThreshold;
  if (typeof threshold === "number" && threshold >= 0) {
    try {
      const { getGlobalPercentages } = await import("../core/schema.js");
      const gp = await getGlobalPercentages({ appID: game.appid, apiKey: options.cfg._primaryKey });
      const apiname = achievement.schemaAchievement.name;
      if (gp && apiname in gp) {
        rarePercent = gp[apiname];
        rare = rarePercent <= threshold;
      }
    } catch { /* 不阻塞 */ }
  }
  payload.rare = rare || isLast;
  if (rare) payload.rarePercent = rarePercent;

  // Toast
  if (options.cfg.notify) {
    try {
      let icon = payload.icon;
      if (options.cfg.iconPrefetch) icon = await fetchIcon(payload.icon, game.appid);
      await sendToast({
        title: payload.displayName,
        message: `${payload.game} — ${payload.description || "Achievement unlocked!"}`,
        icon,
        appId: options.cfg.toast?.appId,
        sound: rare || isLast ? options.cfg.sound?.rare : options.cfg.sound?.normal,
        attribution: isLast
          ? `全成就达成！${rare && rarePercent != null ? ` · 稀有成就 · 全球仅 ${rarePercent.toFixed(1)}%` : ""}`
          : rare && rarePercent != null
            ? `稀有成就 · 全球仅 ${rarePercent.toFixed(1)}% 玩家解锁`
            : null,
      });
      log.info(`[NOTIFY] ${payload.game} :: ${payload.displayName}${rare ? ` [稀有 ${rarePercent?.toFixed(1)}%]` : ""}`);
    } catch (e) {
      log.error(`[NOTIFY] ${e.message}`);
    }
  }

  // 外部命令钩子
  const action = options.cfg.action;
  if (action?.target && (await exists(action.target))) {
    try {
      const child = spawn(action.target, {
        cwd: action.cwd || path.parse(action.target).dir,
        stdio: "ignore",
        detached: true,
        windowsHide: action.hide ?? true,
        env: {
          ...process.env,
          AW_APPID: String(payload.appID),
          AW_GAME: String(payload.game),
          AW_ACHIEVEMENT: String(payload.achievement),
          AW_DISPLAYNAME: String(payload.displayName),
          AW_DESCRIPTION: String(payload.description),
          AW_ICON: String(payload.icon),
          AW_TIME: String(payload.time),
        },
      });
      child.unref();
    } catch (e) {
      log.error(`[ACTION] ${e.message}`);
    }
  }
}

async function handleFileChange(folder, filePath, cfg) {
  // 防刷屏
  const now = Date.now();
  if (now - lastTick < cfg.tick) return;
  lastTick = now;

  const appID = folder.appid;
  if (!appID) return log.warn(`[WATCH] 无法从路径推断 appid: ${filePath}`);

  const entries = await parseAchievementFile(filePath).catch((e) => {
    log.warn(`[PARSE] ${filePath}: ${e.message}`);
    return null;
  });
  if (!entries || entries.length === 0) return;

  const game = await loadGame(appID, cfg);
  const pairs = matchAchievements(game.achievement.list, entries);
  const previous = await track.load(appID);

  // 全成就判定：本地文件覆盖了全部 schema 成就，且本次读取后全部已解锁
  const total = game.achievement.list.length;
  const allDone = total > 0 && pairs.length === total && pairs.every((p) => p.local.Achieved);

  let j = 0;
  const merged = [];
  for (const pair of pairs) {
    const name = pair.schemaAchievement.name;
    const prev = previous.find((a) => (a.name || "").toUpperCase() === name.toUpperCase()) || {
      Achieved: false, CurProgress: 0, MaxProgress: 0, UnlockTime: 0,
    };
    const cur = pair.local;

    if (!prev.Achieved && cur.Achieved) {
      // 新解锁：时间阈值检查（防止打开旧存档时全量重刷通知）
      const unlockTime = cur.UnlockTime || Math.floor(Date.now() / 1000);
      const elapsed = Date.now() / 1000 - unlockTime;
      if (folder.disableTimestampCheck || (elapsed >= 0 && elapsed <= cfg.timeThreshold)) {
        log.info(`[UNLOCK] ${game.name} :: ${pair.schemaAchievement.displayName}${allDone ? " [全成就]" : ""}`);
        await notify(pair, game, { cfg, isLast: allDone }, j++);
      } else {
        log.info(`[SKIP-OLD] ${pair.schemaAchievement.displayName} (解锁于 ${Math.floor(elapsed)}s 前)`);
      }
    } else if (prev.Achieved && cur.Achieved && prev.UnlockTime > 0 && prev.UnlockTime !== cur.UnlockTime) {
      cur.UnlockTime = prev.UnlockTime; // 保持与缓存一致
    } else if (!cur.Achieved && cur.MaxProgress > 0 && +prev.CurProgress < +cur.CurProgress) {
      log.info(`[PROGRESS] ${pair.schemaAchievement.displayName} ${cur.CurProgress}/${cur.MaxProgress}`);
      if (cfg.websocket?.enabled) {
        broadcast({
          appID: Number(game.appid) || game.appid,
          game: game.name,
          achievement: name,
          displayName: pair.schemaAchievement.displayName,
          description: pair.schemaAchievement.description || "",
          icon: pair.schemaAchievement.icongray || pair.schemaAchievement.icon,
          time: 0,
          progress: { current: cur.CurProgress, max: cur.MaxProgress },
        });
      }
    }
    merged.push(cur);
  }

  await track.save(appID, merged);

  // 成就墙实时同步（默认开启，导出到 <数据目录>/AchievementWall；wall.enabled=false 关闭）
  {
    const { resolveWallDir } = await import("../core/config.js");
    if (resolveWallDir(cfg)) {
      const { syncGameWall } = await import("../core/wall.js");
      await syncGameWall({ appid: appID, game, pairs, previous, cfg });
    }
  }
}

export async function startWatchdog() {
  const cfg = await loadConfig();
  setLogFile(path.join(dataRoot(), "logs", "aw2-watchdog.log"));

  const lock = acquireSingleInstance(path.join(dataRoot(), "aw2.lock"));
  if (!lock) {
    log.info("已有 aw2 watchdog 在运行，本实例退出（单实例保护）。");
    return { alreadyRunning: true };
  }

  log.info("aw2 watchdog starting ...");

  if (!cfg._primaryKey && !cfg._fallbackKey) {
    log.error("未配置 Steam API Key（https://steamcommunity.com/dev/apikey 免费申请）。运行: node src/cli.js setkey <KEY>");
    process.exit(1);
  }

  if (cfg.websocket?.enabled) {
    try { startWebSocket(cfg.websocket); }
    catch (e) { log.error(`[WS] 启动失败: ${e.message}`); }
  }

  const userDirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
  const folders = await getWatchFolders({ userDirs });
  log.info(`监视 ${folders.length} 个成就目录`);

  // 后台预热成就 schema：首次解锁时不联网，避免网络差导致通知延迟
  const appids = [...new Set(folders.map((f) => f.appid).filter(Boolean))];
  if (appids.length) {
    setTimeout(() => {
      prefetchSchemas({
        appids,
        lang: cfg.lang,
        apiKey: cfg._primaryKey,
        fallbackKey: cfg._fallbackKey,
        concurrency: 2,
      })
        .then((r) => {
          log.info(`[PREFETCH] 完成：新下载 ${r.ok.length}，已缓存 ${r.cached.length}，失败 ${r.failed.length}`);
          for (const f of r.failed) log.warn(`[PREFETCH] ${f.appid} 失败：${f.error}`);
        })
        .catch((e) => log.warn(`[PREFETCH] ${e.message}`));
    }, 1500).unref?.();
  }

  // 挂监视。目录 key 用小写绝对路径去重（Windows 不区分大小写），重复调用不会重复挂。
  const watchers = new Map(); // key -> { watcher, folder }
  const lastMtime = new Map(); // 文件绝对路径(小写) -> 上次处理过的 mtime，用于去重
  const queues = new Map(); // 文件绝对路径(小写) -> Promise，保证同一文件的处理串行
  function attachWatcher(folder) {
    const key = path.resolve(folder.dir).toLowerCase();
    if (watchers.has(key)) return false;
    try {
      const watcher = fs.watch(folder.dir, { recursive: true }, async (eventType, filename) => {
        if (!filename) return;
        // Windows 上文件被「写临时文件再改名」替换时报的是 rename，不能只认 change
        if (eventType !== "change" && eventType !== "rename") return;
        const base = path.basename(filename);
        if (!folder.files.includes(base)) return;
        const full = path.join(folder.dir, filename);

        // 用 mtime 去重（同一版本只处理一次），替代原来「必须 1 秒内修改」的墙钟判断：
        // 后者会把事件延迟投递、写盘稍慢的游戏更新直接丢掉，导致解锁不通知。
        const mt = await mtimeMs(full);
        if (mt === 0) return; // 文件被删除或还没落盘
        const fileKey = path.resolve(full).toLowerCase();
        if (lastMtime.get(fileKey) === mt) return;
        lastMtime.set(fileKey, mt);

        // 串行化：同一文件的多次事件排队执行，避免两次处理都判定为「新解锁」而重复弹窗
        const prev = queues.get(fileKey) || Promise.resolve();
        const next = prev
          .then(() => handleFileChange(folder, full, cfg))
          .catch((e) => log.warn(`[WATCH] ${e.message}`))
          .finally(() => { if (queues.get(fileKey) === next) queues.delete(fileKey); });
        queues.set(fileKey, next);
      });
      watcher.on("error", (e) => log.warn(`[WATCH] ${folder.dir}: ${e.message}`));
      watchers.set(key, { watcher, folder });
      log.info(`[WATCH] ${folder.source}: ${folder.dir} (${folder.files.join(", ")}) appid=${folder.appid ?? "?"}`);
      return true;
    } catch (e) {
      log.warn(`[WATCH] 无法监视 ${folder.dir}: ${e.message}`);
      return false;
    }
  }
  for (const folder of folders) attachWatcher(folder);

  // 定期重新发现：游戏「首次运行」后才生成的成就目录（如 GSE Saves\<appid>）必须补挂监视，
  // 否则新装的游戏解锁成就会被漏掉——启动时那个目录还不存在。
  // 已消失的目录顺带摘掉，避免 fs.watch 报错刷屏。
  const RESCAN_MS = Number(process.env.AW2_RESCAN_MS) || 60000;
  let rescanning = false;
  async function rescan() {
    if (rescanning) return;
    rescanning = true;
    try {
      const dirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
      const next = await getWatchFolders({ userDirs: dirs });
      const added = next.filter((f) => attachWatcher(f));

      for (const [key, { watcher, folder }] of watchers) {
        if (await exists(folder.dir)) continue;
        try { watcher.close(); } catch { /* ignore */ }
        watchers.delete(key);
        log.info(`[WATCH-] 目录已消失，停止监视: ${folder.dir}`);
      }

      if (added.length) {
        const ids = [...new Set(added.map((f) => f.appid).filter(Boolean))];
        log.info(`[WATCH+] 新增 ${added.length} 个成就目录${ids.length ? `（appid: ${ids.join(", ")}）` : ""}`);
        if (ids.length) {
          prefetchSchemas({
            appids: ids,
            lang: cfg.lang,
            apiKey: cfg._primaryKey,
            fallbackKey: cfg._fallbackKey,
            concurrency: 2,
          })
            .then((r) => log.info(`[WATCH+] 新目录成就数据：下载 ${r.ok.length}，缓存 ${r.cached.length}，失败 ${r.failed.length}`))
            .catch((e) => log.warn(`[WATCH+] 预取失败：${e.message}`));
        }
      }
    } catch (e) {
      log.warn(`[RESCAN] ${e.message}`);
    } finally {
      rescanning = false;
    }
  }
  const rescanTimer = setInterval(rescan, RESCAN_MS);
  rescanTimer.unref?.();

  log.info(`watchdog 就绪。Ctrl+C 退出（每 ${Math.round(RESCAN_MS / 1000)} 秒自动检查有没有新的成就目录）`);

  process.on("SIGINT", () => {
    log.info("watchdog stopping ...");
    clearInterval(rescanTimer);
    for (const { watcher } of watchers.values()) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    process.exit(0);
  });

  return { cfg, folders, watchers: [...watchers.values()].map((w) => w.watcher) };
}
