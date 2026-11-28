<script setup lang="ts">
// 出口规则的编辑区:一条一张卡片(域名 / IP / 端口 / 协议 → 出口),能加、删、上下挪。
// geo 写法按 panelId 那块面板的库核对(批量改时用第一条选中线路的面板;保存时服务端按每块面板再核对一遍)。
import { computed } from 'vue';
import { t } from '../i18n';
import GeoField from './GeoField.vue';
import Select, { type SelectOption } from './Select.vue';
import type { RuleRow } from '../ruleRows';
import type { Socks } from '../types';

const props = defineProps<{ socks: Socks[]; panelId: number; panelName: string }>();
const rows = defineModel<RuleRow[]>({ required: true });

const targets = computed<SelectOption<string>[]>(() => [
  ...props.socks.map((s) => ({ value: `socks:${s.id}`, label: t('customers.routeSocks', { name: s.name }) })),
  { value: 'direct', label: t('customers.direct') },
  { value: 'block', label: t('customers.routeBlock') },
]);
const networks = computed<SelectOption<string>[]>(() => [
  { value: '', label: t('customers.rulesNetworkAny') },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
]);
function add() {
  rows.value.push({ domain: '', ip: '', port: '', network: '', to: props.socks[0] ? `socks:${props.socks[0].id}` : 'direct' });
}
function move(i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= rows.value.length) return;
  const list = rows.value;
  [list[i], list[j]] = [list[j], list[i]];
}
</script>

<template>
  <div v-for="(r, i) in rows" :key="i" class="rule-card">
    <div class="rule-head">
      <strong class="small">{{ t('customers.ruleN', { n: i + 1 }) }}</strong>
      <span class="spacer" />
      <button type="button" class="link" :disabled="i === 0" :title="t('customers.ruleUp')" @click="move(i, -1)">↑</button>
      <button type="button" class="link" :disabled="i === rows.length - 1" :title="t('customers.ruleDown')" @click="move(i, 1)">↓</button>
      <button type="button" class="link danger" @click="rows.splice(i, 1)">{{ t('common.delete') }}</button>
    </div>
    <GeoField v-model="r.domain" kind="site" multiline :panel-id="panelId" :panel-name="panelName" :label="t('customers.ruleDomain')" :placeholder="t('customers.ruleDomainPlaceholder')" />
    <div class="two">
      <GeoField v-model="r.ip" kind="ip" :panel-id="panelId" :panel-name="panelName" :label="t('customers.ruleIp')" :placeholder="t('customers.ruleIpPlaceholder')" />
      <label class="field">{{ t('customers.rulePort') }}<input v-model="r.port" spellcheck="false" :placeholder="t('customers.rulePortPlaceholder')" /></label>
    </div>
    <div class="two">
      <label class="field">{{ t('customers.ruleNetwork') }}<Select v-model="r.network" :options="networks" /></label>
      <label class="field">{{ t('customers.ruleTo') }}<Select v-model="r.to" :options="targets" /></label>
    </div>
  </div>
  <div class="row rule-add">
    <button v-if="rows.length < 20" type="button" class="link" @click="add()">{{ t('customers.ruleAdd') }}</button>
  </div>
</template>

<style scoped>
.rule-card {
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rule-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rule-add {
  flex-wrap: wrap;
  gap: 6px 12px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
</style>
