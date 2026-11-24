<script setup lang="ts" generic="T extends string | number">
// 下拉选择框:代替原生 <select>(系统弹出的菜单没法改样式)。
// 菜单挂到 body 上按触发按钮定位,所以在弹窗(有滚动、有裁剪)里也不会被截掉。
// 键盘:上下 / Home / End 移动,回车或空格选中,Esc / Tab 关闭,直接打字跳到对应项。
// searchable:选项多(超过 8 个)时菜单顶上有搜索框,按名字过滤;在搜索框里上下移动、回车选中(同 MultiSelect)。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { t } from '../i18n';
import { menuPlace } from './menuPlace';

export interface SelectOption<V> {
  value: V;
  label: string;
  disabled?: boolean;
}

// 根节点有两个(按钮 + 挂到 body 的菜单),外面传的 class 等属性交给按钮
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  modelValue: T;
  options: SelectOption<T>[];
  ariaLabel?: string;
  /** 小号、无边框:放在顶栏这类地方 */
  quiet?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

const open = ref(false);
const active = ref(-1);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const place = ref<Record<string, string>>({});
const listId = `sel-${Math.random().toString(36).slice(2, 9)}`;

const current = computed(() => props.options.find((o) => o.value === props.modelValue));

const search = ref<HTMLInputElement | null>(null);
const q = ref('');
const withSearch = computed(() => props.searchable && props.options.length > 8);
/** 搜索后还显示的选项在 options 里的下标 */
const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  return props.options.map((_, i) => i).filter((i) => !k || props.options[i].label.toLowerCase().includes(k));
});
// 输了字:高亮第一个匹配的,回车就选它(收起时清空搜索不算)
watch(q, () => {
  if (open.value) active.value = shown.value.find((i) => !props.options[i].disabled) ?? -1;
});

function position(): void {
  if (trigger.value) place.value = menuPlace(trigger.value, menu.value);
}

