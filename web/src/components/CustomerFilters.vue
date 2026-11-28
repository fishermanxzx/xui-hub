<script setup lang="ts">
// 客户的一排筛选:面板 / 标签 / 状态 / 线路条数 / 落地 IP 个数 / 落地 IP / 规则分流,后面是「显示 n / 共 m · 清除筛选」。
// 客户页顶上和「批量开线路」弹窗里选客户都用它;选项后面的数是全部客户里符合的人数。
import { computed } from 'vue';
import { COUNT_FILTERS, CUSTOMER_STATES, SPLIT_FILTERS, exitIpOwners, exitIps, matchCount, matchSplit, matchState, panelsTagged, usesPanel, type CountFilter, type CustomerQuery, type SplitFilter } from '../customerQuery';
import { stateLabel } from '../format';
import { t } from '../i18n';
import type { Customer, Panel, Socks } from '../types';
import MultiSelect from './MultiSelect.vue';
import Select, { type SelectOption } from './Select.vue';

const props = defineProps<{ customers: Customer[]; panels: Panel[]; socks: Socks[]; shown: number }>();
const query = defineModel<CustomerQuery>({ required: true });

/** 有没有设了筛选(含搜索) */
const filtering = computed(() => {
  const f = query.value;
  return !!f.q.trim() || !!f.panels.length || !!f.state || !!f.tags.length || !!f.lines || !!f.exits || !!f.ips.length || !!f.split;
});
function clear() {
  query.value = { ...query.value, q: '', panels: [], state: '', tags: [], lines: '', exits: '', ips: [], split: '' };
}

const exitsOf = computed(() => {
  const pm = new Map(props.panels.map((p) => [p.id, p]));
  const sm = new Map(props.socks.map((s) => [s.id, s]));
  return new Map(props.customers.map((c) => [c.id, exitIps(c, pm, sm)]));
});
const count = (pred: (c: Customer) => boolean) => props.customers.filter(pred).length;

const panelOptions = computed<SelectOption<number>[]>(() => props.panels.map((p) => ({ value: p.id, label: t('customers.panelOption', { name: p.name, n: count((c) => usesPanel(c, new Set([p.id]))) }) })));
const panelLabel = computed(() => {
  const picked = query.value.panels;
  if (!picked.length) return t('customers.allPanels');
  if (picked.length === 1) return props.panels.find((p) => p.id === picked[0])?.name ?? t('customers.allPanels');
  return t('customers.panelsPicked', { n: picked.length });
});
/** 面板上用到的所有标签(按面板顺序出现的先后) */
const allTags = computed(() => [...new Set(props.panels.flatMap((p) => p.tags ?? []))]);
const tagOptions = computed<SelectOption<string>[]>(() =>
  allTags.value.map((tag) => {
    const ids = panelsTagged(props.panels, [tag]);
    return { value: tag, label: t('customers.panelOption', { name: tag, n: count((c) => usesPanel(c, ids)) }) };
  }),
);
const tagLabel = computed(() => {
  const picked = query.value.tags;
  if (!picked.length) return t('customers.allTags');
  return picked.length === 1 ? picked[0] : t('customers.tagsPicked', { n: picked.length });
});
const stateOptions = computed<SelectOption<CustomerQuery['state']>[]>(() => [
  { value: '', label: t('customers.allStates') },
  ...CUSTOMER_STATES.map((s) => ({ value: s, label: t('customers.stateOption', { label: s === 'soon' ? t('customers.stateSoon') : s === 'lines_off' ? t('customers.stateLinesOff') : stateLabel(s), n: count((c) => matchState(c, s)) }) })),
]);
const linesOptions = computed<SelectOption<CountFilter>[]>(() => [
  { value: '', label: t('customers.allLineCounts') },
  ...COUNT_FILTERS.map((f) => ({ value: f, label: t(f === '5+' ? 'customers.lineCountMore' : 'customers.lineCountOption', { label: f.replace('+', ''), n: count((c) => matchCount(c.lines.length, f)) }) })),
]);
const exitsOptions = computed<SelectOption<CountFilter>[]>(() => [
  { value: '', label: t('customers.allExitCounts') },
  ...COUNT_FILTERS.map((f) => ({ value: f, label: t(f === '5+' ? 'customers.exitCountMore' : 'customers.exitCountOption', { label: f.replace('+', ''), n: count((c) => matchCount(exitsOf.value.get(c.id)?.length ?? 0, f)) }) })),
]);
/** 落地 IP 的选项:客户线路落地过的每个 IP,带上是哪块面板 / 哪个 SOCKS 和有几位客户;客户多的在前 */
const ipOptions = computed<SelectOption<string>[]>(() => {
  const n = new Map<string, number>();
  for (const ips of exitsOf.value.values()) for (const ip of ips) n.set(ip, (n.get(ip) ?? 0) + 1);
  // 选了但现在没有客户落地在上面的(面板换了 IP 之类)也留着,能取消
  for (const ip of query.value.ips) if (!n.has(ip)) n.set(ip, 0);
  const owners = exitIpOwners(props.panels, props.socks);
  return [...n]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([ip, k]) => {
      const who = owners.get(ip)?.join('、');
      return { value: ip, label: who ? t('customers.exitIpOption', { ip, who, n: k }) : t('customers.exitIpOptionBare', { ip, n: k }) };
    });
});
const ipLabel = computed(() => {
  const picked = query.value.ips;
  if (!picked.length) return t('customers.allExitIps');
  return picked.length === 1 ? picked[0] : t('customers.exitIpsPicked', { n: picked.length });
});
const splitOptions = computed<SelectOption<SplitFilter>[]>(() => [
  { value: '', label: t('customers.allSplits') },
  ...SPLIT_FILTERS.map((f) => ({ value: f, label: t(`customers.split.${f}`, { n: count((c) => matchSplit(c, f)) }) })),
]);
</script>

