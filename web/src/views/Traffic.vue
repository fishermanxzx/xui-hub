<script setup lang="ts">
import { locale, t } from '../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import MultiSelect from '../components/MultiSelect.vue';
import type { SelectOption } from '../components/Select.vue';
import { fmtBytes } from '../format';
import { toastError } from '../toast';
import type { Panel, TrafficBy, TrafficReport, TrafficRow } from '../types';

const RANGES = [1, 7, 30, 90];
const rangeLabel = (n: number) => (n === 1 ? t('traffic.today') : t('traffic.days', { n }));

const by = ref<TrafficBy>('customer');
const days = ref(30);
/** 展开看的那一位客户 / 那一块面板 */
const focus = ref<{ id: number; name: string } | null>(null);
const report = ref<TrafficReport | null>(null);
const loading = ref(false);
let seq = 0;

// ---------- 统计时排除的面板:只是算的时候不算它们上面的流量,记录不动;排除哪些记在浏览器里 ----------
const EXCLUDE_KEY = 'xui-hub.trafficExclude';
const exclude = ref<number[]>([]);
try {
  const saved = JSON.parse(localStorage.getItem(EXCLUDE_KEY) ?? '[]');
  if (Array.isArray(saved)) exclude.value = saved.filter((x) => Number.isInteger(x) && x > 0);
} catch {
  /* 忽略坏数据 */
}
const panels = ref<Panel[]>([]);
onMounted(async () => {
  try {
    panels.value = await api.panels();
  } catch (e) {
    toastError(e);
  }
});
const panelName = (id: number) => panels.value.find((p) => p.id === id)?.name ?? t('traffic.deletedPanel', { id });
/** 面板页上的面板;排除过、后来删掉的面板也列出来,好取消 */
const excludeOptions = computed<SelectOption<number>[]>(() => [
  ...panels.value.map((p) => ({ value: p.id, label: p.name })),
  ...exclude.value.filter((id) => !panels.value.some((p) => p.id === id)).map((id) => ({ value: id, label: panelName(id) })),
]);
const excludeLabel = computed(() => {
  const ids = exclude.value;
  if (!ids.length) return t('traffic.excludeNone');
  return ids.length === 1 ? t('traffic.excludeOne', { name: panelName(ids[0]) }) : t('traffic.excludeN', { n: ids.length });
});
const excludedList = computed(() => exclude.value.map(panelName).join(locale.value === 'zh' ? '、' : ', '));
watch(exclude, (ids) => {
  try {
    localStorage.setItem(EXCLUDE_KEY, JSON.stringify(ids));
  } catch {
    /* 存不了就算了 */
  }
  // 正展开看的面板被排除了:回到全部面板
  if (by.value === 'panel' && focus.value && ids.includes(focus.value.id)) focus.value = null;
});

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await api.traffic(by.value, days.value, focus.value?.id, exclude.value);
    if (mine === seq) report.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}
function setBy(v: TrafficBy) {
  by.value = v;
  focus.value = null;
}
watch([by, days, focus, exclude], load);
onMounted(load);

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const totalUp = computed(() => sum(report.value?.total.up ?? []));
const totalDown = computed(() => sum(report.value?.total.down ?? []));
const total = computed(() => totalUp.value + totalDown.value);
const noun = computed(() => (by.value === 'customer' ? t('traffic.customer') : t('traffic.panel')));
/** 行的名字:服务端给的「已删除 / 没归入」是中文占位,这里按界面语言重写;展开后的行(面板 · 客户端)原样显示 */
function rowName(r: TrafficRow): string {
  if (focus.value) return r.name;
  if (r.deleted) return by.value === 'customer' ? t('traffic.deletedCustomer', { id: r.id }) : t('traffic.deletedPanel', { id: r.id });
  return by.value === 'customer' && r.id === 0 ? t('traffic.unassigned') : r.name;
}

/** 纵轴上限:取到 1 / 2 / 5 × 1024 的幂,刻度读起来是整数 */
function niceMax(v: number): number {
  if (v <= 0) return 1024;
  const unit = 1024 ** Math.floor(Math.log(v) / Math.log(1024));
  for (const m of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024]) if (unit * m >= v) return unit * m;
  return unit * 1024;
}
const bars = computed(() => {
  const r = report.value;
  if (!r) return [];
  return r.days.map((day, i) => ({ day, up: r.total.up[i], down: r.total.down[i] }));
});
const top = computed(() => niceMax(Math.max(0, ...bars.value.map((b) => b.up + b.down))));
const ticks = computed(() => [1, 0.5, 0].map((f) => ({ at: f, label: f ? fmtBytes(top.value * f) : '0' })));
const pct = (v: number) => `${(v / top.value) * 100}%`;
const shortDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
/** 横轴只标几个日期,免得挤在一起 */
const labelEvery = computed(() => Math.max(1, Math.ceil(bars.value.length / 8)));

