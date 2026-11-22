<script setup lang="ts">
// 每天的流量:下行、上行叠在一根柱子上,鼠标放上去 / 键盘移过去显示当天的数。流量页和客户的流量趋势弹窗共用。
import { computed, ref } from 'vue';
import { t } from '../i18n';
import { fmtBytes } from '../format';

const props = withDefaults(defineProps<{ title: string; days: string[]; up: number[]; down: number[]; height?: number }>(), { height: 200 });

/** 纵轴上限:取到 1 / 2 / 5 × 1024 的幂,刻度读起来是整数 */
function niceMax(v: number): number {
  if (v <= 0) return 1024;
  const unit = 1024 ** Math.floor(Math.log(v) / Math.log(1024));
  for (const m of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024]) if (unit * m >= v) return unit * m;
  return unit * 1024;
}
const bars = computed(() => props.days.map((day, i) => ({ day, up: props.up[i] ?? 0, down: props.down[i] ?? 0 })));
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
</script>

<template>
  <header class="chart-head">
    <strong>{{ title }}</strong>
    <span class="legend small muted"><span><i class="dot down" />{{ t('traffic.down') }}</span><span><i class="dot up" />{{ t('traffic.up') }}</span></span>
  </header>
  <div class="chart" :style="{ gridTemplateRows: `${height}px auto` }" @mouseleave="hover = null">
    <div class="yaxis small muted" aria-hidden="true">
      <span v-for="k in ticks" :key="k.at" :style="{ bottom: `${k.at * 100}%` }">{{ k.label }}</span>
    </div>
    <div class="plot">
      <i v-for="k in ticks" :key="k.at" class="grid" :style="{ bottom: `${k.at * 100}%` }" />
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
</template>

<style scoped>
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
@media (max-width: 640px) {
  .chart {
    grid-template-columns: 46px 1fr;
  }
}
</style>
