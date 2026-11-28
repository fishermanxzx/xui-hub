<script setup lang="ts">
// 「批量改出口规则」弹窗:给一位客户勾几条线路,出口规则整组换成同一组(可以从某条线路带入再改)。
// 同一块面板上的一起改,只重启一次 Xray;面板上手配的规则不动。
import { computed, ref } from 'vue';
import { api } from '../api';
import { locale, t } from '../i18n';
import { fromRow, toRow, type RuleRow } from '../ruleRows';
import { toast, toastError } from '../toast';
import type { Customer, Line, Socks } from '../types';
import RuleEditor from './RuleEditor.vue';
import Select, { type SelectOption } from './Select.vue';

const props = defineProps<{ customer: Customer; lines: Line[]; socks: Socks[] }>();
const emit = defineEmits<{ done: [] }>();

const sep = computed(() => (locale.value === 'zh' ? '、' : ', '));
const lineName = (l: Line) => `${l.panel_name} · ${l.node_name || l.email}`;

const picked = ref(new Set(props.lines.map((l) => l.id)));
const chosen = computed(() => props.lines.filter((l) => picked.value.has(l.id)));
function toggle(id: number) {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}
const allPicked = computed(() => picked.value.size === props.lines.length);
const pickAll = () => (picked.value = allPicked.value ? new Set() : new Set(props.lines.map((l) => l.id)));

// 从哪条线路带入:默认第一条有规则的,都没有就从头写
const withRules = computed(() => props.lines.filter((l) => l.rules?.length));
const sourceOptions = computed<SelectOption<number>[]>(() => [
  { value: 0, label: t('rulesBatch.fromBlank') },
  ...withRules.value.map((l) => ({ value: l.id, label: t('rulesBatch.fromLine', { line: lineName(l), n: l.rules.length }) })),
]);
const source = ref(withRules.value[0]?.id ?? 0);
const rows = ref<RuleRow[]>((withRules.value[0]?.rules ?? []).map(toRow));
let baseline = JSON.stringify(rows.value);
function pickSource(id: number) {
  if (id === source.value) return;
  if (JSON.stringify(rows.value) !== baseline && !confirm(t('rulesBatch.dirty'))) return;
  source.value = id;
  rows.value = (props.lines.find((l) => l.id === id)?.rules ?? []).map(toRow);
  baseline = JSON.stringify(rows.value);
}

/** geo 写法按第一条选中线路的面板核对 */
const geoLine = computed(() => chosen.value[0] ?? props.lines[0]);
const panels = computed(() => [...new Set(chosen.value.map((l) => l.panel_name))].join(sep.value));
/** 线路上现有的规则条数(给人看会被替换掉多少) */
const replacing = computed(() => chosen.value.filter((l) => l.rules?.length).length);

const running = ref(false);
async function run() {
  if (!chosen.value.length || running.value) return;
  const rules = rows.value.map(fromRow);
  if (!rules.length && !confirm(t('rulesBatch.confirmClear', { n: chosen.value.length }))) return;
  running.value = true;
  try {
    const r = await api.batchLineRules({ customer_id: props.customer.id, line_ids: chosen.value.map((l) => l.id), rules });
    const bad = r.failed.map((f) => t('lineExit.failedItem', { line: f.line, error: f.error })).join(sep.value);
    toast(bad ? t('rulesBatch.donePart', { n: r.changed.length, m: r.failed.length, list: bad }) : t('rulesBatch.done', { n: r.changed.length }), bad ? 'err' : 'ok');
    emit('done');
  } catch (e) {
    toastError(e);
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <fieldset class="batch-form" :disabled="running">
    <div class="field-block">
      <div class="row head">
        <span class="label">{{ t('rulesBatch.lines', { n: chosen.length, total: lines.length }) }}</span>
        <button type="button" class="link small" @click="pickAll">{{ allPicked ? t('lineExit.none') : t('lineExit.all') }}</button>
      </div>
      <ul class="picks">
        <li v-for="l in lines" :key="l.id">
          <label class="row small">
            <input type="checkbox" :checked="picked.has(l.id)" @change="toggle(l.id)" />
            <span class="where">
              <strong>{{ l.panel_name }}</strong>
              <span class="muted">{{ l.node_name || l.email }}</span>
            </span>
            <span class="muted cur">{{ l.rules?.length ? t('customers.rulesCount', { n: l.rules.length }) : t('rulesBatch.noRules') }}</span>
          </label>
        </li>
      </ul>
    </div>

    <label class="field">
      {{ t('rulesBatch.from') }}
      <Select :model-value="source" :options="sourceOptions" :aria-label="t('rulesBatch.from')" @update:model-value="pickSource" />
    </label>

    <p class="muted small">{{ t('customers.rulesIntro') }}</p>
    <RuleEditor v-if="geoLine" v-model="rows" :socks="socks" :panel-id="geoLine.panel_id" :panel-name="geoLine.panel_name" />
    <p class="muted small hint">{{ t('customers.rulesHint') }}</p>

    <div v-if="chosen.length" class="notice small">
      <p>{{ rows.length ? t('rulesBatch.warnReplace', { n: chosen.length, m: replacing }) : t('rulesBatch.warnClear', { n: chosen.length }) }}</p>
      <p>{{ t('lineExit.warnRestart', { panels }) }}</p>
      <p class="muted">{{ t('rulesBatch.warnKeep') }}</p>
    </div>
    <p v-else class="muted small">{{ t('lineExit.pickSome') }}</p>

    <div class="row actions">
      <button class="primary" :disabled="!chosen.length" @click="run">{{ running ? t('rulesBatch.running') : t('rulesBatch.submit', { n: chosen.length }) }}</button>
    </div>
  </fieldset>
</template>

<style scoped>
.batch-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.batch-form p {
  margin: 0;
}
.field-block .label {
  font-size: 12px;
  color: var(--ink-soft);
}
.head {
  justify-content: space-between;
  margin-bottom: 6px;
}
.picks {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--rule);
  border-radius: 8px;
}
.picks li + li {
  border-top: 1px solid var(--rule-soft);
}
.picks label {
  gap: 10px;
  padding: 8px 10px;
  cursor: pointer;
  flex-wrap: nowrap;
}
.where {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.cur {
  flex: none;
  text-align: right;
}
.notice {
  border: 1px solid color-mix(in srgb, var(--caution, #b54708) 40%, var(--rule));
  background: var(--caution-bg, var(--hover));
  border-radius: 8px;
  padding: 10px 12px;
}
.notice p + p {
  margin-top: 4px;
}
.actions {
  justify-content: flex-end;
}
</style>
