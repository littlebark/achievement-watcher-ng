// 统一的 HTTP 出口：
// - 桌面版（Electron 主进程）在启动时注入 net.fetch（globalThis.__aw2fetch）
//   → 走 Chromium 网络栈，自动遵循系统代理设置（Clash 等无需额外配置）
// - CLI / Node 环境回落 Node 原生 fetch（直连）
export function httpFetch(...args) {
  return (globalThis.__aw2fetch || fetch)(...args);
}
