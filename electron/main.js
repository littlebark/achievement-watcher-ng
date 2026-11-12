// aw2 桌面版主进程：内置 watchdog + 自绘成就弹窗（overlay）
// 架构：主进程跑原有 watchdog（纯 Node 代码原样复用）→ WS 广播 → 本窗口渲染 Xbox 风格卡片
import { app, BrowserWindow, ipcMain, shell, screen, Tray, Menu, dialog, net } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startWatchdog } from "../src/watchdog/watchdog.js";
import { startUI } from "../src/server.js";
import { loadConfig, resolveSound } from "../src/core/config.js";
import { log, setLogFile } from "../src/shared/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 本应用的成就通知走自绘弹窗；cfg.notify.mode 显式配置时以配置为准
process.env.AW2_NOTIFY_MODE = "overlay";

// 透明置顶窗口要靠 GPU 合成出帧：禁掉硬件加速后，透明窗口的首帧很容易整块
// 是透明的（表现就是「只有声音、没有卡片」）。默认走 GPU；只有个别驱动异常的
// 机器可以设 AW2_DISABLE_GPU=1 退回软件合成。
if (process.env.AW2_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// userData 隔离：默认会落到 %APPDATA%\Electron（与其他未打包应用共用），改成自己的目录
import { dataRoot } from "../src/core/schema.js";

// 打包版（portable exe）：数据放真实 exe 旁的 data\，绿色便携，删 exe+data 即彻底卸载
// portable 目标运行时 execPath 指向临时解压目录，PORTABLE_EXECUTABLE_DIR 才是用户手里的 exe 位置
if (app.isPackaged) {
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
  process.env.AW2_DATA_ROOT = path.join(base, "data");
}

app.setPath("userData", path.join(dataRoot(), "desktop-profile"));

// 单实例：同一桌面版只跑一份（watchdog 自身还有 data/aw2.lock 锁防节点版并行）
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let ws = null;
let wsRetry = null;
let revealSeq = 0; // 每次 reveal 自增；渲染层报"播完了"时用它防竞态（期间又来新卡片就不隐藏）

function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = Math.min(700, workArea.height - 40);

  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 8,
    y: workArea.y + workArea.height - height - 8,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口被游戏/其他窗口遮挡时，Chromium 默认会节流定时器与动画帧；
      // 弹窗恰恰要在"被遮挡"的状态下照常出帧，所以关掉。
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "overlay.html"));

  // 启动时只做一次「预热显示」：透明空窗口 show→hide 一闪，肉眼看不到，
  // 但能让 DWM/Chromium 真正建立起这个窗口的合成层，避免第一次要弹卡片时
  // 才开始建表面、首帧被吞。之后窗口常驻隐藏，每次弹卡片再 show。
  win.once("ready-to-show", () => {
    try {
      win.showInactive();
      setTimeout(() => { try { if (win && win.isVisible()) win.hide(); } catch {} }, 400);
      log.info("[OVERLAY] 预热显示完成，浮层转入隐藏待命");
    } catch (e) { log.warn(`[OVERLAY] 预热显示失败: ${e.message}`); }
  });

  // 渲染层诊断：preload/页面出错时落到日志，避免"静默黑窗"无从排查
  win.webContents.on("preload-error", (_e, p, err) =>
    log.error(`[OVERLAY] preload 出错 ${p}: ${err.message}`));
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    log.error(`[OVERLAY] 页面加载失败 ${code} ${desc} ${url}`));
  win.webContents.on("render-process-gone", (_e, details) =>
    log.error(`[OVERLAY] 渲染进程退出: ${details.reason}`));
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) log.error(`[OVERLAY][renderer] ${message}`);
  });
}

// 每次要弹卡片前，确保浮层定位在主显示器右下角、处于最高置顶、并且**真的被显示出来**。
function revealOverlay() {
  if (!win) return;
  try {
    const primary = screen.getPrimaryDisplay();
    const { workArea } = primary;
    const b = win.getBounds();
    const width = b.width || 420;
    const height = b.height || Math.min(700, workArea.height - 40);
    const x = workArea.x + workArea.width - width - 8;
    const y = workArea.y + workArea.height - height - 8;
    if (b.x !== x || b.y !== y || b.width !== width || b.height !== height) {
      win.setBounds({ width, height, x, y });
    }
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // 关键：无条件走一次显示 + 提层，而不是「isVisible() 才 show」。
    // 以前判断 isVisible() 导致这行永远是死代码（窗口从启动就一直"可见"），
    // 于是弹卡片这一步完全没有"重新显示/重绘"的触发，全靠后台窗口自己补帧，
    // 在游戏遮挡几小时后第一张卡片就会被吞。现在每张卡片都 hide→show 一轮。
    win.showInactive();
    win.moveTop();
    // 兜底再触发一次全量重绘：多显示器/部分驱动下 show 之后首帧仍可能丢
    try { win.webContents.invalidate?.(); } catch {}

    revealSeq++;
    log.info(`[OVERLAY] reveal ok vis=${win.isVisible()} monitor=${primary.id} rect=(${win.getBounds().x},${win.getBounds().y})`);
  } catch (e) {
    log.warn(`[OVERLAY] reveal 失败: ${e.message}`);
  }
}

