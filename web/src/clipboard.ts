import { toast } from './toast';

/** 复制到剪贴板;非安全上下文(如 http 局域网)退回 execCommand */
export async function copyText(text: string, label = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) {
      toast('复制失败,请手动复制', 'err');
      return;
    }
  }
  toast(label);
}