const hover = ref<number | null>(null);
const tipStyle = computed(() => {
  const n = bars.value.length;
  if (hover.value == null || !n) return {};
  const x = ((hover.value + 0.5) / n) * 100;
  // 靠右的柱子,提示框往左放,不出界
  return x > 60 ? { right: `${100 - x}%`, marginRight: '10px' } : { left: `${x}%`, marginLeft: '10px' };
});

const maxRow = computed(() => Math.max(1, ...(report.value?.rows ?? []).map((r) => r.up + r.down)));
const share = (r: TrafficRow) => (total.value ? `${(((r.up + r.down) / total.value) * 100).toFixed(1)}%` : '—');
const canOpen = (r: TrafficRow) => !focus.value;
function open(r: TrafficRow) {
  if (canOpen(r)) focus.value = { id: r.id, name: rowName(r) };
}
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>{{ t('traffic.title') }}</h2>
      <p class="muted small">{{ t('traffic.intro') }}</p>
    </div>
  </div>

  <div class="filters">
    <div class="seg" role="group" :aria-label="t('traffic.byLabel')">
      <button :class="{ on: by === 'customer' }" :aria-pressed="by === 'customer'" @click="setBy('customer')">{{ t('traffic.byCustomer') }}</button>
      <button :class="{ on: by === 'panel' }" :aria-pressed="by === 'panel'" @click="setBy('panel')">{{ t('traffic.byPanel') }}</button>
    </div>
    <div class="seg" role="group" :aria-label="t('traffic.rangeLabel')">
      <button v-for="n in RANGES" :key="n" :class="{ on: days === n }" :aria-pressed="days === n" @click="days = n">{{ rangeLabel(n) }}</button>
    </div>
    <MultiSelect v-model="exclude" :options="excludeOptions" :label="excludeLabel" :all-label="t('traffic.excludeNone')" :aria-label="t('traffic.excludeLabel')" :title="t('traffic.excludeLabel')" />
    <span v-if="loading" class="muted small">{{ t('common.loading') }}</span>
  </div>
  <p v-if="exclude.length" class="small muted excluded">{{ t('traffic.excludedNote', { list: excludedList }) }}</p>

  <p v-if="focus" class="crumb small">
    <button class="link" @click="focus = null">{{ by === 'customer' ? t('traffic.allCustomers') : t('traffic.allPanels') }}</button>
    <span class="muted">/</span>
    <strong>{{ focus.name }}</strong>
  </p>

  <template v-if="report">
    <section class="tiles">
      <div class="tile sheet">
        <span class="muted small">{{ t('traffic.total') }}</span><strong>{{ fmtBytes(total) }}</strong>
      </div>
      <div class="tile sheet">
        <span class="muted small"><i class="dot down" />{{ t('traffic.down') }}</span><strong>{{ fmtBytes(totalDown) }}</strong>
      </div>
      <div class="tile sheet">
        <span class="muted small"><i class="dot up" />{{ t('traffic.up') }}</span><strong>{{ fmtBytes(totalUp) }}</strong>
      </div>
      <div v-if="report.days.length > 1" class="tile sheet">
        <span class="muted small">{{ t('traffic.dailyAvg') }}</span><strong>{{ fmtBytes(Math.round(total / report.days.length)) }}</strong>
      </div>
    </section>

    <section v-if="report.days.length > 1" class="sheet chart-card">
      <header class="chart-head">
        <strong>{{ t('traffic.perDay') }}</strong>
        <span class="legend small muted"><span><i class="dot down" />{{ t('traffic.down') }}</span><span><i class="dot up" />{{ t('traffic.up') }}</span></span>
      </header>
      <div class="chart" @mouseleave="hover = null">
        <div class="yaxis small muted" aria-hidden="true">
          <span v-for="t in ticks" :key="t.at" :style="{ bottom: `${t.at * 100}%` }">{{ t.label }}</span>
        </div>
        <div class="plot">
          <i v-for="t in ticks" :key="t.at" class="grid" :style="{ bottom: `${t.at * 100}%` }" />
          <div
            v-for="(b, i) in bars"
            :key="b.day"
            class="col"
            :class="{ on: hover === i }"
            tabindex="0"
            :aria-label="t('traffic.barAria', { day: b.day, down: fmtBytes(b.down), up: fmtBytes(b.up) })"
            @mouseenter="hover = i"
            @focus="hover = i"
            @blur="hover = null"
          >
            <span class="stack">
              <i v-if="b.up" class="seg-up" :style="{ height: pct(b.up) }" />
              <i v-if="b.down" class="seg-down" :style="{ height: pct(b.down) }" />
            </span>
          </div>
          <div v-if="hover != null && bars[hover]" class="tip sheet small" :style="tipStyle">
            <strong>{{ bars[hover].day }}</strong>
            <span><i class="dot down" />{{ t('traffic.down') }}<b>{{ fmtBytes(bars[hover].down) }}</b></span>
            <span><i class="dot up" />{{ t('traffic.up') }}<b>{{ fmtBytes(bars[hover].up) }}</b></span>
            <span class="sum">{{ t('traffic.total') }}<b>{{ fmtBytes(bars[hover].up + bars[hover].down) }}</b></span>
          </div>
        </div>
        <div class="xaxis small muted" aria-hidden="true">
          <span v-for="(b, i) in bars" :key="b.day">{{ i % labelEvery === 0 ? shortDay(b.day) : '' }}</span>
        </div>
      </div>
    </section>

    <section class="sheet">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ focus ? t('traffic.client') : noun }}</th>
              <th class="wide">{{ t('traffic.usage') }}</th>
              <th class="num">{{ t('traffic.total') }}</th>
              <th class="num">{{ t('traffic.share') }}</th>
              <th class="num">{{ t('traffic.down') }}</th>
              <th class="num">{{ t('traffic.up') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in report.rows" :key="`${r.id}-${r.name}`">
              <td>
                <button v-if="canOpen(r)" class="link name" :title="t('traffic.openHint', { name: rowName(r) })" @click="open(r)">{{ rowName(r) }}</button>
                <span v-else class="name">{{ rowName(r) }}</span>
                <span v-if="r.deleted" class="badge warn">{{ t('traffic.deleted') }}</span>
              </td>
              <td class="wide">
                <span class="meter"><i :style="{ width: `${((r.up + r.down) / maxRow) * 100}%` }" /></span>
              </td>
              <td class="num">{{ fmtBytes(r.up + r.down) }}</td>
              <td class="num muted">{{ share(r) }}</td>
              <td class="num">{{ fmtBytes(r.down) }}</td>
              <td class="num">{{ fmtBytes(r.up) }}</td>
            </tr>
            <tr v-if="!report.rows.length">
              <td colspan="6" class="muted empty">{{ t('traffic.empty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: 8px;
  overflow: hidden;
  background: var(--sheet);
}
.seg button {
  border: none;
  border-radius: 0;
  background: none;
  padding: 6px 14px;
  color: var(--ink-soft);
  box-shadow: none;
}
.seg button + button {
  border-left: 1px solid var(--rule);
}
.seg button.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}
.excluded {
  margin: -6px 0 14px;
  max-width: 80ch;
}
.crumb {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
}
.tile strong {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 6px;
}
.dot.down,
.seg-down {
  background: var(--series-1);
}
.dot.up,
.seg-up {
  background: var(--series-2);
}
.chart-card {
  padding: 16px 16px 12px;
  margin-bottom: 14px;
}
.chart-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 14px;
}
.legend {
  display: flex;
  gap: 14px;
}
.chart {
  display: grid;
  grid-template-columns: 56px 1fr;
  grid-template-rows: 200px auto;
  column-gap: 8px;
}
.yaxis {
  position: relative;
  font-variant-numeric: tabular-nums;
}
.yaxis span {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  white-space: nowrap;
}
.plot {
  position: relative;
  display: flex;
  align-items: stretch;
}
.grid {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px solid var(--rule-soft);
}
.col {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: center;
  outline: none;
}
.col.on {
  background: var(--hover);
}
.stack {
  width: 70%;
  max-width: 22px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 2px;
}
.stack i {
  display: block;
  min-height: 2px;
}
.stack i:first-child {
  border-radius: 4px 4px 0 0;
}
.tip {
  position: absolute;
  top: 4px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
}
.tip span {
  display: flex;
  align-items: center;
  color: var(--ink-soft);
}
.tip b {
  margin-left: auto;
  padding-left: 16px;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.tip .sum {
  border-top: 1px solid var(--rule-soft);
  padding-top: 3px;
}
.xaxis {
  grid-column: 2;
  display: flex;
  padding-top: 6px;
}
.xaxis span {
  flex: 1;
  min-width: 0;
  text-align: center;
  white-space: nowrap;
  overflow: visible;
}
.wide {
  width: 34%;
}
.meter {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: var(--rule-soft);
}
.meter i {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: 3px;
  background: var(--series-1);
}
.name {
  font-weight: 500;
  text-align: left;
}
.name + .badge {
  margin-left: 8px;
}
.empty {
  text-align: center;
  padding: 28px 16px;
}
@media (max-width: 640px) {
  .wide {
    display: none;
  }
  .chart {
    grid-template-columns: 46px 1fr;
  }
}
</style>
