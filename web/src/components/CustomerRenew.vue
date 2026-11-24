<script setup lang="ts">
// 客户的「续费」弹窗:按月 / 按天续期,顺手记一笔收款;也可以只记收款(或退款)。下面是这位客户的续费 / 收款记录。
import { t } from '../i18n';
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import PaymentRows from './PaymentRows.vue';
import { isEntry, rowKey, type LedgerRow } from '../ledgerRows';
import Select, { type SelectOption } from './Select.vue';
import { addMonths, fmtCost, fmtDate, msToDateInput } from '../format';
import { toast, toastError } from '../toast';
import type { Customer, Payment } from '../types';

const props = defineProps<{ customer: Customer }>();
const emit = defineEmits<{ changed: [] }>();

const DAY = 86_400_000;
type Choice = 1 | 3 | 6 | 12 | 'custom' | 'none';
const CHOICES: Choice[] = [1, 3, 6, 12, 'custom', 'none'];
const choiceLabel = (c: Choice) => (c === 'custom' ? t('payments.custom') : c === 'none' ? t('payments.none') : c === 12 ? t('payments.year') : t('payments.months', { n: c }));

const choice = ref<Choice>(1);
const customN = ref('2');
const customUnit = ref<'months' | 'days'>('months');
const unitOptions = computed<SelectOption<'months' | 'days'>[]>(() => [
  { value: 'months', label: t('payments.unitMonths') },
  { value: 'days', label: t('payments.unitDays') },
]);
/** 续多久;null = 不续期 / 自定义填得不对 */
const span = computed<{ months: number; days: number } | null>(() => {
  if (choice.value === 'none') return null;
  if (choice.value !== 'custom') return { months: choice.value, days: 0 };
  const n = Number(customN.value);
  const max = customUnit.value === 'months' ? 120 : 3650;
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return customUnit.value === 'months' ? { months: n, days: 0 } : { months: 0, days: n };
});
const fromToday = computed(() => props.customer.expire_at < Date.now());
const until = computed(() => {
  if (!span.value) return 0;
  const base = Math.max(props.customer.expire_at, Date.now());
  return span.value.months ? addMonths(base, span.value.months) : base + span.value.days * DAY;
});

// 金额:默认月费 × 月数,自己改过就不再跟着变
const fee = computed(() => props.customer.monthly_fee);
const amount = ref('');
const amountTouched = ref(false);
const defaultAmount = () => (fee.value != null && span.value?.months ? String(Math.round(fee.value * span.value.months * 100) / 100) : '');
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
const resetUsage = ref(false);
const saving = ref(false);

const renewing = computed(() => choice.value !== 'none');
const amountText = computed(() => String(amount.value ?? '').trim());
const canSubmit = computed(() => !saving.value && (renewing.value ? !!span.value : amountText.value !== '' && Number.isFinite(Number(amountText.value))));

/** 收款日期:今天 = 就是现在;别的日子记当天中午(按月汇总时不会因为时区落到隔壁月) */
function paidAt(): number | undefined {
  if (!paidDate.value || paidDate.value === today()) return undefined;
  const [y, m, d] = paidDate.value.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    const money = amountText.value === '' ? null : Number(amountText.value);
    if (span.value) {
      const r = await api.renew(props.customer.id, { ...(span.value.months ? { months: span.value.months } : { days: span.value.days }), amount: money, paid_at: paidAt(), note: note.value, reset_usage: renewing.value && resetUsage.value });
      const date = fmtDate(r.expire_at);
      const bad = r.ops.filter((o) => !o.ok).length + r.failed.length;
      toast(money == null ? t('payments.renewed', { date }) : t('payments.renewedPaid', { date, v: fmtCost(money) }), bad ? 'err' : 'ok');
    } else {
      await api.addPayment(props.customer.id, { amount: money!, paid_at: paidAt(), note: note.value });
      toast(t('payments.paid', { v: fmtCost(money!) }));
    }
    note.value = '';
    resetUsage.value = false;
    amountTouched.value = false;
    amount.value = defaultAmount();
    emit('changed');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

// ---------- 记录 ----------
const rows = ref<Payment[] | null>(null);
const busy = ref<string | null>(null);
async function load() {
  try {
    rows.value = await api.customerPayments(props.customer.id);
  } catch (e) {
    toastError(e);
  }
}
watch(() => props.customer.id, load, { immediate: true });
const paidTotal = computed(() => {
  const list = (rows.value ?? []).filter((p) => p.amount != null);
  return { n: list.length, v: list.reduce((sum, p) => sum + Math.round(p.amount! * 100), 0) / 100 };
});
async function remove(p: LedgerRow) {
  // 这里只有这位客户的收款记录,没有自己记的收入 / 支出
  if (isEntry(p) || !confirm(t('payments.confirmDelete', { date: fmtDate(p.paid_at) }))) return;
  busy.value = rowKey(p);
  try {
    await api.deletePayment(p.id);
    emit('changed');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <form class="renew" @submit.prevent="submit">
    <p class="small now">
      <span class="muted">{{ t('payments.current') }}</span>
      <strong>{{ fmtDate(customer.expire_at) }}</strong>
      <span v-if="customer.expire_at && fromToday" class="text-err">{{ t('payments.expired') }}</span>
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
        {{ t('payments.until', { date: fmtDate(until) }) }}<span v-if="fromToday || !customer.expire_at" class="muted"> {{ t('payments.fromToday') }}</span>
      </p>
    </div>
    <div class="two">
      <label class="field">
        {{ t('payments.amount') }}
        <input v-model="amount" type="number" step="0.01" :required="!renewing" :placeholder="renewing ? t('payments.amountPlaceholder') : ''" @input="amountTouched = true" />
      </label>
      <label class="field">{{ t('payments.paidAt') }}<input v-model="paidDate" type="date" required /></label>
    </div>
    <p class="muted small hint">
      <template v-if="renewing && fee != null && span?.months">{{ t('payments.amountDefault', { fee: fmtCost(fee), n: span.months }) }}</template>
      {{ renewing ? t('payments.amountHint') : t('payments.refundHint') }}
    </p>
    <label class="field">{{ t('payments.note') }}<input v-model="note" maxlength="200" :placeholder="t('payments.notePlaceholder')" /></label>
    <label v-if="renewing" class="row small check"><input v-model="resetUsage" type="checkbox" />{{ t('payments.resetUsage') }}</label>
    <div class="row actions">
      <button class="primary" :disabled="!canSubmit">{{ saving ? t('common.saving') : renewing ? t('payments.submitRenew') : t('payments.submitPay') }}</button>
    </div>
  </form>

  <h4 class="sec">
    {{ t('payments.history') }}
    <span v-if="paidTotal.n" class="muted small">{{ t('payments.total', { v: fmtCost(paidTotal.v), n: paidTotal.n }) }}</span>
  </h4>
  <p v-if="rows && !rows.length" class="muted small">{{ t('payments.empty') }}</p>
  <PaymentRows v-else-if="rows" :rows="rows" :busy="busy" @remove="remove" />
  <p v-else class="muted small">{{ t('common.loading') }}</p>
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
.check {
  gap: 8px;
}
.actions {
  justify-content: flex-end;
}
.sec {
  margin: 22px 0 8px;
  font-size: 14px;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
@media (max-width: 520px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
