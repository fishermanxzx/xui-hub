<script setup lang="ts">
// 续费 / 收款记录的表格:客户的续费弹窗和「收款记录」共用。
import { t } from '../i18n';
import { fmtCost, fmtDate } from '../format';
import type { Payment } from '../types';

defineProps<{ rows: Payment[]; showCustomer?: boolean; busy?: number | null }>();
const emit = defineEmits<{ remove: [p: Payment] }>();

const what = (p: Payment) => (p.months ? t('payments.whatMonths', { n: p.months }) : p.days ? t('payments.whatDays', { n: p.days }) : t('payments.whatPay'));
const renewed = (p: Payment) => p.months > 0 || p.days > 0;
</script>

<template>
  <div class="table-wrap">
    <table class="pay-rows">
      <thead>
        <tr>
          <th>{{ t('payments.colDate') }}</th>
          <th v-if="showCustomer">{{ t('payments.colCustomer') }}</th>
          <th class="num">{{ t('payments.colAmount') }}</th>
          <th>{{ t('payments.colWhat') }}</th>
          <th class="act"><span class="sr-only">{{ t('common.delete') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in rows" :key="p.id">
          <td class="date">{{ fmtDate(p.paid_at) }}</td>
          <td v-if="showCustomer">
            {{ p.customer_name }}<span v-if="p.customer_deleted" class="badge warn">{{ t('payments.customerDeleted') }}</span>
          </td>
          <td class="num">
            <span v-if="p.amount == null" class="muted" :title="t('payments.noAmountHint')">—</span>
            <span v-else :class="{ 'text-err': p.amount < 0 }">{{ fmtCost(p.amount) }}</span>
          </td>
          <td>
            <div class="what">
              <span>{{ what(p) }}</span>
              <span v-if="renewed(p)" class="muted small">{{ t('payments.expireChange', { from: fmtDate(p.expire_before), to: fmtDate(p.expire_after) }) }}</span>
              <span v-if="p.note" class="muted small note">{{ p.note }}</span>
            </div>
          </td>
          <td class="act">
            <button class="link danger small" :disabled="busy === p.id" @click="emit('remove', p)">{{ t('common.delete') }}</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.pay-rows td {
  vertical-align: top;
}
.date {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.what {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 8em;
}
.note {
  overflow-wrap: anywhere;
}
.act {
  width: 1%;
  text-align: right;
  white-space: nowrap;
}
.badge {
  margin-left: 6px;
}
@media (max-width: 520px) {
  .pay-rows th,
  .pay-rows td {
    padding-left: 4px;
    padding-right: 4px;
  }
  .pay-rows .date {
    font-size: 12px;
  }
  .what {
    min-width: 6em;
  }
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
