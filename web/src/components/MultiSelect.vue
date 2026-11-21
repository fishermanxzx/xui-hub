<script setup lang="ts" generic="T extends string | number">
// 多选下拉框:样子和 Select 一样,菜单里每项可以勾多个,第一项「全部」= 一个都不勾。
// 点选项不收起菜单;键盘:上下 / Home / End 移动,回车或空格勾选,Esc / Tab 关闭。
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
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
  position();
  await nextTick();
  position();
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

function move(step: 1 | -1, from = active.value): void {
  for (let i = from + step; i >= -1 && i < props.options.length; i += step) {
    if (i === -1 || !props.options[i].disabled) {
      active.value = i;
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
    else move(-1, props.options.length);
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
    <div v-if="open" :id="listId" ref="menu" class="select-menu" role="listbox" aria-multiselectable="true" :style="place" @mousedown.prevent>
      <div :id="`${listId}-0`" class="opt" :class="{ active: active === -1, on: !modelValue.length }" role="option" data-i="-1" :aria-selected="!modelValue.length" @mousemove="active = -1" @click="toggle(-1)">
        <span class="text">{{ allLabel }}</span>
        <svg v-if="!modelValue.length" class="tick" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </div>
      <div
        v-for="(o, i) in options"
        :id="`${listId}-${i + 1}`"
        :key="String(o.value)"
        class="opt"
        :class="{ active: i === active, on: isOn(o.value), off: o.disabled }"
        role="option"
        :data-i="i"
        :aria-selected="isOn(o.value)"
        :aria-disabled="o.disabled || undefined"
        @mousemove="!o.disabled && (active = i)"
        @click="toggle(i)"
      >
        <span class="box" aria-hidden="true">
          <svg v-if="isOn(o.value)" viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        <span class="text">{{ o.label }}</span>
      </div>
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
.select-menu .opt.on .box {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
</style>
