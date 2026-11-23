<script setup lang="ts" generic="T extends string | number">
// 多选下拉框:样子和 Select 一样,菜单里每项可以勾多个,第一项「全部」= 一个都不勾。
// 点选项不收起菜单;键盘:上下 / Home / End 移动,回车或空格勾选,Esc / Tab 关闭。
// searchable:选项多(超过 8 个)时菜单顶上有搜索框,按名字过滤;在搜索框里上下移动、回车勾选。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { t } from '../i18n';
import { menuPlace } from './menuPlace';
import type { SelectOption } from './Select.vue';

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  modelValue: T[];
  options: SelectOption<T>[];
  /** 按钮上显示的字(选了哪些由外面拼) */
  label: string;
  /** 菜单第一项:清空 = 全部 */
  allLabel: string;
  ariaLabel?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: T[]] }>();

const open = ref(false);
/** -1 = 「全部」那项,0.. = options */
const active = ref(-1);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const place = ref<Record<string, string>>({});
const listId = `msel-${Math.random().toString(36).slice(2, 9)}`;

const isOn = (v: T) => props.modelValue.includes(v);

const search = ref<HTMLInputElement | null>(null);
const q = ref('');
const withSearch = computed(() => props.searchable && props.options.length > 8);
/** 搜索后还显示的选项在 options 里的下标 */
const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  return props.options.map((_, i) => i).filter((i) => !k || props.options[i].label.toLowerCase().includes(k));
});
// 输了字:高亮第一个匹配的,回车就勾它;清空了回到「全部」
watch(q, (v) => {
  active.value = v.trim() ? (shown.value.find((i) => !props.options[i].disabled) ?? -1) : -1;
});

function position(): void {
  if (trigger.value) place.value = menuPlace(trigger.value, menu.value);
}
function scrollActive(): void {
  menu.value?.querySelector<HTMLElement>(`[data-i="${active.value}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function show(): Promise<void> {
  if (open.value) return;
  open.value = true;
  active.value = -1;
  q.value = '';
  position();
  await nextTick();
  position();
  // 触屏上不自动弹键盘(会挡住选项),点搜索框再输
  if (withSearch.value && window.matchMedia('(pointer: fine)').matches) search.value?.focus();
}
function hide(focus = false): void {
  if (!open.value) return;
  open.value = false;
  if (focus) trigger.value?.focus();
}

function toggle(i: number): void {
  if (i < 0) return void (props.modelValue.length && emit('update:modelValue', []));
  const o = props.options[i];
  if (!o || o.disabled) return;
  // 按菜单里的顺序存,按钮上的名字顺序就稳定
  const next = isOn(o.value) ? props.modelValue.filter((v) => v !== o.value) : props.options.filter((x) => x.value === o.value || isOn(x.value)).map((x) => x.value);
  emit('update:modelValue', next);
}

/** 在「全部」+ 显示中的选项之间移动;from 是在这个列表里的位置(-1 = 「全部」) */
function move(step: 1 | -1, from = shown.value.indexOf(active.value)): void {
  const list = shown.value;
  for (let k = from + step; k >= -1 && k < list.length; k += step) {
    if (k === -1 || !props.options[list[k]].disabled) {
      active.value = k === -1 ? -1 : list[k];
      void nextTick(scrollActive);
      return;
    }
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open.value) return void show();
    move(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Home' || e.key === 'End') {
    if (!open.value) return;
    e.preventDefault();
    if (e.key === 'Home') move(1, -2);
    else move(-1, shown.value.length);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (open.value) toggle(active.value);
    else void show();
  } else if (e.key === 'Escape') {
    if (!open.value) return;
    e.preventDefault();
    e.stopPropagation();
    hide(true);
  } else if (e.key === 'Tab') {
    hide();
  }
}
/** 搜索框里:空格、Home / End 照常输字移光标,其余同按钮上 */
function onSearchKey(e: KeyboardEvent): void {
  if (e.key === ' ' || e.key === 'Home' || e.key === 'End') return;
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
    :class="{ open, picked: modelValue.length }"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="listId"
    :aria-label="ariaLabel"
    :aria-activedescendant="open ? `${listId}-${active + 1}` : undefined"
    @click="open ? hide() : show()"
    @keydown="onKey"
  >
    <span class="value">{{ label }}</span>
    <svg class="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </button>
  <Teleport to="body">
    <div v-if="open" ref="menu" class="select-menu" :style="place" @mousedown.prevent>
      <div v-if="withSearch" class="search">
        <input
          ref="search"
          v-model="q"
          type="search"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
          :aria-controls="listId"
          :aria-activedescendant="`${listId}-${active + 1}`"
          autocomplete="off"
          @mousedown.stop
          @keydown="onSearchKey"
        />
      </div>
      <div :id="listId" role="listbox" aria-multiselectable="true" :aria-label="ariaLabel">
        <div :id="`${listId}-0`" class="opt" :class="{ active: active === -1, on: !modelValue.length }" role="option" data-i="-1" :aria-selected="!modelValue.length" @mousemove="active = -1" @click="toggle(-1)">
          <span class="text">{{ allLabel }}</span>
          <svg v-if="!modelValue.length" class="tick" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </div>
        <div
          v-for="i in shown"
          :id="`${listId}-${i + 1}`"
          :key="String(options[i].value)"
          class="opt"
          :class="{ active: i === active, on: isOn(options[i].value), off: options[i].disabled }"
          role="option"
          :data-i="i"
          :aria-selected="isOn(options[i].value)"
          :aria-disabled="options[i].disabled || undefined"
          @mousemove="!options[i].disabled && (active = i)"
          @click="toggle(i)"
        >
          <span class="box" aria-hidden="true">
            <svg v-if="isOn(options[i].value)" viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </span>
          <span class="text">{{ options[i].label }}</span>
        </div>
      </div>
      <div v-if="withSearch && !shown.length" class="none muted small">{{ t('common.noMatch') }}</div>
    </div>
  </Teleport>
</template>

<style>
/* 不加 scoped:菜单挂在 body 上;其余样式和 Select 共用 */
button.select.picked {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--rule));
}
.select-menu .opt .box {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--rule);
  border-radius: 4px;
  background: var(--sheet);
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
.select-menu .opt.on .box {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
</style>
