import { reactive } from 'vue';

export const toasts = reactive<{ id: number; text: string; kind: 'ok' | 'err' }[]>([]);
let seq = 0;

export function toast(text: string, kind: 'ok' | 'err' = 'ok'): void {
  const id = ++seq;
  toasts.push({ id, text, kind });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, kind === 'err' ? 6000 : 3000);
}

export function toastError(e: unknown): void {
  toast(e instanceof Error ? e.message : String(e), 'err');
}
