<script setup lang="ts">
// 「换出口」弹窗:给一条线路,或一位客户的几条 / 全部线路原地换出口(SOCKS 页登记的代理,或直出)。
// 不删线路、UUID 不变,客户不用更新订阅;涉及的每块面板重启一次 Xray,上面的客户端断几秒。
import { locale, t } from '../i18n';
import { computed, ref } from 'vue';
import { api } from '../api';
import Select, { type SelectOption } from './Select.vue';
import { toast, toastError } from '../toast';
import type { Customer, Line, Socks } from '../types';

const props = defineProps<{ customer: Customer; lines: Line[]; socks: Socks[] }>();
const emit = defineEmits<{ done: [] }>();

const single = computed(() => props.lines.length === 1);
const picked = ref(new Set(props.lines.map((l) => l.id)));

const options = computed<SelectOption<string>[]>(() => [
  { value: 'direct', label: t('lineExit.direct') },
  ...props.socks.map((s) => ({ value: `s${s.id}`, label: t('lineExit.socks', { name: s.name }) })),
]);
/** 现在是不是就是这个出口 */
const isAt = (l: Line, v: string) => (v === 'direct' ? l.kind === 'direct' : l.exit_kind === 'socks' && `s${l.exit_socks_id}` === v);
// 默认选第一个和现在不一样的(一条线路时),多条时选第一个 SOCKS
const target = ref(options.value.find((o) => (single.value ? !isAt(props.lines[0], o.value) : o.value !== 'direct'))?.value ?? 'direct');

const current = (l: Line) => (l.kind === 'direct' ? t('lineExit.directShort') : l.exit_socks_name ? t('lineExit.socks', { name: l.exit_socks_name }) : l.exit_label || t('lineExit.relay'));
const chosen = computed(() => props.lines.filter((l) => picked.value.has(l.id)));
/** 真要改的(已经是这个出口的不动) */
const moving = computed(() => chosen.value.filter((l) => !isAt(l, target.value)));
const sep = computed(() => (locale.value === 'zh' ? '、' : ', '));
const panels = computed(() => [...new Set(moving.value.map((l) => l.panel_name))].join(sep.value));

function toggle(id: number) {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}
const allPicked = computed(() => picked.value.size === props.lines.length);
const pickAll = () => (picked.value = allPicked.value ? new Set() : new Set(props.lines.map((l) => l.id)));

const running = ref(false);
async function run() {
  if (!moving.value.length || running.value) return;
  running.value = true;
  const exit = target.value === 'direct' ? ({ kind: 'direct' } as const) : ({ kind: 'socks', socks_id: Number(target.value.slice(1)) } as const);
  try {
    if (single.value) {
      await api.changeLineExit(props.customer.id, props.lines[0].id, exit);
      toast(t('lineExit.doneOne'));
    } else {
      const r = await api.batchLineExit({ customer_id: props.customer.id, line_ids: chosen.value.map((l) => l.id), exit });
      const bad = r.failed.map((f) => t('lineExit.failedItem', { line: f.line, error: f.error })).join(sep.value);
      toast(bad ? t('lineExit.donePart', { n: r.changed.length, m: r.failed.length, list: bad }) : t('lineExit.doneN', { n: r.changed.length }), bad ? 'err' : 'ok');
    }
    emit('done');
  } catch (e) {
    toastError(e);
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <fieldset class="exit-form" :disabled="running">
    <p v-if="single" class="small now">
      <span class="muted">{{ t('lineExit.current') }}</span> <strong>{{ current(lines[0]) }}</strong>
    </p>
    <div v-else class="field-block">
      <div class="row head">
        <span class="label">{{ t('lineExit.lines', { n: chosen.length, total: lines.length }) }}</span>
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
            <span class="muted cur">{{ current(l) }}</span>
            <span v-if="picked.has(l.id) && isAt(l, target)" class="badge">{{ t('lineExit.already') }}</span>
          </label>
        </li>
      </ul>
    </div>

    <label class="field">
      {{ t('lineExit.to') }}
      <Select v-model="target" :options="options" :aria-label="t('lineExit.to')" />
    </label>
    <p v-if="!socks.length" class="muted small">{{ t('lineExit.noSocks') }}</p>

    <div v-if="moving.length" class="notice small">
      <p>{{ t('lineExit.warnRestart', { panels }) }}</p>
      <p>{{ t('lineExit.warnKeep') }}</p>
      <p class="muted">{{ t('lineExit.warnRules') }}</p>
    </div>
    <p v-else class="muted small">{{ chosen.length ? t('lineExit.nothing') : t('lineExit.pickSome') }}</p>

    <div class="row actions">
      <button class="primary" :disabled="!moving.length" @click="run">{{ running ? t('lineExit.running') : t('lineExit.submit', { n: moving.length }) }}</button>
    </div>
  </fieldset>
</template>

<style scoped>
.exit-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.now {
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
  max-height: 260px;
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
  max-width: 40%;
  text-align: right;
  overflow-wrap: anywhere;
}
.notice {
  border: 1px solid color-mix(in srgb, var(--caution, #b54708) 40%, var(--rule));
  background: var(--caution-bg, var(--hover));
  border-radius: 8px;
  padding: 10px 12px;
}
.notice p {
  margin: 0;
}
.notice p + p {
  margin-top: 4px;
}
.actions {
  justify-content: flex-end;
}
</style>
