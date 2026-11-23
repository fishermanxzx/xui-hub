<script setup lang="ts">
// 「账本」页:收款、月费、成本放在一起。
// 汇总(本月 / 上月 / 近 12 个月实收、月费合计、月成本、每月结余)→ 每月实收 → 待续费(快到期 / 已到期的客户,能直接续费)→
// 收款明细(按月份、客户、类型筛)→ 月成本明细(面板和 SOCKS)。
import { locale, t } from '../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import CustomerRenew from '../components/CustomerRenew.vue';
import Modal from '../components/Modal.vue';
import PaymentRows from '../components/PaymentRows.vue';
import Select, { type SelectOption } from '../components/Select.vue';
import { costSummary, dueClass, feeSummary, fmtCost, fmtDate, fmtDue, monthStart, stateLabel } from '../format';
import { toastError } from '../toast';
import type { Customer, Panel, Payment, Socks } from '../types';

const DAY = 86_400_000;
const customers = ref<Customer[]>([]);
const panels = ref<Panel[]>([]);
const socksList = ref<Socks[]>([]);
const payments = ref<Payment[] | null>(null);

async function load() {
  try {
    [customers.value, panels.value, socksList.value, payments.value] = await Promise.all([api.customers(), api.panels(), api.socks(), api.payments()]);
  } catch (e) {
    toastError(e);
  }
}
onMounted(load);

/** 按分加,不出 0.1 + 0.2 那种小数 */
const cents = (list: Payment[]) => list.reduce((sum, p) => sum + Math.round((p.amount ?? 0) * 100), 0) / 100;
const paidCount = (list: Payment[]) => list.filter((p) => p.amount != null).length;
const between = (from: number, to: number) => (payments.value ?? []).filter((p) => p.paid_at >= from && p.paid_at < to);
const monthLabel = (from: number) => {
  const d = new Date(from);
  return t('payments.month', { y: d.getFullYear(), m: d.getMonth() + 1, mm: String(d.getMonth() + 1).padStart(2, '0') });
};

// ---------- 汇总 ----------
const now = Date.now();
const thisMonth = computed(() => between(monthStart(now), monthStart(now, 1)));
const lastMonth = computed(() => between(monthStart(now, -1), monthStart(now)));
const lastYear = computed(() => between(monthStart(now, -11), monthStart(now, 1)));
const fees = computed(() => feeSummary(customers.value, [...panels.value, ...socksList.value]));
const costs = computed(() => costSummary([...panels.value, ...socksList.value]));

// ---------- 每月实收:最近 12 个月,点哪个月下面的明细就只看那个月 ----------
const months = computed(() =>
  Array.from({ length: 12 }, (_, i) => {
    const from = monthStart(now, -i);
    const list = between(from, monthStart(now, -i + 1));
    return { from, label: monthLabel(from), paid: paidCount(list), total: cents(list) };
  }),
);
const maxMonth = computed(() => Math.max(1, ...months.value.map((m) => m.total)));

