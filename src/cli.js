#!/usr/bin/env node
// CLI: scan / list / watch / setkey / test-toast
import path from "node:path";
import { parseAchievementFile } from "./core/normalize/file-parsers.js";
import { getWatchFolders, loadUserDirs } from "./core/discover.js";
import { getGameData } from "./core/schema.js";
import { matchAchievements } from "./core/match.js";
import { loadConfig, saveConfig, encrypt, decrypt, resolvedPaths } from "./core/config.js";
import { dataRoot } from "./core/schema.js";
import { generateEmuConfig } from "./core/emugen.js";
import { applyEmu, restoreEmu } from "./core/emuinstall.js";
import { startWatchdog } from "./watchdog/watchdog.js";
import { sendToast } from "./watchdog/notify/toast.js";
import { log } from "./shared/log.js";

const [, , cmd, ...args] = process.argv;

async function cmdScan() {
  const userDirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
  const folders = await getWatchFolders({ userDirs });
  console.log(`发现 ${folders.length} 个成就目录：\n`);
  for (const f of folders) {
    console.log(`  [${f.source}] appid=${f.appid ?? "?"}  ${f.dir}`);
    console.log(`      files: ${f.files.join(", ")}`);
  }
}

async function cmdList(appID) {
  if (!appID) return console.log("用法: node src/cli.js list <appid|路径>");
  const cfg = await loadConfig();

  let entries = [];
  let game;
  if (/^\d+$/.test(appID)) {
    // 通过监视表找该 appid 的成就文件
    const userDirs = await loadUserDirs(path.join(dataRoot(), "cfg"));
    const folders = await getWatchFolders({ userDirs });
    const folder = folders.find((f) => f.appid === appID);
    if (!folder) return console.log(`未在已知目录中找到 appid=${appID} 的成就文件（先跑 scan 看看）`);
    entries = await parseAchievementFile(path.join(folder.dir, folder.files[0]));
    game = await getGameData({ appID, lang: cfg.lang, apiKey: cfg._primaryKey, fallbackKey: cfg._fallbackKey });
  } else {
    // 直接给成就文件路径
    entries = await parseAchievementFile(appID);
    return printEntries(entries, null);
  }

  const pairs = matchAchievements(game.achievement.list, entries);
  const unlocked = pairs.filter((p) => p.local.Achieved).length;
  console.log(`\n${game.name} (appid=${game.appid}) — ${unlocked}/${game.achievement.total}\n`);
  for (const p of pairs) {
    const time = p.local.UnlockTime ? new Date(p.local.UnlockTime * 1000).toLocaleString() : "-";
    console.log(`  ${p.local.Achieved ? "✅" : "⬜"} ${p.schemaAchievement.displayName}${p.schemaAchievement.hidden ? " [隐藏]" : ""}  ${time}`);
  }
}

function printEntries(entries) {
  for (const e of entries) {
    console.log(`  ${e.Achieved ? "✅" : "⬜"} ${e.name}  t=${e.UnlockTime}`);
  }
}

async function cmdSetKey(key) {
  if (!key) return console.log("用法: node src/cli.js setkey <STEAM_API_KEY>");
  const cfg = await loadConfig();
  cfg.steamApiKey = encrypt(key);
  await saveConfig(cfg);
  console.log("已保存（加密存储）。");
}

async function cmdTestToast() {
  try {
    await sendToast({
      title: "aw2 测试通知",
      message: "如果你看到这条 Toast，说明通知链路 OK 🎉",
      icon: null,
    });
    console.log("Toast 已发送。");
  } catch (e) {
    console.error(`Toast 失败: ${e.message}`);
  }
}

