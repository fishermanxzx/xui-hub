<script setup lang="ts">
// 改一笔续费 / 收款记录:金额、收款日期、备注。只改记录,客户的到期日不会跟着变;续了多久不能改。
// 放在 Modal 里用,底部按钮用 form="payment-edit-form" 提交。
import { t } from '../i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { fmtDate, msToDateInput } from '../format';
import { toast, toastError } from '../toast';
import type { Payment } from '../types';

const props = defineProps<{ payment: Payment }>();
const emit = defineEmits<{ saved: [p: Payment]; saving: [busy: boolean] }>();

const p0 = props.payment;
const renewed = p0.months > 0 || p0.days > 0;
const what = p0.months ? t('payments.whatMonths', { n: p0.months }) : p0.days ? t('payments.whatDays', { n: p0.days }) : t('payments.whatPay');
const amount = ref(p0.amount == null ? '' : String(p0.amount));
const day = ref(msToDateInput(p0.paid_at));
const note = ref(p0.note);
const amountText = computed(() => String(amount.value ?? '').trim());
// 只记收款的那种金额不能空;续期的可以空(只续期没记钱)
const valid = computed(() => (amountText.value === '' ? renewed : Number.isFinite(Number(amountText.value))) && !!day.value);
const amountInput = ref<HTMLInputElement | null>(null);
onMounted(() => amountInput.value?.focus());

/** 日子没动就照旧;改了记那天中午(按月汇总时不会因为时区落到隔壁月) */
function paidAt(): number {
  if (day.value === msToDateInput(p0.paid_at)) return p0.paid_at;
  const [y, m, d] = day.value.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

const saving = ref(false);
async function submit() {
  if (!valid.value || saving.value) return;
  saving.value = true;
  emit('saving', true);
  try {
    const p = await api.updatePayment(p0.id, { amount: amountText.value === '' ? null : Number(amountText.value), paid_at: paidAt(), note: note.value });
    toast(t('payments.updated'));
    emit('saved', p);
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
    emit('saving', false);
  }
}
</script>

<template>
  <form id="payment-edit-form" class="pay-edit" @submit.prevent="submit">
    <p class="small what">
      <strong>{{ what }}</strong>
      <span v-if="renewed" class="muted">{{ t('payments.expireChange', { from: fmtDate(p0.expire_before), to: fmtDate(p0.expire_after) }) }}</span>
    </p>
    <div class="two">
      <label class="field">
        {{ t('payments.amount') }}
        <input ref="amountInput" v-model="amount" type="number" step="0.01" :required="!renewed" />
      </label>
      <label class="field">{{ t('payments.paidAt') }}<input v-model="day" type="date" required /></label>
    </div>
    <p class="muted small hint">{{ renewed ? t('payments.editAmountHint') : t('payments.refundHint') }}</p>
    <label class="field">{{ t('payments.note') }}<input v-model="note" maxlength="200" /></label>
    <p class="muted small hint">{{ t('payments.editHint') }}</p>
  </form>
</template>

<style scoped>
.pay-edit {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.what {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.hint {
  margin: 0;
}
@media (max-width: 520px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
