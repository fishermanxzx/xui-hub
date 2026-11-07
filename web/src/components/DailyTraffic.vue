<script setup lang="ts">
// 客户页的「每日流量」卡片:总计 / 按客户 / 按面板三种视图,可切成表格看每天的具体数字。
// 按客户、按面板时,近 30 天流量前 7 名各一色,其余并入「其他」;颜色按这 30 天的排名定,不随悬停或切换变。
// 可以排除一些服务器(面板)再看:被排除的面板上的流量三种视图都不算,按面板时也不列。
import { computed, onUnmounted, ref, watch } from 'vue';
import { api } from '../api';
import { fmtBytes } from '../format';
import type { ChartSeries, Customer, DailySeries, OverallDaily, Panel } from '../types';
import TrafficChart from './TrafficChart.vue';

const props = defineProps<{
  customers: Customer[];
  panels: Panel[];
  /** 全体客户的每日流量,已按 excluded 排除过 */
  overall: OverallDaily | null;
  /** 排除的面板 id */
  excluded: number[];
}>();
const emit = defineEmits<{ 'update:excluded': [ids: number[]] }>();

type By = 'customers' | 'panels';
type View = 'total' | By;
const VIEWS: { key: View; label: string }[] = [
  { key: 'total', label: '总计' },
  { key: 'customers', label: '按客户' },
  { key: 'panels', label: '按面板' },
];
const TOP = 7;

const view = ref<View>('total');
const asTable = ref(false);
const breakdown = ref<Partial<Record<By, DailySeries>>>({});
const error = ref('');

