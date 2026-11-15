<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { fmtBytes } from '../format';
import { toastError } from '../toast';
import type { TrafficBy, TrafficReport, TrafficRow } from '../types';

const RANGES = [
  { days: 1, label: '今天' },
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
];

const by = ref<TrafficBy>('customer');
const days = ref(30);
/** 展开看的那一位客户 / 那一块面板 */
const focus = ref<{ id: number; name: string } | null>(null);
const report = ref<TrafficReport | null>(null);
const loading = ref(false);
let seq = 0;

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await api.traffic(by.value, days.value, focus.value?.id);
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
watch([by, days, focus], load);
onMounted(load);

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const totalUp = computed(() => sum(report.value?.total.up ?? []));
const totalDown = computed(() => sum(report.value?.total.down ?? []));
const total = computed(() => totalUp.value + totalDown.value);
const noun = computed(() => (by.value === 'customer' ? '客户' : '面板'));

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
  if (canOpen(r)) focus.value = { id: r.id, name: r.name };
}
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>流量</h2>
      <p class="muted small">每分钟同步面板时记下各客户端用的流量,按天汇总(从接入面板、升级到这个版本那一刻开始记,之前的没有)。面板上的客户端都算,没归入客户的单独一行。保留一年。</p>
    </div>
  </div>

  <div class="filters">
    <div class="seg" role="group" aria-label="统计方式">
      <button :class="{ on: by === 'customer' }" :aria-pressed="by === 'customer'" @click="setBy('customer')">按客户</button>
      <button :class="{ on: by === 'panel' }" :aria-pressed="by === 'panel'" @click="setBy('panel')">按面板</button>
    </div>
    <div class="seg" role="group" aria-label="时间范围">
      <button v-for="r in RANGES" :key="r.days" :class="{ on: days === r.days }" :aria-pressed="days === r.days" @click="days = r.days">{{ r.label }}</button>
    </div>
    <span v-if="loading" class="muted small">读取中…</span>
  </div>

  <p v-if="focus" class="crumb small">
    <button class="link" @click="focus = null">全部{{ noun }}</button>
    <span class="muted">/</span>
    <strong>{{ focus.name }}</strong>
  </p>

  <template v-if="report">
    <section class="tiles">
      <div class="tile sheet">
        <span class="muted small">合计</span><strong>{{ fmtBytes(total) }}</strong>
      </div>
      <div class="tile sheet">
        <span class="muted small"><i class="dot down" />下行</span><strong>{{ fmtBytes(totalDown) }}</strong>
      </div>
      <div class="tile sheet">
        <span class="muted small"><i class="dot up" />上行</span><strong>{{ fmtBytes(totalUp) }}</strong>
      </div>
      <div v-if="report.days.length > 1" class="tile sheet">
        <span class="muted small">日均</span><strong>{{ fmtBytes(Math.round(total / report.days.length)) }}</strong>
      </div>
    </section>

    <section v-if="report.days.length > 1" class="sheet chart-card">
      <header class="chart-head">
        <strong>每天的流量</strong>
        <span class="legend small muted"><span><i class="dot down" />下行</span><span><i class="dot up" />上行</span></span>
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
            :aria-label="`${b.day} 下行 ${fmtBytes(b.down)},上行 ${fmtBytes(b.up)}`"
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
            <span><i class="dot down" />下行<b>{{ fmtBytes(bars[hover].down) }}</b></span>
            <span><i class="dot up" />上行<b>{{ fmtBytes(bars[hover].up) }}</b></span>
            <span class="sum">合计<b>{{ fmtBytes(bars[hover].up + bars[hover].down) }}</b></span>
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
              <th>{{ focus ? '客户端' : noun }}</th>
              <th class="wide">用量</th>
              <th class="num">合计</th>
              <th class="num">占比</th>
              <th class="num">下行</th>
              <th class="num">上行</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in report.rows" :key="`${r.id}-${r.name}`">
              <td>
                <button v-if="canOpen(r)" class="link name" :title="`看「${r.name}」名下各客户端的流量`" @click="open(r)">{{ r.name }}</button>
                <span v-else class="name">{{ r.name }}</span>
                <span v-if="r.deleted" class="badge warn">已删除</span>
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
              <td colspan="6" class="muted empty">这段时间还没有流量记录。</td>
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
