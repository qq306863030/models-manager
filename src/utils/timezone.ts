/**
 * 中国时区时间工具
 *
 * 服务器可能运行在不同时区，日志/错误时间统一使用中国时区显示。
 * Unix 时间戳时区无关，无需转换；本模块只处理格式化输出。
 */

// 直接用本地时间（中国服务器时区即为 +08:00）
export function now(): Date { return new Date(); }

/** YYYY-MM-DD */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD HH:mm:ss */
export function formatTimestamp(d: Date): string {
  return `${formatDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** YYYY-MM-DD HH:mm:ss.SSS */
export function formatTimestampMS(d: Date): string {
  return `${formatTimestamp(d)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
