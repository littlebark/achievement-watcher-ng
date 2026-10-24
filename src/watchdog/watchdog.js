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
      });
      log.info(`[NOTIFY] ${payload.game} :: ${payload.displayName}`);
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
        log.info(`[UNLOCK] ${game.name} :: ${pair.schemaAchievement.displayName}`);
        await notify(pair, game, { cfg }, j++);
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

  // 成就墙实时同步（cfg.wall.dir 为空时关闭）
  if (cfg.wall?.dir) {
    const { syncGameWall } = await import("../core/wall.js");
    await syncGameWall({ appid: appID, game, pairs, previous, cfg });
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

  const watchers = [];
  for (const folder of folders) {
    try {
      const watcher = fs.watch(folder.dir, { recursive: true }, async (eventType, filename) => {
        if (eventType !== "change" || !filename) return;
        const base = path.basename(filename);
        if (!folder.files.includes(base)) return;
        const full = path.join(folder.dir, filename);
        // 只有 1 秒内修改的文件才算"刚写入"（防止扫描历史存档）
        if ((await mtimeMs(full)) === 0 || Date.now() - (await mtimeMs(full)) > 1000) return;
        try { await handleFileChange(folder, full, cfg); }
        catch (e) { log.warn(`[WATCH] ${e.message}`); }
      });
      watcher.on("error", (e) => log.warn(`[WATCH] ${folder.dir}: ${e.message}`));
      watchers.push(watcher);
      log.info(`[WATCH] ${folder.source}: ${folder.dir} (${folder.files.join(", ")}) appid=${folder.appid ?? "?"}`);
    } catch (e) {
      log.warn(`[WATCH] 无法监视 ${folder.dir}: ${e.message}`);
    }
  }

  // 配置热重载（简化版：watchdog 进程退出后手动重启；后续版本做自动 reload）
  log.info("watchdog 就绪。Ctrl+C 退出。");

  process.on("SIGINT", () => {
    log.info("watchdog stopping ...");
    watchers.forEach((w) => w.close());
    process.exit(0);
  });

  return { cfg, folders, watchers };
}