async function cmdEmuGen(appid, gameDir, flags = []) {
  if (!appid || !/^\d+$/.test(appid)) {
    const roots = resolvedPaths(await loadConfig()).gameSearchDirs;
    return console.log(`用法: node src/cli.js emu-gen <appid> [游戏目录] [--no-icons]\n  省略游戏目录时自动在 ${roots.join("、")} 下按 steam_appid.txt 搜索`);
  }
  const withIcons = !flags.includes("--no-icons");
  let dir = gameDir;
  if (!dir) {
    const { autoFindGameDir } = await import("./core/emugen.js");
    const cfg = await loadConfig();
    const roots = resolvedPaths(cfg).gameSearchDirs;
    console.log(`未指定游戏目录，自动搜索 ${roots.join("、")} ...`);
    dir = await autoFindGameDir(appid, roots);
    if (!dir) return console.log(`没找到 appid=${appid} 的游戏（可用第二参数手动指定目录，或用 path set gameSearchDirs 加搜索根）`);
    console.log(`命中: ${dir}`);
  }
  const cfg = await loadConfig();
  const r = await generateEmuConfig({ appid, gameDir: dir, lang: cfg.lang, withIcons, apiKey: cfg._primaryKey, fallbackKey: cfg._fallbackKey });

  console.log(`\n${r.gameName} (appid=${appid}) — ${r.total} 项成就`);
  console.log(`已写入: ${path.join(r.settingsDir, "achievements.json")}`);
  if (r.overwritten) {
    console.log("检测到旧配置，已备份为 achievements.json.bak");
    if (r.added.length) console.log(`  新增: ${r.added.join(", ")}`);
    if (r.removed.length) console.log(`  移除: ${r.removed.join(", ")}`);
    if (!r.added.length && !r.removed.length) console.log("  与旧配置成就名完全一致（仅刷新图标/文本）");
  }
  if (r.icons) {
    console.log(`图标: 成功 ${r.icons.ok}，失败 ${r.icons.fail.length}`);
    for (const f of r.icons.fail.slice(0, 5)) console.log(`  ✗ ${f}`);
    if (r.icons.fail.length > 5) console.log(`  ...等 ${r.icons.fail.length} 个失败（重跑本命令可续传）`);
  }
  console.log("\n完成。启动游戏解锁任意成就即可验证。");
}

async function cmdEmuApply(appid, gameDir, flags = []) {
  if (!appid || !/^\d+$/.test(appid)) {
    return console.log("用法: node src/cli.js emu-apply <appid> [游戏目录] [--steamclient] [--dry-run] [--no-icons] [--source <emu目录>]");
  }
  const mode = flags.includes("--steamclient") ? "steamclient" : "regular";
  const dryRun = flags.includes("--dry-run");
  const withIcons = !flags.includes("--no-icons");
  const si = flags.indexOf("--source");
  const source = si >= 0 ? flags[si + 1] : undefined;
  const cfg = await loadConfig();

  let dir = gameDir;
  if (!dir || dir.startsWith("--")) {
    const { autoFindGameDir } = await import("./core/emugen.js");
    const roots = resolvedPaths(cfg).gameSearchDirs;
    console.log(`未指定游戏目录，自动搜索 ${roots.join("、")} ...`);
    dir = await autoFindGameDir(appid, roots);
    if (!dir) return console.log(`没找到 appid=${appid} 的游戏（用第二参数指定目录，或用 path set gameSearchDirs 加搜索根）`);
    console.log(`命中: ${dir}`);
  }
  const r = await applyEmu({
    appid, gameDir: dir, mode, source, withIcons, dryRun,
    lang: cfg.lang, apiKey: cfg._primaryKey, fallbackKey: cfg._fallbackKey,
  });

  if (r.dryRun) {
    console.log(`\n[预演] 模式=${r.mode}  emu源=${r.src}`);
    console.log(`exe 目录: ${r.exeDir}`);
    console.log(`DLL 目录: ${r.dllDirs.join(" | ")}`);
    for (const p of r.plan) console.log(`  ${p.kind === "dll" ? "替换" : "写入"} ${p.target}`);
    return console.log("\n（未做任何修改；去掉 --dry-run 执行）");
  }

  console.log(`\n已安装（模式=${r.mode}）`);
  for (const a of r.applied) console.log(`  ✓ ${a.path}${a.backup ? "（备份 " + path.basename(a.backup) + "）" : ""}`);
  for (const g of r.genResults) {
    console.log(`  成就配置: ${path.join(g.dir, "achievements.json")} — ${g.total} 项` + (g.icons ? `，图标 ${g.icons.ok}/${g.icons.ok + g.icons.fail.length}` : ""));
  }
  console.log(`\n安装清单: ${r.manifestFile}`);
  console.log("回滚命令: node src\\cli.js emu-restore " + appid);
}