// ---------- 收款明细 ----------
type Kind = '' | 'renew' | 'pay' | 'refund' | 'free';
const kindOf = (p: Payment): Kind => (p.amount == null ? 'free' : p.amount < 0 ? 'refund' : p.months || p.days ? 'renew' : 'pay');
/** 0 = 全部月份,否则是那个月 1 号 0 点 */
const month = ref(0);
const q = ref('');
const kind = ref<Kind>('');
const PAGE = 100;
const limit = ref(PAGE);
/** 有记录的月份,新的在前(超过 12 个月的也能选) */
const monthOptions = computed<SelectOption<number>[]>(() => {
  const seen = new Set<number>((payments.value ?? []).map((p) => monthStart(p.paid_at)));
  for (const m of months.value) seen.add(m.from);
  return [{ value: 0, label: t('ledger.allMonths') }, ...[...seen].sort((a, b) => b - a).map((from) => ({ value: from, label: monthLabel(from) }))];
});
const kindOptions = computed<SelectOption<Kind>[]>(() => [
  { value: '', label: t('ledger.allKinds') },
  { value: 'renew', label: t('ledger.kindRenew') },
  { value: 'pay', label: t('ledger.kindPay') },
  { value: 'refund', label: t('ledger.kindRefund') },
  { value: 'free', label: t('ledger.kindFree') },
]);
const filtered = computed(() => {
  const k = q.value.trim().toLowerCase();
  const end = month.value ? monthStart(month.value, 1) : 0;
  return (payments.value ?? []).filter((p) => (!month.value || (p.paid_at >= month.value && p.paid_at < end)) && (!k || p.customer_name.toLowerCase().includes(k)) && (!kind.value || kindOf(p) === kind.value));
});
const filtering = computed(() => !!month.value || !!q.value.trim() || !!kind.value);
watch([month, q, kind], () => (limit.value = PAGE));
function pickMonth(from: number) {
  month.value = month.value === from ? 0 : from;
}
const busy = ref<number | null>(null);
async function remove(p: Payment) {
  if (!confirm(t('payments.confirmDelete', { date: fmtDate(p.paid_at) }))) return;
  busy.value = p.id;
  try {
    await api.deletePayment(p.id);
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = null;
  }
}

// ---------- 待续费:7 天内到期、已经到期的客户(没设到期日的不算),先到期的在前 ----------
const due = computed(() => customers.value.filter((c) => c.expire_at > 0 && c.expire_at - now <= 7 * DAY).sort((a, b) => a.expire_at - b.expire_at));
const dueFee = computed(() => due.value.reduce((sum, c) => sum + Math.round((c.monthly_fee ?? 0) * 100), 0) / 100);
const renewFor = ref<Customer | null>(null);
async function onRenewed() {
  await load();
  if (renewFor.value) renewFor.value = customers.value.find((c) => c.id === renewFor.value!.id) ?? null;
}

