// 日志：console + 可选文件
import fsp from "node:fs/promises";
import path from "node:path";

let logFile = null;
export function setLogFile(p) {
  logFile = p;
  fsp.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
}

function stamp() {
  return new Date().toISOString();
}

async function write(line) {
  if (!logFile) return;
  try { await fsp.appendFile(logFile, line + "\n", "utf8"); } catch { /* ignore */ }
}

export const log = {
  info: (...a) => { const l = `[${stamp()}] INFO ${a.join(" ")}`; console.log(l); return write(l); },
  warn: (...a) => { const l = `[${stamp()}] WARN ${a.join(" ")}`; console.warn(l); return write(l); },
  error: (...a) => { const l = `[${stamp()}] ERROR ${a.join(" ")}`; console.error(l); return write(l); },
};
