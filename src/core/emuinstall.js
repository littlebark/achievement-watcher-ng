// emu-apply / emu-restore：给游戏安装 / 卸载 Goldberg 系模拟器
// 特点：本地 emu 源（不联网）、自动定位所有 steam_api*.dll、备份 + 安装清单、可一键回滚
//
// 两种模式：
//   regular      —— 直接把 steam_api.dll / steam_api64.dll 换成模拟器版（绝大多数游戏）
//   steamclient  —— 保留游戏原版 steam_api，只在 exe 旁放 steamclient64.dll
//                   （适用于 steam_api 已被改造成代理/壳的游戏，如 Memoria SteamFix、ColdClientLoader 场景）
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists, writeJSON, readJSON } from "../shared/fsx.js";
import { log } from "../shared/log.js";
import { dataRoot, projectRoot } from "./schema.js";
import { loadConfig, resolvedPaths } from "./config.js";
import { generateEmuConfig } from "./emugen.js";

const run = promisify(execFile);

// emu 源根目录（优先级从高到低）：来自数据目录 aw2.json 的 paths.emuRoots，
// 为空时只用 <数据目录>/tools/steam-emu 兜底；个人路径（如移动硬盘）写进配置即可
export async function emuToolRoots() {
  const cfg = await loadConfig();
  return resolvedPaths(cfg).emuRoots;
}

function manifestDir() {
  return path.join(dataRoot(), "tools", "emu-install");
}

// vendor 根：打包版（asar）时 vendor 被 asarUnpack 到 app.asar.unpacked 旁，
// 子进程（tar 解 7z）读不了 asar 虚拟路径，必须用真实磁盘路径
function vendorRoot() {
  if (projectRoot.includes("app.asar")) {
    return path.join(projectRoot.replace("app.asar", "app.asar.unpacked"), "vendor");
  }
  return path.join(projectRoot, "vendor");
}

// 找到可用的 emu 源目录（含 steam_api64.dll）
// 优先级：--source 显式指定 → 用户配置 emuRoots → emuExtraSources → 内置 vendor 包自动展开
export async function resolveEmuSource(explicit) {
  const cfg = await loadConfig();
  const paths = resolvedPaths(cfg);
  const pick = async (candidates) => {
    for (const c of candidates) {
      if (!c) continue;
      if (await exists(path.join(c, "steam_api64.dll"))) return path.resolve(c);
    }
    return null;
  };

  const vendorDir = path.join(vendorRoot(), "steam-emu");
  let src = await pick([explicit, ...paths.emuRoots, ...paths.emuExtraSources, vendorDir]);
  if (!src) src = await expandVendoredEmu(); // 开箱兜底：解压项目内置的 gbe_fork 包
  if (!src) {
    throw new Error(
      "未找到 Goldberg 模拟器源（vendor 目录缺少内置包）。请运行:\n  node src\\cli.js emu-source <gbe_fork的7z或解压目录>\n安装到 " +
        paths.emuRoots.join(" 或 ") +
        "\n或用 --source <目录> 指定（该目录需含 steam_api64.dll）\n" +
        "（可用 `node src\\cli.js path set emuRoots <目录...>` 自定义搜索位置）"
    );
  }
  return src;
}

