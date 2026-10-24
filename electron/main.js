// aw2 桌面版主进程：内置 watchdog + 自绘成就弹窗（overlay）
// 架构：主进程跑原有 watchdog（纯 Node 代码原样复用）→ WS 广播 → 本窗口渲染 Xbox 风格卡片
import { app, BrowserWindow, ipcMain, shell, screen, Tray, Menu, dialog, net } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startWatchdog } from "../src/watchdog/watchdog.js";
import { startUI } from "../src/server.js";
import { loadConfig, resolveSound } from "../src/core/config.js";
import { log, setLogFile } from "../src/shared/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 本应用的成就通知走自绘弹窗；cfg.notify.mode 显式配置时以配置为准
process.env.AW2_NOTIFY_MODE = "overlay";

// 弹窗是纯 2D 卡片，禁用硬件加速：规避 GPU 驱动异常/独占全屏下的兼容问题
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "overlay.html"));
  win.showInactive(); // 不抢焦点：游戏全屏时弹卡片不切屏

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

// 样式预览：连发 5 张不同样式的测试卡片，按顺序队列自动逐个播放（每张 5 秒）
function previewStyles() {
  log.info(`[OVERLAY] 样式预览点击：win存在=${!!win}, 已销毁=${win?.isDestroyed?.()}, 加载完成=${win?.webContents?.isLoading?.() === false}`);
  if (!win || win.isDestroyed()) return;
  const base = {
    appID: 480,
    game: "样式预览 · 成就查看工具",
    description: "这一条用来对比不同通知样式，卡片会在几秒后自动收起。",
  };
  const variants = [
    { style: "classic", displayName: "① 经典深色（旧默认）" },
    { style: "glass", displayName: "② 毛玻璃" },
    { style: "light", displayName: "③ 浅色卡片" },
    { style: "steam", displayName: "④ Steam 蓝调（当前默认）" },
    { style: "minimal", displayName: "⑤ 极简单行" },
    { style: "xbox", displayName: "⑥ Xbox 风格" },
  ];
  for (const v of variants) win.webContents.send("aw2:achievement", { ...base, ...v });
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
  // portable exe 的 execPath 在临时解压目录，注册自启必须用用户手里的真实 exe 路径
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, path.basename(process.execPath));
  }
  return process.execPath;
}

function createTray() {
  tray = new Tray(path.join(__dirname, "tray.png"));
  tray.setToolTip("成就查看工具（点击打开面板）");
  tray.on("click", openPanel);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开面板", click: () => openPanel() },
    { label: "预览通知样式（5 种）", click: () => previewStyles() },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings({ path: exePathForAutostart() }).openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: exePathForAutostart() }),
    },
    { type: "separator" },
    { label: "退出", click: () => { tray?.destroy(); app.quit(); } },
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
  connectBroadcast();
});

// 所有窗口关闭也不退出（overlay 窗口只是隐藏/常驻）
app.on("window-all-closed", (e) => { /* keep running */ });