// 连接本机 watchdog 的 WS 广播（含重连；watchdog 由 startWatchdog() 在本进程内启动）
function connectBroadcast() {
  const cfg = globalThis.__aw2cfg;
  const port = cfg?.websocket?.port || 8082;
  const url = `ws://127.0.0.1:${port}`;

  function attempt() {
    try {
      ws = new WebSocket(url);
      ws.on("open", () => log.info("[OVERLAY] 已连接广播 " + url));
      ws.on("message", (data) => {
        try {
          const payload = JSON.parse(data.toString());
          // 测试命令（cmd=test）没有音效路径，这里补上，方便在设置里试听
          if (payload.appID === 480 && !payload.soundPath) {
            const snd = resolveSound(payload.rare ? cfg?.sound?.rare : cfg?.sound?.normal);
            if (snd.kind === "wav") payload.soundPath = snd.path;
          }
          revealOverlay(); // 弹窗前先把浮层挪到光标所在屏并重新置顶，确保可见
          win?.webContents.send("aw2:achievement", payload);
        } catch { /* ignore */ }
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        ws = null;
        clearTimeout(wsRetry);
        wsRetry = setTimeout(attempt, 5000);
      });
    } catch {
      clearTimeout(wsRetry);
      wsRetry = setTimeout(attempt, 5000);
    }
  }
  attempt();
}

let tray = null;
let panelWin = null; // 面板窗口：程序自带窗口，观感与原版一致（不再丢给系统浏览器）
let uiPort = 5179;

// browser=true 强制用系统浏览器打开（托盘菜单里的备用入口）
function openPanel(browser = false) {
  const url = `http://127.0.0.1:${uiPort}`;
  if (browser) return shell.openExternal(url);
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "成就查看工具",
    autoHideMenuBar: true,
    backgroundColor: "#14161a",
    icon: path.join(__dirname, "tray.png"),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "panel-preload.js"), // 原生目录选择框
    },
  });
  panelWin.loadURL(url);
  panelWin.on("closed", () => { panelWin = null; });
}

// 托盘图标：左键打开面板，右键菜单含开机自启开关与退出（这是桌面版唯一的可见入口）
function exePathForAutostart() {
  // portable 单文件 exe：execPath 指向临时解压目录里的内部 exe（名字 = productName），
  // 直接注册它会导致重启后失效，也可能指向一个不存在的文件名。
  // PORTABLE_EXECUTABLE_FILE 是 electron-builder 注入的「用户手里那个真实 exe 的完整路径」，优先用它。
  if (process.env.PORTABLE_EXECUTABLE_FILE) return process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // 兜底：老版本 electron-builder 没有 FILE 变量时才用 DIR + 内部 exe 名
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, path.basename(process.execPath));
  }
  return process.execPath;
}

// 自启状态文件：记录"用户想不想要自启"这个意图。
// Electron 的 getLoginItemSettings 无法区分「用户关掉了」和「注册路径过期了」，
// 所以自己存一份意图，启动时据此修正路径（用户改名/移动 exe 后自启不会静默失效）。
function autostartStatePath() {
  return path.join(dataRoot(), "cfg", "autostart.json");
}
function readAutostartWanted() {
  try { return JSON.parse(fs.readFileSync(autostartStatePath(), "utf8")).enabled === true; }
  catch { return false; }
}
function writeAutostartWanted(enabled) {
  try {
    fs.mkdirSync(path.dirname(autostartStatePath()), { recursive: true });
    fs.writeFileSync(autostartStatePath(), JSON.stringify({ enabled, path: exePathForAutostart() }, null, 1));
  } catch (e) { log.warn(`[AUTOSTART] 写入状态失败: ${e.message}`); }
}
function applyAutostart(enabled) {
  const target = exePathForAutostart();
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: target });
    writeAutostartWanted(enabled);
    log.info(`[AUTOSTART] ${enabled ? "已开启" : "已关闭"}，注册路径 ${target}`);
  } catch (e) {
    log.warn(`[AUTOSTART] 设置失败: ${e.message}`);
  }
}
// 自愈：上次想要自启，但当前 exe 路径没在注册表里（改名/移动/换盘）→ 用当前路径重写一次
function healAutostartPath() {
  if (!readAutostartWanted()) return;
  const target = exePathForAutostart();
  try {
    if (!app.getLoginItemSettings({ path: target }).openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, path: target });
      writeAutostartWanted(true);
      log.info(`[AUTOSTART] 自启路径已自愈为 ${target}`);
    }
  } catch (e) { log.warn(`[AUTOSTART] 自愈失败: ${e.message}`); }
}