function scrollActive(): void {
  menu.value?.querySelector<HTMLElement>(`[data-i="${active.value}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** 在显示中的选项之间移动;from 是在这个列表里的位置 */
function move(step: 1 | -1, from = shown.value.indexOf(active.value)): void {
  const list = shown.value;
  for (let k = from + step; k >= 0 && k < list.length; k += step) {
    if (!props.options[list[k]].disabled) {
      active.value = list[k];
      void nextTick(scrollActive);
      return;
    }
  }
}

async function show(): Promise<void> {
  if (open.value) return;
  open.value = true;
  active.value = props.options.findIndex((o) => o.value === props.modelValue);
  position();
  await nextTick();
  position();
  scrollActive();
  // 触屏上不自动弹键盘(会挡住选项),点搜索框再输
  if (withSearch.value && window.matchMedia('(pointer: fine)').matches) search.value?.focus();
}

function hide(focus = false): void {
  if (!open.value) return;
  open.value = false;
  q.value = '';
  if (focus) trigger.value?.focus();
}

function pick(i: number): void {
  const o = props.options[i];
  if (!o || o.disabled) return;
  if (o.value !== props.modelValue) emit('update:modelValue', o.value);
  hide(true);
}

let typed = '';
let typedAt = 0;
function typeahead(ch: string): void {
  const now = Date.now();
  typed = now - typedAt > 700 ? ch : typed + ch;
  typedAt = now;
  const q = typed.toLowerCase();
  const i = props.options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(q));
  if (i < 0) return;
  if (open.value) {
    active.value = i;
    void nextTick(scrollActive);
  } else if (props.options[i].value !== props.modelValue) emit('update:modelValue', props.options[i].value);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open.value) return void show();
    if (active.value < 0 && e.key === 'ArrowUp') move(-1, shown.value.length);
    else move(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Home' || e.key === 'End') {
    if (!open.value) return;
    e.preventDefault();
    if (e.key === 'Home') move(1, -1);
    else move(-1, shown.value.length);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (open.value) pick(active.value);
    else void show();
  } else if (e.key === 'Escape') {
    if (!open.value) return;
    // 在弹窗里:只关菜单,不把弹窗也关掉
    e.preventDefault();
    e.stopPropagation();
    hide(true);
  } else if (e.key === 'Tab') {
    hide();
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    typeahead(e.key);
  }
}

/** 搜索框里:空格、Home / End 照常输字移光标,打字不跳项,其余同按钮上 */
function onSearchKey(e: KeyboardEvent): void {
  if (e.key === ' ' || e.key === 'Home' || e.key === 'End') return;
  if (e.key.length === 1) return;
  onKey(e);
}

function onDocDown(e: MouseEvent): void {
  const target = e.target as Node;
  if (trigger.value?.contains(target) || menu.value?.contains(target)) return;
  hide();
}
// 在搜索框里输字时(手机弹键盘会滚页面 / 改窗口大小)跟着挪,不收起
const typing = () => !!search.value && document.activeElement === search.value;
function onScroll(e: Event): void {
  // 菜单自己滚动不算;页面或弹窗滚了,位置就对不上了,直接收起
  if (menu.value?.contains(e.target as Node)) return;
  if (typing()) position();
  else hide();
}
const onResize = (): void => (typing() ? position() : hide());

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
    v-bind="$attrs"
    class="select"
    :class="{ quiet, open }"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="listId"
    :aria-label="ariaLabel"
    :aria-activedescendant="open && active >= 0 ? `${listId}-${active}` : undefined"
    @click="open ? hide() : show()"
    @keydown="onKey"
  >
    <span class="value">{{ current?.label ?? '' }}</span>
    <svg class="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </button>
  <Teleport to="body">
    <div v-if="open" ref="menu" class="select-menu" :class="{ quiet }" :style="place" @mousedown.prevent>
      <div v-if="withSearch" class="search">
        <input
          ref="search"
          v-model="q"
          type="search"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
          :aria-controls="listId"
          :aria-activedescendant="active >= 0 ? `${listId}-${active}` : undefined"
          autocomplete="off"
          @mousedown.stop
          @keydown="onSearchKey"
        />
      </div>
      <div :id="listId" role="listbox" :aria-label="ariaLabel">
        <div
          v-for="i in shown"
          :id="`${listId}-${i}`"
          :key="String(options[i].value)"
          class="opt"
          :class="{ active: i === active, on: options[i].value === modelValue, off: options[i].disabled }"
          role="option"
          :data-i="i"
          :aria-selected="options[i].value === modelValue"
          :aria-disabled="options[i].disabled || undefined"
          @mousemove="!options[i].disabled && (active = i)"
          @click="pick(i)"
        >
          <span class="text">{{ options[i].label }}</span>
          <svg v-if="options[i].value === modelValue" class="tick" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </div>
      </div>
      <div v-if="withSearch && !shown.length" class="none muted small">{{ t('common.noMatch') }}</div>
    </div>
  </Teleport>
</template>

<style>
/* 不加 scoped:菜单挂在 body 上 */
button.select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px 6px 10px;
  font-weight: 400;
  text-align: left;
}
button.select:hover:not(:disabled) {
  background: var(--sheet);
  border-color: color-mix(in srgb, var(--ink-soft) 45%, var(--rule));
}
button.select:focus-visible,
button.select.open {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
button.select .value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button.select .chev {
  flex: none;
  color: var(--ink-soft);
  transition: transform 0.15s;
}
button.select.open .chev {
  transform: rotate(180deg);
}
label.field > button.select {
  font-size: 14px;
  color: var(--ink);
}
button.select.quiet {
  gap: 4px;
  height: 28px;
  padding: 2px 6px 2px 8px;
  font-size: 12px;
  color: var(--ink-soft);
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
button.select.quiet:hover:not(:disabled) {
  background: transparent;
  border-color: var(--rule);
}

.select-menu {
  position: fixed;
  z-index: 200;
  overflow-y: auto;
  padding: 4px;
  font-size: 14px;
  color: var(--ink);
  background: var(--sheet);
  border: 1px solid var(--rule);
  border-radius: 10px;
  box-shadow:
    0 12px 28px rgba(16, 24, 40, 0.14),
    0 2px 6px rgba(16, 24, 40, 0.06);
  animation: select-in 0.12s ease-out;
}
.select-menu.quiet {
  font-size: 13px;
}
.select-menu .opt {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}
.select-menu .opt .text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.select-menu .opt.active {
  background: var(--hover);
}
.select-menu .opt.on {
  color: var(--patch);
  font-weight: 500;
  background: var(--accent-soft);
}
.select-menu .opt.on.active {
  background: color-mix(in srgb, var(--accent-soft) 80%, var(--accent) 20%);
}
.select-menu .opt.off {
  color: var(--ink-soft);
  opacity: 0.55;
  cursor: not-allowed;
}
.select-menu .tick {
  flex: none;
}
.select-menu .search {
  position: sticky;
  top: -4px;
  z-index: 1;
  margin: -4px -4px 4px;
  padding: 6px;
  background: var(--sheet);
  border-bottom: 1px solid var(--rule-soft);
}
.select-menu .search input {
  width: 100%;
  box-sizing: border-box;
}
.select-menu .none {
  padding: 7px 10px;
}
@keyframes select-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}
@media (prefers-color-scheme: dark) {
  .select-menu {
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
  }
}
@media (prefers-reduced-motion: reduce) {
  .select-menu {
    animation: none;
  }
  button.select .chev {
    transition: none;
  }
}
</style>
