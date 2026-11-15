import { t } from './i18n';
import { toast } from './toast';

/** 复制到剪贴板;非安全上下文(如 http 局域网)退回 execCommand */
export async function copyText(text: string, label = t('common.copied')): Promise<void> {
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
      toast(t('common.copyFailed'), 'err');
      return;
    }
  }
  toast(label);
}
