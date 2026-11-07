<script setup lang="ts">
// 每日流量柱状图(SVG 手绘,不引图表库)。柱子类名用 col:全局的 .bar 是用量进度条,会把高度压成 6px。
// 一组数据画单色柱;多组时按顺序从下往上堆叠,段与段之间留 2px 缝,柱顶圆角,下方带图例。
// 悬停看当天合计和各组明细(按当天流量从大到小);今天还没过完,柱子画浅一些。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtBytes } from '../format';
import type { ChartSeries } from '../types';

const props = defineProps<{
  days: string[];
  series: ChartSeries[];
  /** 每天在悬停提示里多显示一行(如有流量的客户数) */
  notes?: string[];
}>();

const HEIGHT = 252;
const PAD = { left: 56, right: 8, top: 12, bottom: 28 };
/** 堆叠段之间的缝 */
const GAP = 2;

const box = ref<HTMLElement | null>(null);
const width = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => (width.value = entry.contentRect.width));
  if (box.value) observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

/**
 * 纵轴分 4 格,每格取整:先按显示单位(MB / GB / TB,1024 进制,与 fmtBytes 一致)换算,
 * 再取 1 / 2 / 2.5 / 5 × 10^k,刻度就是 100 GB、200 GB 这样的整数
 */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const unit = 1024 ** Math.max(2, Math.min(4, Math.floor(Math.log(v) / Math.log(1024))));
  const raw = v / unit / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  return step * 4 * unit;
}

/** 顶部两角圆、底部方的柱子(贴着基线) */
function barPath(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const totals = computed(() => props.days.map((_, i) => props.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)));

const chart = computed(() => {
  const n = props.days.length;
  const w = Math.max(width.value, 280);
  const plotW = w - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const base = PAD.top + plotH;
  const max = niceMax(Math.max(0, ...totals.value));
  const band = n ? plotW / n : plotW;
  const barW = Math.max(2, band * 0.62);
  const segments: { key: string; i: number; d: string; color: string; today: boolean }[] = [];
  const tops: number[] = [];
  props.days.forEach((_, i) => {
    const x = PAD.left + i * band + (band - barW) / 2;
    const drawn = props.series.filter((s) => (s.values[i] ?? 0) > 0);
    let cursor = base;
    drawn.forEach((s, k) => {
      const h = ((s.values[i] ?? 0) / max) * plotH;
      // 上面的段在底部让出 2px 缝;太薄的段画不出来,悬停提示里照样有
      const gap = k > 0 ? GAP : 0;
      const top = cursor - h;
      const segH = h - gap;
      if (segH > 0.5) segments.push({ key: `${s.key}-${i}`, i, d: barPath(x, top, barW, segH, k === drawn.length - 1), color: s.color, today: i === n - 1 });
      cursor = top;
    });
    tops.push(cursor);
  });
  const yTicks = [0, 1, 2, 3, 4].map((k) => ({ y: base - (k / 4) * plotH, label: k ? fmtBytes((max * k) / 4) : '0' }));
  // 今天和往前每 7 天标一个日期
  const xTicks = props.days
    .map((d, i) => ({ i, x: PAD.left + i * band + band / 2, label: i === n - 1 ? '今天' : `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` }))
    .filter((t) => (n - 1 - t.i) % 7 === 0);
  return { w, band, barW, segments, tops, yTicks, xTicks };
});

const total = computed(() => totals.value.reduce((a, b) => a + b, 0));
const empty = computed(() => total.value === 0);
const stacked = computed(() => props.series.length > 1);

/** 图例:各组在整个区间的合计(数字用正文色,色块只标身份) */
const legend = computed(() => props.series.map((s) => ({ key: s.key, label: s.label, color: s.color, total: s.values.reduce((a, b) => a + b, 0) })));

