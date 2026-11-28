<script setup lang="ts">
// 「换出口 IP」弹窗:列出这位客户现在落地的各个出口(主出口 + 出口规则分流出去的,带 IP),
// 选一个旧的、换成另一个:主出口是它的换主出口,出口规则里指向它的换去向(条件不动)。
// 面板上手配的规则这里改不到,列出来提醒。同一块面板上的一起改,只重启一次 Xray;UUID 不变,客户不用更新订阅。
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import { panelIp, socksIp } from '../customerQuery';
import { locale, t } from '../i18n';
import { toast, toastError } from '../toast';
import type { Customer, Line, LineExitTarget, Panel, Socks } from '../types';
import Select, { type SelectOption } from './Select.vue';

const props = defineProps<{ customer: Customer; socks: Socks[]; panels: Panel[] }>();
const emit = defineEmits<{ done: [] }>();

const sep = computed(() => (locale.value === 'zh' ? '、' : ', '));
const lineName = (l: Line) => `${l.panel_name} · ${l.node_name || l.email}`;
const panelMap = computed(() => new Map(props.panels.map((p) => [p.id, p])));
const socksMap = computed(() => new Map(props.socks.map((s) => [s.id, s])));

/** 出口的 key:'direct' 或 's<SOCKS id>' */
const targetOf = (key: string): LineExitTarget => (key === 'direct' ? { kind: 'direct' } : { kind: 'socks', socks_id: Number(key.slice(1)) });
const mainKey = (l: Line) => (l.kind === 'direct' ? 'direct' : l.exit_kind === 'socks' && l.exit_socks_id != null ? `s${l.exit_socks_id}` : '');
const ruleKeys = (l: Line) => (l.rules ?? []).flatMap((r) => (r.to.kind === 'direct' ? ['direct'] : r.to.kind === 'socks' ? [`s${r.to.socks_id}`] : []));
/** 面板上手配的(不归 xui-hub 管)、指向某个 SOCKS 的分流 */
const handKeys = (l: Line) => (l.routes ?? []).flatMap((h) => (!h.fallback && h.origin !== 'xui' && h.to.socks_id != null ? [`s${h.to.socks_id}`] : []));

const nameOf = (key: string) => (key === 'direct' ? t('exitSwap.direct') : t('lineExit.socks', { name: socksMap.value.get(Number(key.slice(1)))?.name ?? t('customers.gone') }));
/** 直出 = 线路所在面板的 IP;SOCKS = 它的出口 IP */
const ipsOf = (key: string, lines: Line[]) => {
  if (key !== 'direct') {
    const s = socksMap.value.get(Number(key.slice(1)));
    return s ? [socksIp(s)] : [];
  }
  return [...new Set(lines.flatMap((l) => (panelMap.value.get(l.panel_id) ? [panelIp(panelMap.value.get(l.panel_id)!)] : [])))];
};

interface Use {
  key: string;
  /** 主出口是它的线路 */
  mains: Line[];
  /** 出口规则里有指向它的线路 */
  ruled: Line[];
  /** 面板上手配的规则指向它的线路(这里改不到) */
  hand: Line[];
}
const uses = computed<Use[]>(() => {
  const m = new Map<string, Use>();
  const get = (key: string) => m.get(key) ?? (m.set(key, { key, mains: [], ruled: [], hand: [] }), m.get(key)!);
  for (const l of props.customer.lines) {
    const k = mainKey(l);
    if (k) get(k).mains.push(l);
    for (const r of new Set(ruleKeys(l))) get(r).ruled.push(l);
    for (const h of new Set(handKeys(l))) get(h).hand.push(l);
  }
  // 能换的(主出口或出口规则用到)在前,线路多的在前
  return [...m.values()].filter((u) => u.mains.length || u.ruled.length).sort((a, b) => b.mains.length + b.ruled.length - (a.mains.length + a.ruled.length));
});
const from = ref(uses.value[0]?.key ?? '');
const fromUse = computed(() => uses.value.find((u) => u.key === from.value));

const toOptions = computed<SelectOption<string>[]>(() =>
  [{ value: 'direct', label: t('exitSwap.toDirect') }, ...props.socks.map((s) => ({ value: `s${s.id}`, label: t('exitSwap.toSocks', { name: s.name, ip: socksIp(s) }) }))].filter((o) => o.value !== from.value),
);
const to = ref('');
watch(
  toOptions,
  (opts) => {
    if (!opts.some((o) => o.value === to.value)) to.value = opts.find((o) => o.value !== 'direct')?.value ?? opts[0]?.value ?? '';
  },
  { immediate: true },
);