// ---------- 月成本明细:填了月成本或到期日的面板和 SOCKS ----------
const costRows = computed(() =>
  [
    ...panels.value.map((p) => ({ key: `p${p.id}`, kind: t('ledger.panel'), name: p.name, cost: p.monthly_cost, expire: p.expire_at })),
    ...socksList.value.map((s) => ({ key: `s${s.id}`, kind: 'SOCKS', name: s.name, cost: s.monthly_cost, expire: s.expire_at })),
  ]
    .filter((r) => r.cost != null || r.expire)
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || a.name.localeCompare(b.name, locale.value)),
);
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>{{ t('ledger.title') }}</h2>
      <p class="muted small">{{ t('ledger.intro') }}</p>
    </div>
  </div>

  <section class="tiles">
    <div class="tile sheet">
      <span class="muted small">{{ t('ledger.thisMonth') }}</span>
      <strong>{{ fmtCost(cents(thisMonth)) }}</strong>
      <span class="muted small">{{ t('ledger.count', { n: paidCount(thisMonth) }) }}</span>
    </div>
    <div class="tile sheet">
      <span class="muted small">{{ t('ledger.lastMonth') }}</span>
      <strong>{{ fmtCost(cents(lastMonth)) }}</strong>
      <span class="muted small">{{ t('ledger.count', { n: paidCount(lastMonth) }) }}</span>
    </div>
    <div class="tile sheet">
      <span class="muted small">{{ t('ledger.year') }}</span>
      <strong>{{ fmtCost(cents(lastYear)) }}</strong>
      <span class="muted small">{{ t('ledger.count', { n: paidCount(lastYear) }) }}</span>
    </div>
    <div class="tile sheet" :title="t('ledger.feeHint')">
      <span class="muted small">{{ t('ledger.monthlyFee') }}</span>
      <strong>{{ fmtCost(fees.income) }}</strong>
      <span class="muted small">
        {{ t('ledger.feePayers', { n: fees.payers }) }}<template v-if="fees.unset"> · {{ t('ledger.feeUnset', { n: fees.unset }) }}</template><template v-if="fees.expired"> · {{ t('ledger.feeExpired', { n: fees.expired }) }}</template>
      </span>
    </div>
    <div class="tile sheet" :title="t('ledger.costHint')">
      <span class="muted small">{{ t('ledger.monthlyCost') }}</span>
      <strong>{{ fmtCost(costs.total) }}</strong>
      <span class="muted small">{{ costs.unset ? t('ledger.costUnset', { n: costs.unset }) : t('ledger.costAll') }}</span>
    </div>
    <div class="tile sheet" :title="t('ledger.balanceHint')">
      <span class="muted small">{{ t('ledger.balance') }}</span>
      <strong :class="{ 'text-err': fees.balance < 0 }">{{ fmtCost(fees.balance) }}</strong>
      <span class="muted small">{{ t('ledger.balanceHint') }}</span>
    </div>
  </section>

  <div class="two-col">
    <section class="sheet block">
      <h3>{{ t('ledger.perMonth') }}</h3>
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
            <tr v-for="m in months" :key="m.from" :class="{ on: m.from === month }">
              <td>
                <button class="link" :aria-pressed="m.from === month" :title="t('ledger.pickMonth')" @click="pickMonth(m.from)">{{ m.label }}</button>
              </td>
              <td class="wide">
                <span class="meter"><i :style="{ width: `${(Math.max(0, m.total) / maxMonth) * 100}%` }" /></span>
              </td>
              <td class="num muted">{{ m.paid }}</td>
              <td class="num" :class="{ 'text-err': m.total < 0, muted: !m.paid && !m.total }">{{ fmtCost(m.total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="sheet block">
      <h3>
        {{ t('ledger.dueTitle') }}
        <span v-if="due.length" class="muted small">{{ t('ledger.dueSum', { n: due.length, v: fmtCost(dueFee) }) }}</span>
      </h3>
      <p class="muted small sub">{{ t('ledger.dueIntro') }}</p>
      <p v-if="!due.length" class="muted small">{{ t('ledger.dueEmpty') }}</p>
      <div v-else class="table-wrap">
        <table class="due">
          <thead>
            <tr>
              <th>{{ t('ledger.colCustomer') }}</th>
              <th>{{ t('ledger.colExpire') }}</th>
              <th class="num">{{ t('ledger.colFee') }}</th>
              <th class="opt">{{ t('ledger.colLast') }}</th>
              <th class="act"><span class="sr-only">{{ t('customers.renewButton') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in due" :key="c.id">
              <td>
                {{ c.name }}<span v-if="c.state !== 'active'" class="badge" :class="c.state">{{ stateLabel(c.state) }}</span>
              </td>
              <td :class="dueClass(c.expire_at)">
                <div class="date">{{ fmtDate(c.expire_at) }}</div>
                <div class="small">{{ fmtDue(c.expire_at) }}</div>
              </td>
              <td class="num" :class="{ muted: c.monthly_fee == null }">{{ c.monthly_fee == null ? t('ledger.none') : fmtCost(c.monthly_fee) }}</td>
              <td class="muted small opt">
                <template v-if="c.last_payment">
                  <div class="date">{{ fmtDate(c.last_payment.paid_at) }}</div>
                  <div>{{ fmtCost(c.last_payment.amount) }}</div>
                </template>
                <template v-else>—</template>
              </td>
              <td class="act">
                <button class="link" @click="renewFor = c">{{ t('customers.renewButton') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <section class="sheet block">
    <h3>
      {{ t('ledger.details') }}
      <span v-if="payments" class="muted small">{{ t('ledger.filteredTotal', { v: fmtCost(cents(filtered)), n: paidCount(filtered) }) }}</span>
    </h3>
    <div class="filters">
      <Select v-model="month" :options="monthOptions" :aria-label="t('ledger.monthLabel')" />
      <input v-model="q" type="search" class="search" :placeholder="t('ledger.searchCustomer')" :aria-label="t('ledger.searchCustomer')" />
      <Select v-model="kind" :options="kindOptions" :aria-label="t('ledger.kindLabel')" />
      <button v-if="filtering" type="button" class="link" @click="(month = 0), (q = ''), (kind = '')">{{ t('ledger.clear') }}</button>
    </div>
    <p v-if="!payments" class="muted small">{{ t('common.loading') }}</p>
    <p v-else-if="!filtered.length" class="muted small">{{ payments.length ? t('ledger.emptyFiltered') : t('ledger.empty') }}</p>
    <template v-else>
      <PaymentRows :rows="filtered.slice(0, limit)" show-customer :busy="busy" @remove="remove" />
      <div v-if="filtered.length > limit" class="row more">
        <button @click="limit += PAGE">{{ t('ledger.more', { n: filtered.length - limit }) }}</button>
      </div>
    </template>
  </section>

  <section class="sheet block">
    <h3>
      {{ t('ledger.costTitle') }}
      <span class="muted small">{{ t('ledger.costTotal', { v: fmtCost(costs.total) }) }}</span>
    </h3>
    <p v-if="!costRows.length" class="muted small">{{ t('ledger.costEmpty') }}</p>
    <div v-else class="table-wrap">
      <table class="costs">
        <thead>
          <tr>
            <th>{{ t('ledger.colName') }}</th>
            <th>{{ t('ledger.colKind') }}</th>
            <th class="num">{{ t('ledger.colCost') }}</th>
            <th>{{ t('ledger.colExpire') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in costRows" :key="r.key">
            <td>{{ r.name }}</td>
            <td class="muted">{{ r.kind }}</td>
            <td class="num" :class="{ muted: r.cost == null }">{{ r.cost == null ? t('ledger.none') : fmtCost(r.cost) }}</td>
            <td :class="r.expire ? dueClass(r.expire, 'muted') : 'muted'">
              <template v-if="r.expire">{{ fmtDate(r.expire) }} · {{ fmtDue(r.expire) }}</template>
              <template v-else>—</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <Modal v-if="renewFor" :title="t('payments.title', { name: renewFor.name })" wide @close="renewFor = null">
    <CustomerRenew :customer="renewFor" @changed="onRenewed" />
  </Modal>
</template>

<style scoped>
/* 两行三格:上面一行收款,下面一行月费 / 成本 / 结余;很宽时排成一行 */
.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
@media (min-width: 1200px) {
  .tiles {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
}
.tile strong {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.two-col {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  margin-bottom: 14px;
}
@media (min-width: 1200px) {
  .two-col {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
.due td {
  vertical-align: top;
}
.two-col .block {
  margin-bottom: 0;
}
.block {
  padding: 16px;
  margin-bottom: 14px;
}
.block h3 {
  margin: 0 0 10px;
  font-size: 15px;
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
}
.sub {
  margin: -6px 0 10px;
}
.months tr.on td {
  background: var(--accent-soft);
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
.date {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.badge {
  margin-left: 6px;
}
.badge.expired,
.badge.over_quota {
  background: var(--caution-bg);
  color: var(--caution);
}
.act {
  width: 1%;
  text-align: right;
  white-space: nowrap;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  margin-bottom: 12px;
}
.search {
  flex: 1 1 180px;
  max-width: 260px;
}
.more {
  justify-content: center;
  margin-top: 12px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
@media (max-width: 640px) {
  .wide,
  .opt {
    display: none;
  }
  .block {
    padding: 12px;
  }
  .due th,
  .due td,
  .months th,
  .months td,
  .costs th,
  .costs td {
    padding-left: 6px;
    padding-right: 6px;
  }
  .tile strong {
    font-size: 18px;
  }
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
