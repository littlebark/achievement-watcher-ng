// aw2 桌面版主进程：内置 watchdog + 自绘成就弹窗（overlay）
// 架构：主进程跑原有 watchdog（纯 Node 代码原样复用）→ WS 广播 → 本窗口渲染 Xbox 风格卡片
import { app, BrowserWindow, ipcMain, shell, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startWatchdog } from "../src/watchdog/watchdog.js";
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
  win.loadFile("overlay.html");
  win.showInactive(); // 不抢焦点：游戏全屏时弹卡片不切屏
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
            const snd = resolveSound(cfg?.sound?.normal);
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

app.whenReady().then(async () => {
  setLogFile(path.join(dataRoot(), "logs", "aw2-desktop.log"));
  log.info("[OVERLAY] 桌面版启动");

  globalThis.__aw2cfg = await loadConfig();
  createOverlayWindow();

  // 空白区域鼠标穿透：卡片上可点击，卡片外事件落到下层（游戏/桌面）
  ipcMain.on("aw2:set-ignore", (_e, ignore) => {
    win?.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.handle("aw2:openPanel", () => {
    const port = globalThis.__aw2cfg?.ui?.port || 5179;
    return shell.openExternal(`http://127.0.0.1:${port}`);
  });

  await startWatchdog(); // 现有 watchdog 原样运行（含单实例锁、目录监视、60s 重扫）
  connectBroadcast();
});

// 所有窗口关闭也不退出（overlay 窗口只是隐藏/常驻）
app.on("window-all-closed", (e) => { /* keep running */ });