const hover = ref<number | null>(null);
function onMove(e: MouseEvent) {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  const i = Math.floor((e.clientX - rect.left - PAD.left) / chart.value.band);
  hover.value = i >= 0 && i < props.days.length ? i : null;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const tip = computed(() => {
  const i = hover.value;
  if (i == null) return null;
  const [y, m, d] = props.days[i].split('-').map(Number);
  const week = WEEK[new Date(y, m - 1, d).getDay()];
  const x = PAD.left + i * chart.value.band + chart.value.band / 2;
  return {
    title: `${m}月${d}日 周${week}${i === props.days.length - 1 ? '（今天还没过完）' : ''}`,
    total: fmtBytes(totals.value[i]),
    note: props.notes?.[i],
    // 当天流量从大到小,「其他」放最后
    rows: stacked.value
      ? props.series
          .filter((s) => (s.values[i] ?? 0) > 0)
          .sort((a, b) => Number(!!a.rest) - Number(!!b.rest) || b.values[i] - a.values[i])
          .map((s) => ({ key: s.key, label: s.label, color: s.color, bytes: fmtBytes(s.values[i]) }))
      : [],
    left: Math.min(Math.max(x, 110), chart.value.w - 110),
    top: Math.max(chart.value.tops[i] - 8, 8),
  };
});
</script>

<template>
  <div ref="box" class="chart">
    <svg
      :width="chart.w"
      :height="HEIGHT"
      role="img"
      :aria-label="`近 ${days.length} 天每日流量,合计 ${fmtBytes(total)}`"
      @mousemove="onMove"
      @mouseleave="hover = null"
    >
      <g class="grid">
        <template v-for="t in chart.yTicks" :key="t.y">
          <line :x1="PAD.left" :x2="chart.w - PAD.right" :y1="t.y" :y2="t.y" />
          <text :x="PAD.left - 10" :y="t.y + 4" text-anchor="end">{{ t.label }}</text>
        </template>
      </g>
      <path
        v-for="s in chart.segments"
        :key="s.key"
        class="col"
        :class="{ today: s.today, dim: hover != null && hover !== s.i }"
        :d="s.d"
        :style="{ fill: s.color }"
      />
      <g class="xaxis">
        <text v-for="t in chart.xTicks" :key="t.i" :x="t.x" :y="HEIGHT - 8" text-anchor="middle">{{ t.label }}</text>
      </g>
    </svg>
    <div v-if="tip" class="tip" :style="{ left: `${tip.left}px`, top: `${tip.top}px` }">
      <div class="tip-title">{{ tip.title }}</div>
      <div>
        <template v-if="stacked">合计 </template><span class="figure">{{ tip.total }}</span>
      </div>
      <div v-for="r in tip.rows" :key="r.key" class="tip-row">
        <span class="swatch" :style="{ background: r.color }" />
        <span class="tip-label">{{ r.label }}</span>
        <span class="figure">{{ r.bytes }}</span>
      </div>
      <div v-if="tip.note" class="muted">{{ tip.note }}</div>
    </div>
    <p v-if="empty" class="empty-note muted">近 {{ days.length }} 天还没有流量记录</p>
    <ul v-if="stacked && !empty" class="legend small" aria-label="图例">
      <li v-for="l in legend" :key="l.key">
        <span class="swatch" :style="{ background: l.color }" />
        <span>{{ l.label }}</span>
        <span class="muted">{{ fmtBytes(l.total) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
  width: 100%;
}
svg {
  display: block;
}
.grid line {
  stroke: var(--rule-soft);
}
.grid text,
.xaxis text {
  fill: var(--ink-soft);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.col.today {
  opacity: 0.45;
}
.col.dim {
  opacity: 0.35;
}
.col.today.dim {
  opacity: 0.2;
}
.tip {
  position: absolute;
  transform: translate(-50%, -100%);
  pointer-events: none;
  background: var(--ink);
  color: var(--sheet);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  box-shadow: 0 4px 12px rgba(16, 24, 40, 0.18);
  z-index: 2;
}
.tip .muted {
  color: inherit;
  opacity: 0.7;
}
.tip-title {
  font-weight: 600;
}
.tip-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tip-label {
  flex: 1;
  margin-right: 12px;
}
.swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: none;
}
.tip .swatch {
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin: 8px 0 0;
  padding: 0 0 0 56px;
  list-style: none;
}
.legend li {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.empty-note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
}
</style>