// 项目内置 emu 源（vendor/steam-emu/*.7z）：首次使用时用系统 tar 只解出 regular 版
// steam_api64.dll / steam_api.dll 到 <数据目录>/tools/steam-emu，之后走正常候选流程
async function expandVendoredEmu() {
  const vendorDir = path.join(vendorRoot(), "steam-emu");
  let entries = [];
  try { entries = await fsp.readdir(vendorDir); } catch { return null; }
  const pkg = entries.find((f) => /\.7z$/i.test(f));
  if (!pkg) return null;
  const pkgPath = path.join(vendorDir, pkg);
  if (!(await exists(path.join(dataRoot(), "tools", "steam-emu", "steam_api64.dll")))) {
    log.info("[EMU] 首次使用内置 gbe_fork 源，解压 regular DLL ...");
    const tar = path.join(process.env.SystemRoot || "C://Windows", "System32", "tar.exe");
    // 1) 列出包内文件，找到新结构里的 regular DLL（带可能的顶层目录前缀）
    const { stdout } = await run(tar, ["-tf", pkgPath], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const want = [
      { rel: "steam_api64.dll", re: /(^|\/)regular\/x64\/steam_api64\.dll$/i },
      { rel: "steam_api.dll", re: /(^|\/)regular\/x86\/steam_api\.dll$/i },
    ];
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aw2-vendor-"));
    try {
      for (const w of want) {
        const hit = lines.find((l) => w.re.test(l.trim()));
        if (!hit) continue;
        await run(tar, ["-xf", pkgPath, "-C", tmpDir, hit.trim()], { windowsHide: true });
      }
      // 2) 归位到 <数据目录>/tools/steam-emu
      const dst = path.join(dataRoot(), "tools", "steam-emu");
      await fsp.mkdir(dst, { recursive: true });
      const copied = [];
      for (const w of want) {
        const extracted = await findFile(tmpDir, w.rel);
        if (!extracted) continue;
        await fsp.copyFile(extracted, path.join(dst, w.rel));
        copied.push(w.rel);
      }
      if (!copied.includes("steam_api64.dll")) throw new Error("内置包里没找到 regular/x64/steam_api64.dll");
      await writeJSON(path.join(dst, "VERSION.json"), {
        installedAt: new Date().toISOString(),
        from: `vendor/${pkg}（aw2 内置，仅展开 regular DLL）`,
        upstream: "github.com/Detanup01/gbe_fork",
        package: { name: pkg, vendor: true },
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return path.join(dataRoot(), "tools", "steam-emu");
}

// 在临时解压目录里按文件名递归找（包内可能有一层顶层目录前缀）
async function findFile(root, name, depth = 4) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === name) return full;
  }
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = await findFile(path.join(root, e.name), name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

// 递归找所有含 steam_api*.dll 的目录（限深 4）
async function findDllDirs(root, depth = 4, out = []) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return out; }
  if (entries.some((e) => e.isFile() && /^steam_api(64)?\.dll$/i.test(e.name))) out.push(root);
  if (depth <= 0) return out;
  for (const e of entries) {
    if (e.isDirectory() && !/^(steam_settings|_CommonRedist|__redist)$/i.test(e.name)) {
      await findDllDirs(path.join(root, e.name), depth - 1, out);
    }
  }
  return out;
}

// 排除的目录：redist / 修改器 / 工具，这些里的 exe 不是游戏本体
const EXE_SKIP_DIR = /^(_CommonRedist|__redist|redist|$RECYCLE\.BIN)$|修改器|修改工具|trainer|cheat|artmoney|存档|备份|tools?$/i;

function isAncestorOrSelf(anc, dir) {
  const a = path.resolve(anc).toLowerCase();
  const d = path.resolve(dir).toLowerCase();
  return d === a || d.startsWith(a + path.sep);
}

// 找游戏 exe 所在目录：
// 优先级 ① 是 DLL 目录的祖先（游戏根/主目录）② exe 体积大 ③ 层级浅
async function findExeDir(root, dllDirs = [], depth = 3) {
  const cands = [];
  async function walk(dir, d) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && /\.exe$/i.test(e.name)) {
        const st = await fsp.stat(full).catch(() => null);
        if (st && st.size > 1024 * 1024) cands.push({ size: st.size, dir, name: e.name });
      } else if (e.isDirectory() && d > 0 && !EXE_SKIP_DIR.test(e.name)) {
        await walk(full, d - 1);
      }
    }
  }
  await walk(root, depth);
  if (!cands.length) return root;

  const scored = cands.map((c) => ({
    ...c,
    covers: dllDirs.some((d) => isAncestorOrSelf(c.dir, d)) ? 1 : 0,
    depth: path.resolve(c.dir).split(path.sep).length,
  }));
  scored.sort((a, b) => b.covers - a.covers || b.size - a.size || a.depth - b.depth);
  return scored[0].dir;
}