/** 要改的线路和各改什么 */
const affected = computed(() => {
  const u = fromUse.value;
  if (!u) return [];
  return props.customer.lines
    .filter((l) => u.mains.includes(l) || u.ruled.includes(l))
    .map((l) => ({ line: l, main: u.mains.includes(l), rules: ruleKeys(l).filter((k) => k === from.value).length }));
});
const picked = ref(new Set<number>());
watch(affected, (list) => (picked.value = new Set(list.map((a) => a.line.id))), { immediate: true });
function toggle(id: number) {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}
const chosen = computed(() => affected.value.filter((a) => picked.value.has(a.line.id)));
const panelsText = computed(() => [...new Set(chosen.value.map((a) => a.line.panel_name))].join(sep.value));
const what = (a: { main: boolean; rules: number }) => [a.main ? t('exitSwap.main') : '', a.rules ? t('exitSwap.rules', { n: a.rules }) : ''].filter(Boolean).join(sep.value);

const running = ref(false);
async function run() {
  if (!chosen.value.length || !to.value || running.value) return;
  running.value = true;
  try {
    const r = await api.swapCustomerExit(props.customer.id, { from: targetOf(from.value), to: targetOf(to.value), line_ids: chosen.value.map((a) => a.line.id) });
    const bad = r.failed.map((f) => t('lineExit.failedItem', { line: f.line, error: f.error })).join(sep.value);
    toast(bad ? t('lineExit.donePart', { n: r.changed.length, m: r.failed.length, list: bad }) : t('lineExit.doneN', { n: r.changed.length }), bad ? 'err' : 'ok');
    emit('done');
  } catch (e) {
    toastError(e);
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <fieldset class="swap-form" :disabled="running">
    <p v-if="!uses.length" class="muted small">{{ t('exitSwap.none') }}</p>
    <template v-else>
      <div class="field-block">
        <span class="label">{{ t('exitSwap.from') }}</span>
        <ul class="picks">
          <li v-for="u in uses" :key="u.key">
            <label class="row small">
              <input v-model="from" type="radio" name="swap-from" :value="u.key" />
              <span class="where">
                <strong>{{ nameOf(u.key) }}</strong>
                <span class="muted mono">{{ ipsOf(u.key, [...u.mains, ...u.ruled]).join(sep) || '—' }}</span>
              </span>
              <span class="muted cur">
                <span v-if="u.mains.length">{{ t('exitSwap.mainLines', { n: u.mains.length }) }}</span>
                <span v-if="u.ruled.length">{{ t('exitSwap.ruleLines', { n: u.ruled.length }) }}</span>
              </span>
            </label>
          </li>
        </ul>
      </div>

      <label class="field">
        {{ t('lineExit.to') }}
        <Select v-model="to" :options="toOptions" :aria-label="t('lineExit.to')" />
      </label>
      <p v-if="!socks.length" class="muted small">{{ t('lineExit.noSocks') }}</p>

      <div v-if="affected.length" class="field-block">
        <span class="label">{{ t('exitSwap.affected', { n: chosen.length, total: affected.length }) }}</span>
        <ul class="picks">
          <li v-for="a in affected" :key="a.line.id">
            <label class="row small">
              <input type="checkbox" :checked="picked.has(a.line.id)" @change="toggle(a.line.id)" />
              <span class="where">{{ lineName(a.line) }}</span>
              <span class="muted cur">{{ what(a) }}</span>
            </label>
          </li>
        </ul>
      </div>
      <p v-if="fromUse?.hand.length" class="small text-warn">{{ t('exitSwap.hand', { list: fromUse.hand.map(lineName).join(sep) }) }}</p>

      <div v-if="chosen.length" class="notice small">
        <p>{{ t('lineExit.warnRestart', { panels: panelsText }) }}</p>
        <p>{{ t('lineExit.warnKeep') }}</p>
      </div>
      <p v-else class="muted small">{{ t('lineExit.pickSome') }}</p>

      <div class="row actions">
        <button class="primary" :disabled="!chosen.length || !to" @click="run">{{ running ? t('lineExit.running') : t('exitSwap.submit', { n: chosen.length }) }}</button>
      </div>
    </template>
  </fieldset>
</template>

<style scoped>
.swap-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.swap-form p {
  margin: 0;
}
.field-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-block .label {
  font-size: 12px;
  color: var(--ink-soft);
}
.picks {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 220px;
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
.mono {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
}
.cur {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
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