<template>
  <div class="filters-row" role="group" :aria-label="t('customers.filterGroup')">
    <MultiSelect v-model="query.panels" :options="panelOptions" :label="panelLabel" :all-label="t('customers.allPanels')" :aria-label="t('customers.filterPanels')" :class="{ set: query.panels.length }" />
    <MultiSelect v-if="allTags.length" v-model="query.tags" :options="tagOptions" :label="tagLabel" :all-label="t('customers.allTags')" :aria-label="t('customers.filterTags')" searchable :class="{ set: query.tags.length }" />
    <Select v-model="query.state" :options="stateOptions" :aria-label="t('customers.filterState')" :class="{ set: query.state }" />
    <Select v-model="query.lines" :options="linesOptions" :aria-label="t('customers.filterLineCount')" :class="{ set: query.lines }" />
    <Select v-model="query.exits" :options="exitsOptions" :aria-label="t('customers.filterExitCount')" :class="{ set: query.exits }" />
    <MultiSelect
      v-if="ipOptions.length"
      v-model="query.ips"
      :options="ipOptions"
      :label="ipLabel"
      :all-label="t('customers.allExitIps')"
      :aria-label="t('customers.filterExitIp')"
      :title="t('customers.filterExitIpHint')"
      searchable
      :search-placeholder="t('customers.searchExitIp')"
      :class="{ set: query.ips.length }"
    />
    <Select v-model="query.split" :options="splitOptions" :aria-label="t('customers.filterSplit')" :title="t('customers.filterSplitHint')" :class="{ set: query.split }" />
    <span v-if="filtering" class="filter-sum">
      <span class="muted small">{{ t('customers.shown', { n: shown, total: customers.length }) }}</span>
      <button type="button" class="link small" @click="clear">{{ t('customers.clearFilters') }}</button>
    </span>
  </div>
</template>

<style scoped>
.filters-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
/* 过滤器平时是灰字,选了条件的变成浅青底;字太长就省略,鼠标停上去看全 */
.filters-row :deep(button.select) {
  max-width: 220px;
  padding: 5px 8px;
  border-color: transparent;
  background: transparent;
  color: var(--ink-soft);
}
.filters-row :deep(button.select:hover:not(:disabled)) {
  border-color: var(--rule);
  background: var(--sheet);
}
.filters-row :deep(button.select.set) {
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-color: transparent;
}
.filter-sum {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding-left: 8px;
  white-space: nowrap;
}
/* 不够一行放下时:筛选按列对齐(平板三四列、手机两列),不再一个挨一个乱折行 */
@media (max-width: 900px) {
  .filters-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 4px;
  }
  .filters-row :deep(button.select) {
    max-width: none;
    width: 100%;
    border-color: var(--rule);
  }
  .filter-sum {
    grid-column: 1 / -1;
    padding-left: 2px;
  }
}
</style>
