/**
 * 安全复制文本到剪贴板，兼容 HTTP / 非安全上下文环境
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. 若支持现代 Clipboard API
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('navigator.clipboard.writeText 失败，尝试 fallback:', err);
    }
  }

  // 2. 传统 fallback 方案（document.execCommand('copy')，兼容 HTTP 和老旧浏览器）
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    textArea.style.opacity = '0';
    textArea.setAttribute('readonly', '');
    document.body.appendChild(textArea);
    textArea.select();
    textArea.setSelectionRange(0, text.length);

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    console.error('Fallback 复制失败:', err);
    return false;
  }
}