function createTray() {
  tray = new Tray(path.join(__dirname, "tray.png"));
  tray.setToolTip("成就查看工具（点击打开面板）");
  tray.on("click", openPanel);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开面板", click: () => openPanel() },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings({ path: exePathForAutostart() }).openAtLogin || readAutostartWanted(),
      click: (item) => applyAutostart(item.checked),
    },
    { type: "separator" },
    // 先 quit 再销毁托盘：Windows 上在菜单回调里先 destroy 可能抛异常，
    // 短路掉后面的 app.quit()，导致"图标消失但进程残留"的假退出
    { label: "退出", click: () => { try { app.quit(); } finally { try { tray?.destroy(); } catch {} } } },
  ]));
}

app.whenReady().then(async () => {
  setLogFile(path.join(dataRoot(), "logs", "aw2-desktop.log"));
  log.info("[OVERLAY] 桌面版启动");

  // HTTP 出口注入：net.fetch 走 Chromium 网络栈，自动遵循系统代理设置（Clash 等无需额外配置）
  globalThis.__aw2fetch = net.fetch.bind(net);

  globalThis.__aw2cfg = await loadConfig();
  uiPort = globalThis.__aw2cfg?.ui?.port || 5179; // 0 = 默认 5179
  createOverlayWindow();

  // 空白区域鼠标穿透：卡片上可点击，卡片外事件落到下层（游戏/桌面）
  ipcMain.on("aw2:set-ignore", (_e, ignore) => {
    win?.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  // 卡片队列播完 → 隐藏浮层，回到"隐藏待命"状态，下次弹卡片重新 show。
  // 加一点点延迟等退场动画走完；期间若又来了新卡片（revealSeq 变了）就不隐藏。
  ipcMain.on("aw2:idle", () => {
    const seqAtIdle = revealSeq;
    setTimeout(() => {
      if (seqAtIdle !== revealSeq) return;
      try {
        if (win && win.isVisible()) {
          win.hide();
          log.info("[OVERLAY] 卡片播完，浮层隐藏待命");
        }
      } catch (e) { log.warn(`[OVERLAY] 隐藏失败: ${e.message}`); }
    }, 260);
  });
  ipcMain.handle("aw2:openPanel", () => openPanel());
  // 原生目录选择（面板里"选择文件夹…"用）
  ipcMain.handle("aw2:pick-folder", async (_e, current) => {
    const r = await dialog.showOpenDialog(panelWin ?? undefined, {
      title: "选择游戏根目录（能看到 exe 或 steam_api64.dll 的那一层）",
      properties: ["openDirectory"],
      defaultPath: current || undefined,
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  await startWatchdog(); // 现有 watchdog 原样运行（含单实例锁、目录监视、60s 重扫）
  setLogFile(path.join(dataRoot(), "logs", "aw2-desktop.log")); // startWatchdog 内部把日志切到了 watchdog.log，切回桌面版自己的

  // 内置网页面板：配置界面随桌面版常驻（不自动弹浏览器，从托盘/卡片进入）
  startUI(uiPort, {
    autoOpen: false,
    onBusy: (p) => log.warn(`[UI] 端口 ${p} 被占用，跳过内置面板（可能已有面板实例在运行）`),
  });

  createTray();
  healAutostartPath(); // 上次要过自启但 exe 改过名/位置 → 用当前路径重写注册表，避免开机静默不启动
  connectBroadcast();
});

// 所有窗口关闭也不退出（overlay 窗口只是隐藏/常驻）
app.on("window-all-closed", (e) => { /* keep running */ });

// 退出链路日志：排查"点退出后进程是否真正归零"
app.on("before-quit", () => log.info("[QUIT] before-quit：开始退出流程"));
app.on("will-quit", () => {
  log.info("[QUIT] will-quit：窗口已全部关闭，即将结束主进程");
  try { tray?.destroy(); } catch {}
});
app.on("quit", (_e, code) => log.info(`[QUIT] quit：主进程退出，exitCode=${code}`));
