<script setup lang="ts">
import { locale, t } from '../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import MultiSelect from '../components/MultiSelect.vue';
import TrafficChart from '../components/TrafficChart.vue';
import type { SelectOption } from '../components/Select.vue';
import { fmtBytes } from '../format';
import { toastError } from '../toast';
import type { Customer, Panel, TrafficBy, TrafficReport, TrafficRow } from '../types';

const RANGES = [1, 7, 30, 90];
const rangeLabel = (n: number) => (n === 1 ? t('traffic.today') : t('traffic.days', { n }));

const by = ref<TrafficBy>('customer');
const days = ref(1);
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
const customers = ref<Customer[]>([]);
onMounted(async () => {
  try {
    [panels.value, customers.value] = await Promise.all([api.panels(), api.customers()]);
  } catch (e) {
    toastError(e);
  }
});
const listOf = (names: string[]) => {
  const sep = locale.value === 'zh' ? '、' : ', ';
  return names.length > 5 ? t('traffic.andMore', { list: names.slice(0, 5).join(sep), n: names.length - 5 }) : names.join(sep);
};
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
const excludedList = computed(() => listOf(exclude.value.map(panelName)));
watch(exclude, (ids) => {
  try {
    localStorage.setItem(EXCLUDE_KEY, JSON.stringify(ids));
  } catch {
    /* 存不了就算了 */
  }
  // 正展开看的面板被排除了:回到全部面板
  if (by.value === 'panel' && focus.value && ids.includes(focus.value.id)) focus.value = null;
});

// ---------- 只看哪些客户(0 = 没归入客户的客户端):合计、走势、按面板都只算他们的;不记,刷新页面回到全部 ----------
const only = ref<number[]>([]);
const customerName = (id: number) => (id === 0 ? t('traffic.unassigned') : (customers.value.find((c) => c.id === id)?.name ?? t('traffic.deletedCustomer', { id })));
const onlyOptions = computed<SelectOption<number>[]>(() => [
  ...[...customers.value].sort((a, b) => a.name.localeCompare(b.name, locale.value)).map((c) => ({ value: c.id, label: c.name })),
  { value: 0, label: t('traffic.unassigned') },
  ...only.value.filter((id) => id !== 0 && !customers.value.some((c) => c.id === id)).map((id) => ({ value: id, label: customerName(id) })),
]);
const onlyLabel = computed(() => {
  const ids = only.value;
  if (!ids.length) return t('traffic.allCustomers');
  return ids.length === 1 ? t('traffic.onlyOne', { name: customerName(ids[0]) }) : t('traffic.onlyN', { n: ids.length });
});
const onlyList = computed(() => listOf(only.value.map(customerName)));
watch(only, (ids) => {
  // 正展开看的客户不在里面了:回到全部客户
  if (by.value === 'customer' && focus.value && ids.length && !ids.includes(focus.value.id)) focus.value = null;
});

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await api.traffic(by.value, days.value, focus.value?.id, exclude.value, only.value);
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
watch([by, days, focus, exclude, only], load);
onMounted(load);

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const totalUp = computed(() => sum(report.value?.total.up ?? []));
const totalDown = computed(() => sum(report.value?.total.down ?? []));
const total = computed(() => totalUp.value + totalDown.value);
const noun = computed(() => (by.value === 'customer' ? t('traffic.customer') : t('traffic.panel')));
/** 行的名字:服务端给的「已删除 / 没归入」是中文占位,这里按界面语言重写;卸载掉的面板用卸载时的名字;展开后的行(面板 · 客户端)原样显示 */
function rowName(r: TrafficRow): string {
  if (focus.value || r.uninstalled) return r.name;
  if (r.deleted) return by.value === 'customer' ? t('traffic.deletedCustomer', { id: r.id }) : t('traffic.deletedPanel', { id: r.id });
  return by.value === 'customer' && r.id === 0 ? t('traffic.unassigned') : r.name;
}

const maxRow = computed(() => Math.max(1, ...(report.value?.rows ?? []).map((r) => r.up + r.down)));
const share = (r: TrafficRow) => (total.value ? `${(((r.up + r.down) / total.value) * 100).toFixed(1)}%` : '—');
const canOpen = (r: TrafficRow) => !focus.value;
function open(r: TrafficRow) {
  if (canOpen(r)) focus.value = { id: r.id, name: rowName(r) };
}
</script>

<template>
  <header class="page-head">
    <div class="ph-main">
      <h1>{{ t('traffic.title') }}</h1>
      <details class="about">
        <summary>{{ t('common.about') }}</summary>
        <p>{{ t('traffic.intro') }}</p>
      </details>
    </div>
  </header>

  <div class="filters">
    <div class="seg" role="group" :aria-label="t('traffic.byLabel')">
      <button :class="{ on: by === 'customer' }" :aria-pressed="by === 'customer'" @click="setBy('customer')">{{ t('traffic.byCustomer') }}</button>
      <button :class="{ on: by === 'panel' }" :aria-pressed="by === 'panel'" @click="setBy('panel')">{{ t('traffic.byPanel') }}</button>
    </div>
    <div class="seg" role="group" :aria-label="t('traffic.rangeLabel')">
      <button v-for="n in RANGES" :key="n" :class="{ on: days === n }" :aria-pressed="days === n" @click="days = n">{{ rangeLabel(n) }}</button>
    </div>
    <MultiSelect v-model="only" :options="onlyOptions" :label="onlyLabel" :all-label="t('traffic.allCustomers')" :aria-label="t('traffic.onlyLabel')" :title="t('traffic.onlyLabel')" searchable :search-placeholder="t('traffic.onlySearch')" />
    <MultiSelect v-model="exclude" :options="excludeOptions" :label="excludeLabel" :all-label="t('traffic.excludeNone')" :aria-label="t('traffic.excludeLabel')" :title="t('traffic.excludeLabel')" />
    <span v-if="loading" class="muted small">{{ t('common.loading') }}</span>
  </div>
  <p v-if="only.length" class="small muted excluded">{{ t('traffic.onlyNote', { list: onlyList }) }}</p>
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
      <TrafficChart :title="t('traffic.perDay')" :days="report.days" :up="report.total.up" :down="report.total.down" />
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
                <span v-if="r.uninstalled" class="badge">{{ t('traffic.uninstalled') }}</span>
                <span v-else-if="r.deleted" class="badge warn">{{ t('traffic.deleted') }}</span>
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
.dot.down {
  background: var(--series-1);
}
.dot.up {
  background: var(--series-2);
}
.chart-card {
  padding: 16px 16px 12px;
  margin-bottom: 14px;
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
}
</style>