async function cmdEmuSource(input) {
  const { installEmuSource, showEmuSourceInfo } = await import("./core/emuinstall.js");
  if (!input) {
    const cur = await showEmuSourceInfo();
    if (!cur) return console.log("尚未安装 emu 源。用法: node src\\cli.js emu-source <gbe_fork的7z或解压目录>");
    console.log(`当前 emu 源: ${cur.root}`);
    if (cur.version) {
      console.log(`  安装时间: ${cur.version.installedAt}`);
      console.log(`  来源: ${cur.version.from}`);
    }
    for (const f of cur.version?.files ?? []) console.log(`  ${f.rel.padEnd(48)} ${(f.size / 1048576).toFixed(1)} MB`);
    return;
  }
  const r = await installEmuSource(input);
  console.log(`已安装 emu 源到: ${r.dst}`);
  for (const f of r.files) console.log(`  ✓ ${f.rel}  ${(f.size / 1048576).toFixed(1)} MB`);
  console.log("\n之后 emu-apply 将自动使用该源（移动硬盘拔掉时会回退 AppData/本地工具目录）。");
}

async function cmdWall(dir) {
  const { exportWall } = await import("./core/wall.js");
  const cfg = await loadConfig();

  if (dir === "off") {
    await saveConfig({ ...cfg, wall: { ...cfg.wall, dir: "" } });
    return console.log("成就墙已关闭。");
  }
  if (dir) {
    await saveConfig({ ...cfg, wall: { ...cfg.wall, dir: path.resolve(dir) } });
    cfg.wall.dir = path.resolve(dir);
  }
  if (!cfg.wall?.dir) {
    return console.log("用法: node src\\cli.js wall <导出目录>   设置成就墙目录并立即全量导出\n      node src\\cli.js wall           重新全量导出\n      node src\\cli.js wall off       关闭成就墙\n\n设置后 watchdog 会在每次解锁时实时同步该目录。");
  }

  console.log(`成就墙目录: ${cfg.wall.dir}`);
  console.log("全量导出中 ...");
  const r = await exportWall({ cfg, wallDir: cfg.wall.dir });
  for (const g of r.games) {
    console.log(`  ✓ ${g.appid} ${g.name} — ${g.unlocked}/${g.total}（${g.percent}%）` +
      (g.icons?.fail?.length ? `，图标失败 ${g.icons.fail.length}` : ""));
  }
  for (const e of r.errors) console.log(`  ✗ ${e}`);
  console.log(`\n完成：${r.games.length} 个游戏 → ${path.join(r.wallDir, "index.json")}`);
}

async function cmdEmuRestore(appid) {
  if (!appid) return console.log("用法: node src/cli.js emu-restore <appid>");
  const r = await restoreEmu(appid);
  console.log(`已回滚（模式=${r.mode}，清单 ${path.basename(r.manifest)}）`);
  for (const line of r.restored) console.log("  ✓ " + line);
}

// ---------- path：查看/设置全部可配置路径 ----------
const PATH_FIELDS = {
  wall:              { label: "成就墙导出目录", kind: "single", get: (c) => c.wall?.dir || "", set: (c, v) => { c.wall = { ...c.wall, dir: v }; } },
  emuRoots:          { label: "Goldberg 模拟器源根目录（emu-source 安装到这里，emu-apply 从这取 DLL）", kind: "list" },
  emuExtraSources:   { label: "额外 emu 源搜索目录（只读借用，如旧工具自带的 goldberg）", kind: "list" },
  gameSearchDirs:    { label: "游戏搜索根目录（emu-gen / emu-apply 自动找游戏）", kind: "list" },
};

function showPaths(cfg) {
  const rp = resolvedPaths(cfg);
  console.log("当前生效路径（aw2.json paths.* 为空时使用内置默认）：\n");
  for (const [name, meta] of Object.entries(PATH_FIELDS)) {
    const eff = name === "wall" ? (cfg.wall?.dir || "（未设置，成就墙关闭）") : rp[name].join("\n  ");
    const userSet = name === "wall" ? !!cfg.wall?.dir
      : Array.isArray(cfg.paths?.[name]) && cfg.paths[name].length;
    console.log(`[${name}]${userSet ? "（自定义）" : "（默认）"} ${meta.label}`);
    console.log(`  ${eff}\n`);
  }
  console.log("设置方式:");
  console.log("  node src/cli.js path set wall <目录>                设置成就墙目录（立即导出，watchdog 实时同步）");
  console.log("  node src/cli.js path set <emuRoots|emuExtraSources|gameSearchDirs> <目录1> [目录2 ...]  多个目录按顺序取优先级");
  console.log("  node src/cli.js path reset <字段名>                  恢复内置默认（wall 即关闭成就墙）");
}