// 把 account_name 写进 steam_settings/configs.user.ini 的 [user::general] 段。
// 游戏本地层优先级高于全局 GSE Saves 设置，可覆盖下载站预置的名字；文件里其他字段原样保留。
export async function writeAccountName(settingsDir, name) {
  const file = path.join(settingsDir, "configs.user.ini");
  let lines = [];
  if (await exists(file)) lines = (await fsp.readFile(file, "utf8")).split(/\r?\n/);
  if (!lines.some((l) => /^\s*\[user::general\]/i.test(l))) lines = ["[user::general]", ...lines];
  let replaced = false;
  lines = lines.map((l) => {
    if (!replaced && /^\s*account_name\s*=/i.test(l)) {
      replaced = true;
      return `account_name=${name}`;
    }
    return l;
  });
  if (!replaced) {
    const gi = lines.findIndex((l) => /^\s*\[user::general\]/i.test(l));
    lines.splice(gi + 1, 0, `account_name=${name}`);
  }
  await fsp.writeFile(file, lines.join("\n") + "\n", "utf8");
  return file;
}

// 游戏内用户名的默认解析链：显式输入 > 全局 gbe_fork 配置里用户设过的名字 > Windows 用户名
export async function resolveAccountName(explicit) {
  const s = (explicit || "").trim();
  if (s) return s;
  try {
    const g = path.join(process.env.APPDATA || "", "GSE Saves", "settings", "configs.user.ini");
    const m = (await fsp.readFile(g, "utf8")).match(/^\s*account_name\s*=\s*(\S.*?)\s*$/m);
    if (m?.[1]) return m[1];
  } catch { /* 没有全局配置，继续降级 */ }
  return process.env.USERNAME || "Player";
}

export async function applyEmu({ appid, gameDir, mode = "regular", source, withIcons = true, dryRun = false, lang, apiKey, fallbackKey, userName }) {
  const src = await resolveEmuSource(source);
  const root = path.resolve(gameDir);
  const dllDirs = await findDllDirs(root);
  if (!dllDirs.length) throw new Error(`${root} 下没有找到 steam_api.dll / steam_api64.dll`);
  const exeDir = await findExeDir(root, dllDirs);

  const plan = [];
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  if (mode === "regular") {
    for (const dir of dllDirs) {
      for (const [orig, emu] of [["steam_api64.dll", "steam_api64.dll"], ["steam_api.dll", "steam_api.dll"]]) {
        const target = path.join(dir, orig);
        if (!(await exists(target))) continue;
        plan.push({ kind: "dll", dir, target, source: path.join(src, emu) });
      }
    }
  } else if (mode === "steamclient") {
    const s = path.join(src, "experimental_steamclient");
    for (const f of ["steamclient64.dll", "steamclient.dll"]) {
      const from = path.join(s, f);
      if (await exists(from)) plan.push({ kind: "dll", dir: exeDir, target: path.join(exeDir, f), source: from });
    }
    plan.push({ kind: "appid", dir: exeDir, target: path.join(exeDir, "steam_appid.txt"), content: String(appid) + "\n" });
  } else {
    throw new Error(`未知模式: ${mode}（可选 regular / steamclient）`);
  }

  // 校验源文件
  if (!plan.length) {
    if (mode === "steamclient") {
      throw new Error("steamclient 模式需要 emu 源里有 experimental_steamclient/ 变体（内置精简源只含 regular 版）。请先 `node src\\cli.js emu-source <完整包>` 安装完整源再试。");
    }
    throw new Error("没有可应用的补丁项（游戏目录里没找到 steam_api*.dll）");
  }
  for (const item of plan) {
    if (item.kind === "dll" && !(await exists(item.source))) {
      throw new Error(`模拟器源文件缺失: ${item.source}`);
    }
  }

  if (dryRun) return { dryRun: true, src, mode, exeDir, dllDirs, plan };

  const applied = [];
  for (const item of plan) {
    if (item.kind === "dll") {
      const bak = item.target + ".aw2bak";
      if (!(await exists(bak))) await fsp.copyFile(item.target, bak);
      await fsp.copyFile(item.source, item.target);
      applied.push({ path: item.target, backup: bak });
    } else {
      await fsp.writeFile(item.target, item.content);
      applied.push({ path: item.target, backup: null });
    }
  }

  // 生成成就配置（每个被替换的 DLL 目录都要有 steam_settings）
  const settingsDirs = mode === "regular" ? dllDirs : [exeDir];
  const genResults = [];
  for (const dir of settingsDirs) {
    const r = await generateEmuConfig({ appid, gameDir: dir, lang, withIcons, apiKey, fallbackKey });
    genResults.push({ dir: r.settingsDir, total: r.total, icons: r.icons });
  }

  // 游戏内用户名（account_name）：有传入才写，保证补丁自包含
  let userIniFile = null;
  if (userName) {
    for (const g of genResults) userIniFile = await writeAccountName(g.dir, userName);
  }

  const manifest = {
    appid: String(appid),
    gameDir: root,
    mode,
    source: src,
    at: now.toISOString(),
    applied,
    settingsDirs: genResults.map((g) => g.dir),
  };
  await fsp.mkdir(manifestDir(), { recursive: true });
  const mf = path.join(manifestDir(), `${stamp}-${appid}.json`);
  await writeJSON(mf, manifest);

  return { manifestFile: mf, mode, exeDir, applied, genResults, accountName: userName || null, userIniFile };
}

