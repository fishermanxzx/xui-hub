<script setup lang="ts">
// 客户页的「流量趋势」弹窗:这位客户最近几天每天用了多少,和各条线路各用了多少。数据就是流量页「按客户」点开这位客户的那份。
import { computed, ref, watch } from 'vue';
import { t } from '../i18n';
import { api } from '../api';
import TrafficChart from './TrafficChart.vue';
import { fmtBytes } from '../format';
import { toastError } from '../toast';
import type { Customer, TrafficReport } from '../types';

const props = defineProps<{ customer: Customer }>();

const RANGES = [7, 30, 90];
const days = ref(30);
const report = ref<TrafficReport | null>(null);
const loading = ref(false);
let seq = 0;

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await api.traffic('customer', days.value, props.customer.id);
    if (mine === seq) report.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch([days, () => props.customer.id], load, { immediate: true });

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const totalUp = computed(() => sum(report.value?.total.up ?? []));
const totalDown = computed(() => sum(report.value?.total.down ?? []));
const total = computed(() => totalUp.value + totalDown.value);
/** 最多的一天 */
const peak = computed(() => {
  const r = report.value;
  if (!r) return null;
  let best = -1;
  let at = 0;
  r.days.forEach((_, i) => {
    const v = r.total.up[i] + r.total.down[i];
    if (v > best) [best, at] = [v, i];
  });
  return best > 0 ? { day: r.days[at], v: best } : null;
});
const share = (v: number) => (total.value ? `${((v / total.value) * 100).toFixed(1)}%` : '—');
</script>

<template>
  <div class="filters">
    <div class="seg" role="group" :aria-label="t('traffic.rangeLabel')">
      <button v-for="n in RANGES" :key="n" :class="{ on: days === n }" :aria-pressed="days === n" @click="days = n">{{ t('traffic.days', { n }) }}</button>
    </div>
    <span v-if="loading" class="muted small">{{ t('common.loading') }}</span>
  </div>

  <template v-if="report">
    <section class="tiles">
      <div class="tile">
        <span class="muted small">{{ t('traffic.total') }}</span><strong>{{ fmtBytes(total) }}</strong>
      </div>
      <div class="tile">
        <span class="muted small"><i class="dot down" />{{ t('traffic.down') }}</span><strong>{{ fmtBytes(totalDown) }}</strong>
      </div>
      <div class="tile">
        <span class="muted small"><i class="dot up" />{{ t('traffic.up') }}</span><strong>{{ fmtBytes(totalUp) }}</strong>
      </div>
      <div class="tile">
        <span class="muted small">{{ t('traffic.dailyAvg') }}</span><strong>{{ fmtBytes(Math.round(total / report.days.length)) }}</strong>
      </div>
      <div class="tile">
        <span class="muted small" :title="peak?.day">{{ t('customerTraffic.peak') }}<template v-if="peak"> · {{ peak.day.slice(5) }}</template></span>
        <strong>{{ peak ? fmtBytes(peak.v) : '—' }}</strong>
      </div>
    </section>

    <section class="chart-box">
      <TrafficChart :title="t('traffic.perDay')" :days="report.days" :up="report.total.up" :down="report.total.down" :height="180" />
    </section>

    <h4 class="sec">{{ t('customerTraffic.byLine') }}</h4>
    <div v-if="report.rows.length" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('customerTraffic.line') }}</th>
            <th class="num">{{ t('traffic.total') }}</th>
            <th class="num opt">{{ t('traffic.share') }}</th>
            <th class="num">{{ t('traffic.down') }}</th>
            <th class="num opt">{{ t('traffic.up') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in report.rows" :key="r.name">
            <td class="small line-name">{{ r.name }}</td>
            <td class="num">{{ fmtBytes(r.up + r.down) }}</td>
            <td class="num muted opt">{{ share(r.up + r.down) }}</td>
            <td class="num">{{ fmtBytes(r.down) }}</td>
            <td class="num opt">{{ fmtBytes(r.up) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted small">{{ t('traffic.empty') }}</p>
    <p class="muted small note">
      {{ t('customerTraffic.note') }}<template v-if="customer.actual_used !== customer.used"> {{ t('customerTraffic.ratioNote') }}</template>
    </p>
  </template>
</template>

<style scoped>
.filters {
  display: flex;
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
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--rule-soft);
  border-radius: 8px;
}
.tile strong {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 6px;
}
.dot.down {
  background: var(--series-1);
}
.dot.up {
  background: var(--series-2);
}
.chart-box {
  margin-bottom: 16px;
}
.sec {
  margin: 0 0 8px;
  font-size: 14px;
}
.note {
  margin-top: 12px;
}
.line-name {
  min-width: 10em;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .opt {
    display: none;
  }
  .tile {
    padding: 8px 10px;
  }
  .tile strong {
    font-size: 16px;
  }
}
</style>