async function cmdPath(op, field, ...vals) {
  const cfg = await loadConfig();

  if (!op || op === "show") return showPaths(cfg);
  if (op !== "set" && op !== "reset") return console.log(`未知操作: ${op}（可选 set / reset / show）`);
  if (!field || !PATH_FIELDS[field]) {
    return console.log(`未知字段: ${field || "（空）"}（可选 ${Object.keys(PATH_FIELDS).join(" / ")}）`);
  }

  if (op === "reset") {
    if (field === "wall") cfg.wall = { ...cfg.wall, dir: "" };
    else cfg.paths = { ...cfg.paths, [field]: [] };
    await saveConfig(cfg);
    return console.log(`已恢复默认: ${field}（成就墙关闭后如需重开用 path set wall <目录>）`);
  }

  if (!vals.length) return console.log("用法: node src/cli.js path set <字段名> <目录...>");

  if (field === "wall") {
    const dir = path.resolve(vals[0]);
    PATH_FIELDS.wall.set(cfg, dir);
    await saveConfig(cfg);
    console.log(`成就墙目录: ${dir}`);
    console.log("全量导出中 ...");
    const { exportWall } = await import("./core/wall.js");
    const r = await exportWall({ cfg: await loadConfig(), wallDir: dir });
    for (const g of r.games) console.log(`  ✓ ${g.appid} ${g.name} — ${g.unlocked}/${g.total}`);
    for (const e of r.errors) console.log(`  ✗ ${e}`);
    return console.log(`\n完成：${r.games.length} 个游戏 → ${path.join(r.wallDir, "index.json")}`);
  }

  const dirs = vals.map((v) => path.resolve(v));
  cfg.paths = { ...cfg.paths, [field]: dirs };
  await saveConfig(cfg);
  console.log(`已保存 ${field}（按顺序优先）:`);
  for (const d of dirs) console.log(`  ${d}`);
  if (field === "emuRoots") console.log("\n注意：原有 emu-source 安装位置若不再列在前面，重新跑一次 emu-source 即可装到新位置。");
}

async function main() {
  switch (cmd) {
    case "scan": return cmdScan();
    case "list": return cmdList(args[0]);
    case "watch": return startWatchdog();
    case "emu-gen": return cmdEmuGen(args[0], args[1], args.slice(2));
    case "emu-apply": return cmdEmuApply(args[0], args[1], args.slice(2));
    case "emu-restore": return cmdEmuRestore(args[0]);
    case "emu-source": return cmdEmuSource(args[0]);
    case "wall": return cmdWall(args[0]);
    case "path": return cmdPath(args[0], args[1], ...args.slice(2));
    case "ui": {
      const { startUI } = await import("./server.js");
      startUI(Number(args[0]) || undefined);
      break;
    }
    case "setkey": return cmdSetKey(args[0]);
    case "showkey":
      console.log("当前主 key:", (await loadConfig())._primaryKey);
      break;
    case "test-toast": return cmdTestToast();
    default:
      console.log(`Achievement Watcher NG v0.1
用法:
  node src/cli.js ui            打开图形面板（游戏库/成就/设置）
  node src/cli.js scan          扫描本机成就存档目录
  node src/cli.js list <appid|文件路径>   查看成就状态
  node src/cli.js watch         启动实时通知 watchdog
  node src/cli.js setkey <KEY>  设置 Steam Web API Key
  node src/cli.js emu-gen <appid> [游戏目录] [--no-icons]
                                为 Goldberg 系模拟器生成 steam_settings 成就配置
  node src/cli.js emu-apply <appid> [游戏目录] [--steamclient] [--dry-run]
                                安装模拟器（自动备份原 DLL，可一键回滚）
  node src/cli.js emu-restore <appid>   回滚最近一次模拟器安装
  node src/cli.js emu-source <7z或目录> 安装/更新模拟器源（emu-apply 用的 DLL 仓库）
  node src/cli.js emu-source            查看当前模拟器源版本
  node src/cli.js wall <目录>           成就墙：把所有游戏成就归一化为 Steam 字段标准导出
  node src/cli.js path                 查看全部可配置路径（成就墙 / emu 源 / 游戏搜索根）
  node src/cli.js path set <字段> <目录...>    自定义路径（wall / emuRoots / emuExtraSources / gameSearchDirs）
  node src/cli.js path reset <字段>     恢复该字段的内置默认
  node src/cli.js test-toast    发送测试 Toast 通知`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