async function loadBreakdown(by: By) {
  const exclude = props.excluded;
  try {
    const data = await api.statsDailyBy(by, 30, exclude);
    // 读取期间又改了排除的服务器:这次的结果作废
    if (exclude !== props.excluded) return;
    breakdown.value = { ...breakdown.value, [by]: data };
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
watch(view, (v) => {
  if (v !== 'total' && !breakdown.value[v]) void loadBreakdown(v);
});
// 客户页每分钟刷新一次总计,正在看的拆分视图跟着刷新
watch(
  () => props.overall,
  () => {
    if (view.value !== 'total') void loadBreakdown(view.value);
  },
);

// 改了排除的服务器:已读的拆分都作废,正在看的马上重读
watch(
  () => props.excluded,
  () => {
    breakdown.value = {};
    if (view.value !== 'total') void loadBreakdown(view.value);
  },
);

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------- 排除服务器 ----------
const pickerOpen = ref(false);
const pickerRoot = ref<HTMLElement | null>(null);
const excludedSet = computed(() => new Set(props.excluded));
const panelGroups = computed(() =>
  [
    { label: '中转', list: props.panels.filter((p) => p.role === 'relay') },
    { label: '落地', list: props.panels.filter((p) => p.role === 'exit') },
  ].filter((g) => g.list.length),
);
function toggleExcluded(id: number) {
  emit('update:excluded', excludedSet.value.has(id) ? props.excluded.filter((x) => x !== id) : [...props.excluded, id]);
}
/** 标题旁的提示:排除了哪些,多了只说台数 */
const excludedNote = computed(() => {
  const names = props.panels.filter((p) => excludedSet.value.has(p.id)).map((p) => p.name);
  if (!names.length) return '';
  return names.length <= 3 ? `已排除 ${names.join('、')}` : `已排除 ${names.slice(0, 2).join('、')} 等 ${names.length} 台`;
});
// 点弹层外面或按 Esc 关掉
function onPointerDown(e: PointerEvent) {
  if (pickerRoot.value && !pickerRoot.value.contains(e.target as Node)) pickerOpen.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') pickerOpen.value = false;
}
function unlisten() {
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('keydown', onKey);
}
watch(pickerOpen, (open) => {
  if (!open) return unlisten();
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKey);
});
onUnmounted(unlisten);

interface Row {
  key: string;
  label: string;
  /** 面板的角色(中转 / 落地) */
  sub?: string;
  /** 总计里拆出来的「其中」行,表格里缩进 */
  child?: boolean;
  values: number[];
  total: number;
}

/**
 * 当前视图的全部行,按 30 天合计从大到小;按客户只有有流量的客户,按面板列出全部面板。
 * 总计:全体客户,再拆成经中转和直连落地两行
 */
const rows = computed<Row[] | null>(() => {
  if (view.value === 'total') {
    const o = props.overall;
    if (!o) return null;
    const relay = o.relay ?? o.bytes.map(() => 0);
    const direct = o.bytes.map((b, i) => Math.max(0, b - (relay[i] ?? 0)));
    return [
      { key: 'total', label: '全体客户', values: o.bytes, total: sum(o.bytes) },
      { key: 'relay', label: '经中转', child: true, values: relay, total: sum(relay) },
      { key: 'direct', label: '直连落地', child: true, values: direct, total: sum(direct) },
    ];
  }
  const data = breakdown.value[view.value];
  if (!data) return null;
  const names =
    view.value === 'customers'
      ? new Map(props.customers.map((c) => [c.id, { label: c.name, sub: undefined as string | undefined }]))
      : new Map(props.panels.map((p) => [p.id, { label: p.name, sub: p.role === 'relay' ? '中转' : '落地' }]));
  return data.series
    .map((s) => ({ key: String(s.id), label: names.get(s.id)?.label ?? `#${s.id}`, sub: names.get(s.id)?.sub, values: s.values, total: sum(s.values) }))
    .sort((a, b) => b.total - a.total);
});

const days = computed(() => (view.value === 'total' ? props.overall?.days : breakdown.value[view.value]?.days) ?? []);

/** 图表的组:总计按直连落地(下)、经中转(上)堆叠;拆分时前 7 名各一色,其余并入灰色的「其他」 */
const TOTAL_COLORS: Record<string, string> = { direct: 'var(--accent)', relay: 'var(--series-2)' };
const series = computed<ChartSeries[]>(() => {
  const list = (rows.value ?? []).filter((r) => r.total > 0);
  if (view.value === 'total') {
    return ['direct', 'relay'].flatMap((key) => {
      const r = list.find((x) => x.key === key);
      return r ? [{ key, label: r.label, values: r.values, color: TOTAL_COLORS[key] }] : [];
    });
  }
  const shown = list.length <= TOP ? list : list.slice(0, TOP);
  const rest = list.slice(shown.length);
  const out: ChartSeries[] = shown.map((r, k) => ({ key: r.key, label: r.label, values: r.values, color: `var(--series-${k + 1})` }));
  if (rest.length) {
    out.push({
      key: 'other',
      label: `其他 ${rest.length} 个`,
      values: days.value.map((_, i) => sum(rest.map((r) => r.values[i]))),
      color: 'var(--series-other)',
      rest: true,
    });
  }
  return out;
});

const notes = computed(() => (view.value === 'total' ? props.overall?.customers.map((n) => `${n} 位客户有流量`) : undefined));

// ---------- 表格 ----------
const WEEK = '日一二三四五六';
/** 列从新到旧:今天在最左边,窄屏不用横向滚动就能看到最近几天 */
const columns = computed(() =>
  days.value
    .map((day, i) => ({
      i,
      key: `day:${day}` as const,
      label: i === days.value.length - 1 ? '今天' : day.slice(5),
      title: `${day} 周${WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()]}`,
    }))
    .reverse(),
);
/** 日均不算今天(还没过完) */
const avg = (values: number[]) => (values.length > 1 ? sum(values.slice(0, -1)) / (values.length - 1) : 0);
const cell = (bytes: number) => (bytes > 0 ? fmtBytes(bytes) : '—');

// 表格排序:默认按合计从大到小;点表头按那一列排,再点反向。
// 某一天的列按日期记,过了零点「今天」变成昨天的列,排序仍跟着原来那一天。只排表格,不影响图表的配色。
type SortKey = 'name' | 'total' | 'avg' | `day:${string}`;
const sortKey = ref<SortKey>('total');
const sortAsc = ref(false);

/** 总计视图的三行(全体、经中转、直连落地)顺序固定,不排序 */
const sortable = computed(() => view.value !== 'total');
function sortBy(key: SortKey) {
  if (!sortable.value) return;
  if (sortKey.value === key) sortAsc.value = !sortAsc.value;
  else {
    sortKey.value = key;
    // 流量列默认从大到小,名称按字母顺序
    sortAsc.value = key === 'name';
  }
}
const arrow = (key: SortKey) => (sortable.value && sortKey.value === key ? (sortAsc.value ? ' ↑' : ' ↓') : '');
const ariaSort = (key: SortKey) => (sortable.value && sortKey.value === key ? (sortAsc.value ? 'ascending' : 'descending') : undefined);

const tableRows = computed<Row[]>(() => {
  const list = rows.value ?? [];
  if (!sortable.value) return list;
  const key = sortKey.value;
  const dir = sortAsc.value ? 1 : -1;
  if (key === 'name') return [...list].sort((a, b) => dir * a.label.localeCompare(b.label, 'zh-CN'));
  // 某天的列滚出 30 天窗口后找不到,按合计排
  const i = key.startsWith('day:') ? days.value.indexOf(key.slice(4)) : -1;
  const value = (r: Row) => (key === 'avg' ? avg(r.values) : i >= 0 ? r.values[i] ?? 0 : r.total);
  // 一样多的按合计从大到小
  return [...list].sort((a, b) => dir * (value(a) - value(b)) || b.total - a.total);
});

const subtitle = computed(() => ({ total: '近 30 天，全体客户', customers: '近 30 天，每位客户', panels: '近 30 天，每台面板上 client 的流量' })[view.value]);
</script>

<template>
  <div class="sheet panel">
    <header class="panel-head">
      <div class="head-title">
        <h2>每日流量</h2>
        <span class="muted small">{{ subtitle }}</span>
        <span v-if="excludedNote" class="excluded-note small">{{ excludedNote }}</span>
      </div>
      <div class="controls">
        <div class="seg" role="radiogroup" aria-label="视图">
          <button
            v-for="v in VIEWS"
            :key="v.key"
            type="button"
            role="radio"
            :aria-checked="view === v.key"
            :class="{ on: view === v.key }"
            @click="view = v.key"
          >
            {{ v.label }}
          </button>
        </div>
        <button type="button" class="seg-btn" :aria-pressed="asTable" :class="{ on: asTable }" @click="asTable = !asTable">表格</button>
        <div ref="pickerRoot" class="picker">
          <button
            type="button"
            class="seg-btn"
            :class="{ on: excluded.length }"
            aria-haspopup="dialog"
            :aria-expanded="pickerOpen"
            @click="pickerOpen = !pickerOpen"
          >
            {{ excluded.length ? `已排除 ${excluded.length} 台` : '排除服务器' }}
          </button>
          <div v-if="pickerOpen" class="picker-pop" role="dialog" aria-label="排除服务器">
            <p class="muted small picker-hint">勾选的服务器不算进流量统计，上方「近 30 天流量」也一样。只记在这台浏览器上。</p>
            <div v-for="g in panelGroups" :key="g.label" class="picker-group">
              <div class="picker-head small muted">{{ g.label }}</div>
              <label v-for="p in g.list" :key="p.id" class="picker-item small">
                <input type="checkbox" :checked="excludedSet.has(p.id)" @change="toggleExcluded(p.id)" />
                <span>{{ p.name }}</span>
              </label>
            </div>
            <div class="picker-foot">
              <button type="button" class="link small" :disabled="!excluded.length" @click="emit('update:excluded', [])">全部恢复</button>
              <button type="button" class="link small" @click="pickerOpen = false">完成</button>
            </div>
          </div>
        </div>
      </div>
    </header>
    <div class="panel-body">
      <div v-if="error && view !== 'total'" class="notice small">
        读取失败：{{ error }}
        <button class="link" @click="loadBreakdown(view as By)">重试</button>
      </div>
      <div v-else-if="!rows" class="chart-placeholder muted small">读取中…</div>
      <template v-else-if="!asTable">
        <TrafficChart :days="days" :series="series" :notes="notes" />
        <p v-if="view === 'panels'" class="hint muted small">中转机收一份转一份，机器实际进出约为这里的 2 倍；从中转转到落地的流量不算在落地上。</p>
      </template>
      <div v-else class="table-wrap">
        <table class="daily">
          <thead>
            <tr>
              <th v-if="view === 'total'" class="sticky"></th>
              <th v-else class="sticky sortable" :aria-sort="ariaSort('name')" @click="sortBy('name')">
                {{ view === 'panels' ? '面板' : '客户' }}{{ arrow('name') }}
              </th>
              <th class="num" :class="{ sortable }" :aria-sort="ariaSort('total')" @click="sortBy('total')">合计{{ arrow('total') }}</th>
              <th class="num" :class="{ sortable }" title="不含今天" :aria-sort="ariaSort('avg')" @click="sortBy('avg')">日均{{ arrow('avg') }}</th>
              <th
                v-for="c in columns"
                :key="c.i"
                class="num"
                :class="{ sortable }"
                :title="c.title"
                :aria-sort="ariaSort(c.key)"
                @click="sortBy(c.key)"
              >
                {{ c.label }}{{ arrow(c.key) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in tableRows" :key="r.key">
              <td class="sticky name" :class="{ child: r.child }">
                {{ r.label }}<span v-if="r.sub" class="role muted small">{{ r.sub }}</span>
              </td>
              <td class="num strong">{{ cell(r.total) }}</td>
              <td class="num">{{ cell(avg(r.values)) }}</td>
              <td v-for="c in columns" :key="c.i" class="num" :class="{ muted: !r.values[c.i] }">{{ cell(r.values[c.i]) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!rows.length" class="empty muted small">近 30 天没有流量记录</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 14px 18px 0;
}
.head-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}
.excluded-note {
  color: var(--accent-strong);
}
.head-title h2 {
  font-size: 15px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.picker {
  position: relative;
}
.picker-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  width: 240px;
  max-width: calc(100vw - 32px);
  max-height: 380px;
  overflow: auto;
  padding: 10px 12px;
  background: var(--sheet);
  border: 1px solid var(--rule);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.14);
}
.picker-hint {
  margin: 0 0 8px;
}
.picker-group + .picker-group {
  margin-top: 8px;
}
.picker-head {
  margin-bottom: 2px;
}
.picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  cursor: pointer;
}
.picker-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--rule);
}
.seg {
  display: flex;
}
.seg button,
.seg-btn {
  padding: 3px 10px;
  font-size: 12px;
}
.seg button:not(:first-child) {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  margin-left: -1px;
}
.seg button:not(:last-child) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.seg button.on,
.seg-btn.on {
  position: relative;
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}
.panel-body {
  padding: 8px 12px 10px;
}
.chart-placeholder {
  height: 252px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.hint {
  margin: 6px 0 0 56px;
}
.notice {
  margin: 8px 6px;
}
.table-wrap {
  max-height: 360px;
  overflow: auto;
}
.daily th,
.daily td {
  padding: 7px 12px;
}
.daily thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--sheet);
}
/* 横向滚动时名称固定在左边 */
.daily .sticky {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--sheet);
}
.daily thead .sticky {
  z-index: 3;
}
.daily th {
  white-space: nowrap;
}
th.sortable {
  cursor: pointer;
  user-select: none;
}
th.sortable:hover,
th[aria-sort] {
  color: var(--ink);
}
.name {
  font-weight: 500;
  white-space: nowrap;
}
.name.child {
  padding-left: 28px;
  font-weight: 400;
  color: var(--ink-soft);
}
.role {
  margin-left: 6px;
  font-weight: 400;
}
.strong {
  font-weight: 500;
}
.empty {
  padding: 24px;
  text-align: center;
}
</style>
