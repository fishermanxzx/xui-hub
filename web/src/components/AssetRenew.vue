<script setup lang="ts">
// 面板 / SOCKS 的「续费」:到期日往后顺延几个月(或几天),付了钱就顺手在账本记一笔关联它的支出。
// 金额默认 = 月成本 × 月数(月成本没填或是 0 就留空:比如和面板同一台机器的 SOCKS,费用已算在面板里),改过就不再跟着变;空 = 只顺延不记账。放在 Modal 里用,底部按钮用 form="asset-renew-form" 提交。
import { t } from '../i18n';
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import Select, { type SelectOption } from './Select.vue';
import { addMonths, fmtCost, fmtDate, msToDateInput } from '../format';
import { toast, toastError } from '../toast';
import type { AssetRenewal } from '../types';

const props = defineProps<{ kind: 'panel' | 'socks'; item: { id: number; name: string; monthly_cost: number | null; expire_at: number } }>();
const emit = defineEmits<{ saved: [r: AssetRenewal]; saving: [busy: boolean] }>();

const DAY = 86_400_000;
type Choice = 1 | 3 | 6 | 12 | 'custom';
const CHOICES: Choice[] = [1, 3, 6, 12, 'custom'];
const choiceLabel = (c: Choice) => (c === 'custom' ? t('payments.custom') : c === 12 ? t('payments.year') : t('payments.months', { n: c }));
const choice = ref<Choice>(1);
const customN = ref('2');
const customUnit = ref<'months' | 'days'>('months');
const unitOptions = computed<SelectOption<'months' | 'days'>[]>(() => [
  { value: 'months', label: t('payments.unitMonths') },
  { value: 'days', label: t('payments.unitDays') },
]);
/** 续多久;null = 自定义填得不对 */
const span = computed<{ months: number; days: number } | null>(() => {
  if (choice.value !== 'custom') return { months: choice.value, days: 0 };
  const n = Number(customN.value);
  const max = customUnit.value === 'months' ? 120 : 3650;
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return customUnit.value === 'months' ? { months: n, days: 0 } : { months: 0, days: n };
});
/** 已过期 / 没填到期日的从今天起算(和后台算法一样) */
const fromToday = computed(() => props.item.expire_at < Date.now());
const until = computed(() => {
  if (!span.value) return 0;
  const base = Math.max(props.item.expire_at, Date.now());
  return span.value.months ? addMonths(base, span.value.months) : base + span.value.days * DAY;
});

/** 月成本;没填或是 0 = null(不给默认金额,也不提示「按月成本」) */
const cost = computed(() => props.item.monthly_cost || null);
const amount = ref('');
const amountTouched = ref(false);
const defaultAmount = () => (cost.value != null && span.value?.months ? String(Math.round(cost.value * span.value.months * 100) / 100) : '');
watch(
  span,
  () => {
    if (!amountTouched.value) amount.value = defaultAmount();
  },
  { immediate: true },
);
const today = () => msToDateInput(Date.now());
const paidDate = ref(today());
const note = ref('');
const amountText = computed(() => String(amount.value ?? '').trim());
const valid = computed(() => !!span.value && (amountText.value === '' || (Number.isFinite(Number(amountText.value)) && Number(amountText.value) > 0)));

/** 付款日期:今天 = 就是现在;别的日子记当天中午(按月汇总时不会因为时区落到隔壁月) */
function paidAt(): number | undefined {
  if (!paidDate.value || paidDate.value === today()) return undefined;
  const [y, m, d] = paidDate.value.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

const saving = ref(false);
async function submit() {
  if (!valid.value || saving.value || !span.value) return;
  saving.value = true;
  emit('saving', true);
  try {
    const s = span.value;
    const body = {
      ...(s.months ? { months: s.months } : { days: s.days }),
      amount: amountText.value === '' ? null : Number(amountText.value),
      paid_at: paidAt(),
      category: props.kind === 'panel' ? t('assetRenew.categoryPanel') : t('assetRenew.categorySocks'),
      // 备注没填:写上续了多久,账本里一眼看出这笔是续费
      note: note.value.trim() || (s.months ? t('payments.whatMonths', { n: s.months }) : t('payments.whatDays', { n: s.days })),
    };
    const r = props.kind === 'panel' ? await api.renewPanel(props.item.id, body) : await api.renewSocks(props.item.id, body);
    const date = fmtDate(r.expire_after);
    toast(r.entry ? t('assetRenew.donePaid', { date, v: fmtCost(r.entry.amount) }) : t('assetRenew.done', { date }));
    emit('saved', r);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
    emit('saving', false);
  }
}
</script>

<template>
  <form id="asset-renew-form" class="renew" @submit.prevent="submit">
    <p class="small now">
      <span class="muted">{{ t('payments.current') }}</span>
      <strong>{{ item.expire_at ? fmtDate(item.expire_at) : t('assetRenew.noExpire') }}</strong>
      <span v-if="item.expire_at && fromToday" class="text-err">{{ t('payments.expired') }}</span>
    </p>
    <div class="field-block">
      <span class="label">{{ t('payments.span') }}</span>
      <div class="seg" role="group" :aria-label="t('payments.span')">
        <button v-for="c in CHOICES" :key="c" type="button" :class="{ on: choice === c }" :aria-pressed="choice === c" @click="choice = c">{{ choiceLabel(c) }}</button>
      </div>
      <div v-if="choice === 'custom'" class="row custom">
        <input v-model="customN" type="number" min="1" :max="customUnit === 'months' ? 120 : 3650" step="1" required :aria-label="t('payments.customAria')" />
        <Select v-model="customUnit" :options="unitOptions" :aria-label="t('payments.unitAria')" />
      </div>
      <p v-if="until" class="small until">
        {{ t('payments.until', { date: fmtDate(until) }) }}<span v-if="fromToday" class="muted"> {{ t('payments.fromToday') }}</span>
      </p>
    </div>
    <div class="two">
      <label class="field">
        {{ t('assetRenew.amount') }}
        <input v-model="amount" type="number" min="0.01" step="0.01" :placeholder="t('assetRenew.amountPlaceholder')" @input="amountTouched = true" />
      </label>
      <label class="field">{{ t('assetRenew.paidAt') }}<input v-model="paidDate" type="date" required /></label>
    </div>
    <p class="muted small hint">
      <template v-if="cost != null && span?.months">{{ t('assetRenew.amountDefault', { cost: fmtCost(cost), n: span.months }) }}</template>
      {{ t('assetRenew.amountHint') }}
    </p>
    <label class="field">{{ t('payments.note') }}<input v-model="note" maxlength="200" :placeholder="t('assetRenew.notePlaceholder')" /></label>
  </form>
</template>

<style scoped>
.renew {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.now {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
  margin: 0;
}
.field-block .label {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-bottom: 6px;
}
.seg {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--rule);
  border-radius: 8px;
  overflow: hidden;
  background: var(--sheet);
}
.seg button {
  border: none;
  border-radius: 0;
  background: none;
  padding: 6px 12px;
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
.custom {
  margin-top: 8px;
}
.custom input {
  width: 7em;
}
.until {
  margin: 8px 0 0;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.hint {
  margin: -8px 0 0;
}
@media (max-width: 520px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
