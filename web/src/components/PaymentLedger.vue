<script setup lang="ts">
// 「收款记录」:最近 12 个月每月实收(记了钱的续费 + 单独记的收款,退款算负数),点月份看这个月的明细。
import { t } from '../i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import PaymentRows from './PaymentRows.vue';
import { fmtCost, fmtDate, monthStart } from '../format';
import { toastError } from '../toast';
import type { Payment } from '../types';

const emit = defineEmits<{ changed: [] }>();

const rows = ref<Payment[] | null>(null);
const busy = ref<number | null>(null);
const picked = ref(monthStart(Date.now()));

async function load() {
  try {
    rows.value = await api.payments(monthStart(Date.now(), -11));
  } catch (e) {
    toastError(e);
  }
}
onMounted(load);

const cents = (list: Payment[]) => list.reduce((sum, p) => sum + Math.round((p.amount ?? 0) * 100), 0) / 100;
/** 从这个月往前 12 个月 */
const months = computed(() => {
  const now = Date.now();
  return Array.from({ length: 12 }, (_, i) => {
    const from = monthStart(now, -i);
    const to = monthStart(now, -i + 1);
    const list = (rows.value ?? []).filter((p) => p.paid_at >= from && p.paid_at < to);
    const d = new Date(from);
    return { from, label: t('payments.month', { y: d.getFullYear(), m: d.getMonth() + 1, mm: String(d.getMonth() + 1).padStart(2, '0') }), rows: list, paid: list.filter((p) => p.amount != null).length, total: cents(list) };
  });
});
const max = computed(() => Math.max(1, ...months.value.map((m) => m.total)));
const yearTotal = computed(() => cents(rows.value ?? []));
const current = computed(() => months.value.find((m) => m.from === picked.value) ?? months.value[0]);

async function remove(p: Payment) {
  if (!confirm(t('payments.confirmDelete', { date: fmtDate(p.paid_at) }))) return;
  busy.value = p.id;
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
  <p class="muted small intro">{{ t('payments.ledgerIntro') }}</p>
  <p v-if="!rows" class="muted small">{{ t('common.loading') }}</p>
  <template v-else>
    <div class="table-wrap">
      <table class="months">
        <thead>
          <tr>
            <th>{{ t('payments.colMonth') }}</th>
            <th class="wide"><span class="sr-only">{{ t('payments.colTotal') }}</span></th>
            <th class="num">{{ t('payments.colCount') }}</th>
            <th class="num">{{ t('payments.colTotal') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in months" :key="m.from" :class="{ on: m.from === current.from }">
            <td>
              <button class="link" :aria-pressed="m.from === current.from" @click="picked = m.from">{{ m.label }}</button>
            </td>
            <td class="wide">
              <span class="meter"><i :style="{ width: `${(Math.max(0, m.total) / max) * 100}%` }" /></span>
            </td>
            <td class="num muted">{{ m.paid }}</td>
            <td class="num" :class="{ 'text-err': m.total < 0, muted: !m.rows.length }">{{ fmtCost(m.total) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td>{{ t('payments.yearTotal') }}</td>
            <td class="wide" />
            <td class="num muted">{{ months.reduce((n, m) => n + m.paid, 0) }}</td>
            <td class="num">
              <strong>{{ fmtCost(yearTotal) }}</strong>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <h4 class="sec">{{ current.label }}</h4>
    <p v-if="!current.rows.length" class="muted small">{{ t('payments.monthEmpty') }}</p>
    <PaymentRows v-else :rows="current.rows" show-customer :busy="busy" @remove="remove" />
  </template>
</template>

<style scoped>
.intro {
  margin: 0 0 12px;
}
.months tr.on td {
  background: var(--accent-soft);
}
.months tfoot td {
  border-top: 1px solid var(--rule);
}
.wide {
  width: 40%;
}
.meter {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: var(--rule-soft);
}
.meter i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--series-1);
}
.sec {
  margin: 18px 0 8px;
  font-size: 14px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
@media (max-width: 520px) {
  .wide {
    display: none;
  }
}
</style>
