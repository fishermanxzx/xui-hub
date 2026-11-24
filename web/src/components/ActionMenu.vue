<script setup lang="ts">
// 「⋯」更多操作菜单:不常用的操作收在这里,行里只留常用的。
// 菜单挂到 body 上,右边和按钮对齐(按钮一般在行尾);下面放不下就往上翻。
// 键盘:回车 / 空格 / 下键打开,上下 / Home / End 移动,回车选中,Esc / Tab 关闭。
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { t } from '../i18n';

export interface MenuItem {
  label: string;
  run: () => unknown;
  disabled?: boolean;
  danger?: boolean;
  /** 悬停提示 */
  title?: string;
  /** 在这一项上面画一条分隔线 */
  divide?: boolean;
}

const props = defineProps<{ items: MenuItem[]; ariaLabel?: string }>();

const open = ref(false);
const active = ref(-1);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const place = ref<Record<string, string>>({});
const menuId = `am-${Math.random().toString(36).slice(2, 9)}`;

function position(): void {
  const el = trigger.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const gap = 4;
  const edge = 8;
  const h = menu.value?.offsetHeight ?? 240;
  const up = window.innerHeight - r.bottom - gap - edge < h && r.top > window.innerHeight - r.bottom;
  const style: Record<string, string> = { right: `${Math.max(edge, window.innerWidth - r.right)}px` };
  if (up) style.bottom = `${window.innerHeight - r.top + gap}px`;
  else style.top = `${r.bottom + gap}px`;
  place.value = style;
}

function focusItem(i: number): void {
  active.value = i;
  menu.value?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.focus();
}

function move(from: number, step: 1 | -1): void {
  const n = props.items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    if (!props.items[i].disabled) return focusItem(i);
  }
}

async function show(focusFirst = false): Promise<void> {
  if (open.value) return;
  open.value = true;
  active.value = -1;
  position();
  await nextTick();
  position();
  if (focusFirst) move(-1, 1);
}

function hide(focus = false): void {
  if (!open.value) return;
  open.value = false;
  if (focus) trigger.value?.focus();
}

function pick(i: number): void {
  const item = props.items[i];
  if (!item || item.disabled) return;
  hide(true);
  void item.run();
}

function onTriggerKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    // 用鼠标点开的、焦点还在按钮上:下键进到菜单里
    if (open.value) move(active.value, 1);
    else void show(true);
  } else if (e.key === 'Escape' && open.value) {
    e.preventDefault();
    e.stopPropagation();
    hide(true);
  } else if (e.key === 'Tab') {
    hide();
  }
}

function onMenuKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    move(active.value, e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    move(e.key === 'Home' ? -1 : props.items.length, e.key === 'Home' ? 1 : -1);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pick(active.value);
  } else if (e.key === 'Escape') {
    // 在弹窗里:只关菜单
    e.preventDefault();
    e.stopPropagation();
    hide(true);
  } else if (e.key === 'Tab') {
    hide(true);
  }
}

function onDocDown(e: MouseEvent): void {
  const target = e.target as Node;
  if (trigger.value?.contains(target) || menu.value?.contains(target)) return;
  hide();
}
function onScroll(e: Event): void {
  if (menu.value?.contains(e.target as Node)) return;
  hide();
}
const onResize = (): void => hide();

function listen(on: boolean): void {
  const fn = on ? 'addEventListener' : 'removeEventListener';
  document[fn]('mousedown', onDocDown as EventListener, true);
  window[fn]('scroll', onScroll, true);
  window[fn]('resize', onResize);
}
watch(open, (v) => listen(v));
onBeforeUnmount(() => listen(false));
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="more"
    :class="{ open }"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-controls="open ? menuId : undefined"
    :aria-label="ariaLabel ?? t('common.more')"
    :title="ariaLabel ?? t('common.more')"
    @click="open ? hide() : show()"
    @keydown="onTriggerKey"
  >
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
  </button>
  <Teleport to="body">
    <div v-if="open" :id="menuId" ref="menu" class="action-menu" role="menu" :style="place" @keydown="onMenuKey">
      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.divide" class="sep" role="separator" />
        <button
          type="button"
          class="item"
          :class="{ danger: item.danger, active: i === active }"
          role="menuitem"
          :data-i="i"
          :disabled="item.disabled"
          :title="item.title"
          tabindex="-1"
          @mousemove="!item.disabled && (active = i)"
          @click="pick(i)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style>
/* 不加 scoped:菜单挂在 body 上 */
button.more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--ink-soft);
  fill: currentColor;
  flex: none;
}
button.more:hover:not(:disabled),
button.more.open {
  background: var(--hover);
  border-color: var(--rule);
  color: var(--ink);
}
.action-menu {
  position: fixed;
  z-index: 200;
  min-width: 168px;
  max-width: min(320px, calc(100vw - 16px));
  padding: 4px;
  background: var(--sheet);
  border: 1px solid var(--rule);
  border-radius: 9px;
  box-shadow: var(--lift);
  animation: action-menu-in 0.12s ease-out;
}
.action-menu .item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: none;
  font-size: 13px;
  font-weight: 400;
  text-align: left;
  color: var(--ink);
  white-space: nowrap;
}
.action-menu .item:hover:not(:disabled),
.action-menu .item.active:not(:disabled) {
  background: var(--hover);
  border-color: transparent;
}
.action-menu .item:focus-visible {
  outline: none;
  background: var(--hover);
}
.action-menu .item.danger {
  color: var(--fault);
}
.action-menu .sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--rule-soft);
}
@keyframes action-menu-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}
</style>
