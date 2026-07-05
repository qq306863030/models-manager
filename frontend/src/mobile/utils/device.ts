const MOBILE_KEYWORDS = ['Android', 'iPhone', 'iPad', 'iPod', 'Mobile', 'Windows Phone', 'Symbian', 'Palm', 'webOS', 'Baidu', 'MicroMessenger', 'AlipayClient'];
const PC_KEYWORDS = ['Windows NT', 'Macintosh', 'Linux x86_64', 'X11'];

export function isMobileDevice(userAgent?: string): boolean {
  const ua = userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const hasMobileKeyword = MOBILE_KEYWORDS.some(keyword => ua.includes(keyword));
  const hasPcKeyword = PC_KEYWORDS.some(keyword => ua.includes(keyword));
  const screenWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
  if (hasPcKeyword && !hasMobileKeyword) return false;
  return hasMobileKeyword || (screenWidth > 0 && screenWidth < 768);
}