// 回滚到最近一次安装前的状态
// 按 manifest 文件执行回滚：还原备份 / 移除写入文件，并把 manifest 标记为已回滚
async function restoreFromManifest(mf) {
  const m = await readJSON(mf);
  const restored = [];
  for (const item of m.applied) {
    if (item.backup && (await exists(item.backup))) {
      await fsp.copyFile(item.backup, item.path);
      await fsp.unlink(item.backup);
      restored.push(`还原 ${item.path}`);
    } else {
      await fsp.unlink(item.path).catch(() => {});
      restored.push(`移除 ${item.path}`);
    }
  }
  // 记录已回滚，避免重复执行
  await fsp.rename(mf, mf.replace(/\.json$/, ".restored.json"));
  return { manifest: mf, mode: m.mode, restored, settingsDirs: m.settingsDirs };
}

export async function restoreEmu(appid) {
  const dir = manifestDir();
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith(`-${appid}.json`)); }
  catch { throw new Error("没有安装记录"); }
  if (!files.length) throw new Error(`没有 appid=${appid} 的安装记录`);

  files.sort(); // 时间戳前缀，升序
  return restoreFromManifest(path.join(dir, files[files.length - 1]));
}

// 按游戏目录回滚：在安装清单里找 gameDir 匹配的最近一次记录（网页"恢复原样"按钮用）
// 比按 appid 更稳：目录里 steam_appid.txt 被改/丢失时 appid 对不上，目录才是用户选中的事实
export async function restoreEmuByDir(gameDir) {
  const dir = manifestDir();
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")); }
  catch { /* 清单目录都没了，走兜底 */ }

  const root = path.resolve(gameDir);
  const want = root.toLowerCase();
  let latest = null;
  for (const f of files.sort()) { // 升序遍历，取最后命中的 = 最近一次
    const mf = path.join(dir, f);
    const m = await readJSON(mf).catch(() => null);
    if (m?.gameDir && m.applied && path.resolve(m.gameDir).toLowerCase() === want) latest = mf;
  }
  if (latest) return restoreFromManifest(latest);

  // 无清单兜底：清单可能随数据目录重建/迁移丢失，但游戏目录里的 .aw2bak 是可靠的事实。
  // 直接递归扫 *.aw2bak，逐个改回原名（覆盖现文件 = 回到打补丁前状态）。
  const restored = [];
  async function sweep(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await sweep(p); continue; }
      if (!e.name.toLowerCase().endsWith(".aw2bak")) continue;
      const target = p.replace(/\.aw2bak$/i, "");
      await fsp.rm(target, { force: true });
      await fsp.rename(p, target);
      restored.push(`还原 ${target}`);
    }
  }
  await sweep(root);
  if (!restored.length) throw new Error("该目录没有本工具的打补丁记录，也没找到 .aw2bak 备份（可能从未打过补丁，或已被还原过）");
  return { manifest: null, mode: "fallback", restored, settingsDirs: [] };
}

// ---------- emu-source：安装/更新模拟器源 ----------
// 接受 gbe_fork release 的 .7z 包或已解压目录，自动识别新旧两种包结构，
// 归一化拷贝到 emuToolRoots() 中第一个可写的位置（移动硬盘优先）。

