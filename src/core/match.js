// 本地成就条目 × Steam schema 匹配（移植原版 crc32/大小写不敏感匹配）
import { crc32hex } from "../shared/crc32.js";

// schemaList: Steam schema.achievement.list
// localEntries: 统一模型数组（可能带 crc 字段，如 SSE）
// 返回: [{ schemaAchievement, local }]
export function matchAchievements(schemaList, localEntries) {
  const pairs = [];
  for (const local of localEntries) {
    let found = null;
    for (const ach of schemaList) {
      if (local.crc) {
        if (local.crc.includes(crc32hex(Buffer.from(ach.name)))) { found = ach; break; }
      } else {
        const apiName = local.name;
        if (ach.name === apiName || String(ach.name).toUpperCase() === String(apiName).toUpperCase()) { found = ach; break; }
      }
    }
    if (found) {
      const { crc, ...rest } = local;
      pairs.push({ schemaAchievement: found, local: rest });
    }
    // 匹配不上：成就可能已被官方删除/改名，跳过（与原版一致）
  }
  return pairs;
}
