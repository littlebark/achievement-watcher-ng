// WebSocket 广播服务（供 OBS overlay / 其他客户端订阅）
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { log } from "../../shared/log.js";

let wss = null;

export function startWebSocket({ port = 8082, auth = null } = {}) {
  const server = createServer();
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (auth) {
      const login = Buffer.from((req.headers.authorization || "").split(" ")[1] || "", "base64").toString();
      if (login !== auth) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit("connection", client, req);
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(`[WS] 端口 ${port} 被占用，WebSocket 广播不可用。可在 %APPDATA%\\Achievement Watcher\\aw2.json 中修改 websocket.port`);
    } else {
      log.error(`[WS] ${err.message}`);
    }
  });
  server.listen(port, () => log.info(`[WS] listening on :${port}`));

  wss.on("connection", (client, req) => {
    log.info(`[WS] client connected ${req.socket.remoteAddress}`);
    client.isAlive = true;
    client.on("pong", () => { client.isAlive = true; });
    client.on("message", (data) => {
      try {
        const req = JSON.parse(data.toString());
        if (req.cmd === "test") {
          client.send(JSON.stringify(testPayload()));
        }
      } catch { /* ignore */ }
    });
  });

  // 心跳
  setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      if (!client.isAlive) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping(() => {});
    }
  }, 30000);
}

export function broadcast(message) {
  if (!wss || wss.clients.size === 0) return;
  const json = JSON.stringify(message);
  for (const client of wss.clients) {
    try { client.send(json); } catch (e) { log.error(`[WS] send: ${e.message}`); }
  }
}

export function testPayload() {
  return {
    appID: 480,
    game: "Spacewar",
    achievement: "ACH_WIN_ONE_GAME",
    displayName: "Winner",
    description: "Win one game.",
    icon: "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/480/winner.jpg",
    time: Date.now(),
  };
}
