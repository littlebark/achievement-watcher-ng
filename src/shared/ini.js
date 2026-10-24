// 轻量 INI 解析/序列化 —— 替代 @xan105/ini
// 约定：所有值为字符串；section 顺序与 key 大小写保留；注释符 ; 和 #
export function parse(text) {
  const result = {};
  let section = "";
  for (let raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const end = line.indexOf("]");
      if (end > 0) section = line.slice(1, end).trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!section) {
      result[key] = value;
    } else {
      (result[section] ??= {})[key] = value;
    }
  }
  return result;
}

export function stringify(obj) {
  const out = [];
  const root = { ...obj };
  for (const [k, v] of Object.entries(root)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) out.push(`${k}=${v}`);
  }
  for (const [name, section] of Object.entries(root)) {
    if (typeof section !== "object" || section === null || Array.isArray(section)) continue;
    out.push(`[${name}]`);
    for (const [k, v] of Object.entries(section)) out.push(`${k}=${v}`);
    out.push("");
  }
  return out.join("\r\n");
}
