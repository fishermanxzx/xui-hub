// 下拉菜单的位置:菜单挂在 body 上(position: fixed),按触发按钮摆;下面放不下就往上翻。
// Select 和 MultiSelect 共用。

export function menuPlace(trigger: HTMLElement, menu: HTMLElement | null): Record<string, string> {
  const r = trigger.getBoundingClientRect();
  const gap = 4;
  const edge = 8;
  const below = window.innerHeight - r.bottom - gap - edge;
  const above = r.top - gap - edge;
  const wanted = Math.min(320, menu?.scrollHeight ?? 320);
  const up = below < Math.min(wanted, 160) && above > below;
  const style: Record<string, string> = {
    minWidth: `${r.width}px`,
    maxWidth: `${Math.min(440, window.innerWidth - edge * 2)}px`,
    maxHeight: `${Math.max(120, Math.min(320, up ? above : below))}px`,
  };
  if (up) style.bottom = `${window.innerHeight - r.top + gap}px`;
  else style.top = `${r.bottom + gap}px`;
  // 靠右的触发按钮(顶栏)让菜单右对齐,免得伸出屏幕
  if (r.left + 200 > window.innerWidth) style.right = `${Math.max(edge, window.innerWidth - r.right)}px`;
  else style.left = `${Math.max(edge, r.left)}px`;
  return style;
}
