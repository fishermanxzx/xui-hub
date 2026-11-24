<script setup lang="ts">
// 续费 / 收款记录的表格:客户的续费弹窗和账本页的「收支明细」共用。
// 还混着自己记的收入 / 支出(LedgerEntry,有 kind):支出前面带「−」;客户那一列显示关联的客户(没关联显示类别),
// 关联的面板 / SOCKS 写在「内容」里。客户的续费弹窗里没有客户那一列,类别也写在「内容」里。
import { t } from '../i18n';
import { fmtCost, fmtDate } from '../format';
import { isEntry, rowAt, rowKey, type LedgerRow } from '../ledgerRows';
import type { LedgerEntry, Payment } from '../types';

/** busy:正在删的那一行的 rowKey */
defineProps<{ rows: LedgerRow[]; showCustomer?: boolean; busy?: string | null }>();
const emit = defineEmits<{ remove: [r: LedgerRow] }>();

const what = (p: Payment) => (p.months ? t('payments.whatMonths', { n: p.months }) : p.days ? t('payments.whatDays', { n: p.days }) : t('payments.whatPay'));
const renewed = (p: Payment) => p.months > 0 || p.days > 0;
/** 关联的面板 / SOCKS:没关联 = null */
const target = (e: LedgerEntry) =>
  e.panel_id != null ? { label: t('entry.linkPanel', { name: e.panel_name }), deleted: e.panel_deleted } : e.socks_id != null ? { label: t('entry.linkSocks', { name: e.socks_name }), deleted: e.socks_deleted } : null;
</script>

<template>
  <div class="table-wrap">
    <table class="pay-rows">
      <thead>
        <tr>
          <th>{{ t('payments.colDate') }}</th>
          <th v-if="showCustomer">{{ t('payments.colCustomerOrCategory') }}</th>
          <th class="num">{{ t('payments.colAmount') }}</th>
          <th>{{ t('payments.colWhat') }}</th>
          <th class="act"><span class="sr-only">{{ t('common.delete') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="rowKey(r)">
          <td class="date">{{ fmtDate(rowAt(r)) }}</td>
          <template v-if="isEntry(r)">
            <td v-if="showCustomer && r.customer_id != null">
              <div>
                {{ r.customer_name }}<span v-if="r.customer_deleted" class="badge warn">{{ t('payments.customerDeleted') }}</span>
              </div>
              <div v-if="r.category" class="muted small">{{ r.category }}</div>
            </td>
            <td v-else-if="showCustomer" :class="{ muted: !r.category }">{{ r.category || '—' }}</td>
            <td class="num">{{ r.kind === 'expense' ? `−${fmtCost(r.amount)}` : fmtCost(r.amount) }}</td>
            <td>
              <div class="what">
                <span>{{ r.kind === 'expense' ? t('payments.whatExpense') : t('payments.whatIncome') }}<template v-if="!showCustomer && r.category"> · {{ r.category }}</template></span>
                <span v-if="target(r)" class="muted small">
                  {{ target(r)!.label }}<span v-if="target(r)!.deleted" class="badge warn">{{ t('payments.customerDeleted') }}</span>
                </span>
                <span v-if="r.note" class="muted small note">{{ r.note }}</span>
              </div>
            </td>
          </template>
          <template v-else>
            <td v-if="showCustomer">
              {{ r.customer_name }}<span v-if="r.customer_deleted" class="badge warn">{{ t('payments.customerDeleted') }}</span>
            </td>
            <td class="num">
              <span v-if="r.amount == null" class="muted" :title="t('payments.noAmountHint')">—</span>
              <span v-else :class="{ 'text-err': r.amount < 0 }">{{ fmtCost(r.amount) }}</span>
            </td>
            <td>
              <div class="what">
                <span>{{ what(r) }}</span>
                <span v-if="renewed(r)" class="muted small">{{ t('payments.expireChange', { from: fmtDate(r.expire_before), to: fmtDate(r.expire_after) }) }}</span>
                <span v-if="r.note" class="muted small note">{{ r.note }}</span>
              </div>
            </td>
          </template>
          <td class="act">
            <button class="link danger small" :disabled="busy === rowKey(r)" @click="emit('remove', r)">{{ t('common.delete') }}</button>
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