const NEW_LAYOUT_MAP = [
  // [目标相对路径, 新版包内的候选来源（按顺序找第一个存在的）]
  ["steam_api64.dll", ["regular/x64/steam_api64.dll"]],
  ["steam_api.dll", ["regular/x86/steam_api.dll"]],
  ["experimental_steamclient/steamclient64.dll", ["steamclient_experimental/steamclient64.dll"]],
  ["experimental_steamclient/steamclient.dll", ["steamclient_experimental/steamclient.dll"]],
  ["experimental_steamclient/steamclient_loader.exe", ["steamclient_experimental/steamclient_loader_x64.exe"]],
  ["experimental/steam_api64.dll", ["experimental/x64/steam_api64.dll"]],
  ["experimental/steamclient64.dll", ["experimental/x64/steamclient64.dll"]],
  ["experimental/steam_api.dll", ["experimental/x86/steam_api.dll"]],
  ["experimental/steamclient.dll", ["experimental/x86/steamclient.dll"]],
];

async function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(await fsp.readFile(file));
  return h.digest("hex");
}

async function copyTree(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

export async function installEmuSource(input) {
  let p = path.resolve(input);
  if (!(await exists(p))) throw new Error(`路径不存在: ${p}`);

  let tmpDir = null;
  try {
    // .7z → 用系统自带 tar（libarchive）解压
    if (/\.7z$/i.test(p)) {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aw2-emu-"));
      const tar = path.join(process.env.SystemRoot || "C://Windows", "System32", "tar.exe");
      await run(tar, ["-xf", p, "-C", tmpDir], { windowsHide: true });
      p = tmpDir;
    }

    // 定位包根：含 steam_api64.dll（旧扁平）或含 release/（新结构）
    let root = p;
    if (!(await exists(path.join(root, "steam_api64.dll")))) {
      for (const cand of [path.join(root, "release"), root]) {
        if (await exists(path.join(cand, "regular", "x64", "steam_api64.dll"))) { root = cand; break; }
        if (await exists(path.join(cand, "steam_api64.dll"))) { root = cand; break; }
      }
    }

    let plan;
    if (await exists(path.join(root, "steam_api64.dll"))) {
      // 旧扁平结构：整包照搬
      plan = [{ rel: "steam_api64.dll", src: path.join(root, "steam_api64.dll") }];
      if (await exists(path.join(root, "steam_api.dll")))
        plan.push({ rel: "steam_api.dll", src: path.join(root, "steam_api.dll") });
      for (const d of ["experimental", "experimental_steamclient"]) {
        const from = path.join(root, d);
        if (!(await exists(from))) continue;
        for (const e of await fsp.readdir(from, { withFileTypes: true })) {
          if (e.isFile() && /\.(dll|exe)$/i.test(e.name))
            plan.push({ rel: `${d}/${e.name}`, src: path.join(from, e.name) });
        }
      }
    } else {
      // 新结构（release/regular/...）
      plan = [];
      for (const [rel, cands] of NEW_LAYOUT_MAP) {
        for (const c of cands) {
          const src = path.join(root, ...c.split("/"));
          if (await exists(src)) { plan.push({ rel, src }); break; }
        }
      }
    }
    if (!plan.some((x) => x.rel === "steam_api64.dll"))
      throw new Error("包内没找到 steam_api64.dll（不认识这个包结构）");

    // 目标位置：第一个可写的根
    const roots = await emuToolRoots();
    let dst = null;
    for (const r of roots) {
      try { await fsp.mkdir(r, { recursive: true }); dst = r; break; } catch { /* 下一个 */ }
    }
    if (!dst) throw new Error("无法创建 emu 源目录（移动硬盘在吗？）");

    const files = [];
    for (const it of plan) {
      const target = path.join(dst, ...it.rel.split("/"));
      await copyTree(it.src, target);
      files.push({ rel: it.rel, size: (await fsp.stat(target)).size, sha256: await sha256(target) });
    }

    const version = {
      installedAt: new Date().toISOString(),
      from: input,
      upstream: "github.com/Detanup01/gbe_fork",
      files,
    };
    await writeJSON(path.join(dst, "VERSION.json"), version);
    return { dst, files, version };
  } finally {
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function showEmuSourceInfo() {
  for (const root of await emuToolRoots()) {
    const dll = path.join(root, "steam_api64.dll");
    if (!(await exists(dll))) continue;
    const v = await readJSON(path.join(root, "VERSION.json")).catch(() => null);
    return { root, dll, version: v };
  }
  return null;
}
