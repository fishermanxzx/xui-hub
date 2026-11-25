<script setup lang="ts">
// 「账本」页:收支、月费、成本放在一起。收入 = 客户的续费 / 收款(退款算负数)+ 自己记的收入;支出 = 自己记的(如买服务器)。
// 汇总(本月 / 上月 / 近 12 个月净收入、月费合计、月成本、每月结余)→ 每月收支 → 待续费(快到期 / 已到期的客户,能直接续费)→
// 收支明细(按月份、客户 / 面板 / 类别、类型筛)→ 月成本明细(面板和 SOCKS)。右上角「记一笔」自己记收入 / 支出。
import { locale, t } from '../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import CustomerRenew from '../components/CustomerRenew.vue';
import LedgerEntryForm from '../components/LedgerEntryForm.vue';
import Modal from '../components/Modal.vue';
import PaymentEditForm from '../components/PaymentEditForm.vue';
import PaymentRows from '../components/PaymentRows.vue';
import Select, { type SelectOption } from '../components/Select.vue';
import { costSummary, dueClass, feeSummary, fmtCost, fmtDate, fmtDue, monthStart, stateLabel } from '../format';
import { isEntry, rowAt, rowCents, rowKey, type LedgerRow } from '../ledgerRows';
import { toastError } from '../toast';
import type { Customer, LedgerEntry, Panel, Payment, Socks } from '../types';

const DAY = 86_400_000;
const customers = ref<Customer[]>([]);
const panels = ref<Panel[]>([]);
const socksList = ref<Socks[]>([]);
const payments = ref<Payment[] | null>(null);
const entries = ref<LedgerEntry[] | null>(null);

async function load() {
  try {
    [customers.value, panels.value, socksList.value, payments.value, entries.value] = await Promise.all([api.customers(), api.panels(), api.socks(), api.payments(), api.ledger()]);
  } catch (e) {
    toastError(e);
  }
}
onMounted(load);

/** 客户的收款和自己记的收入 / 支出合在一起,新的在前 */
const rows = computed<LedgerRow[] | null>(() => (payments.value && entries.value ? [...payments.value, ...entries.value].sort((a, b) => rowAt(b) - rowAt(a) || b.created_at - a.created_at) : null));
/** 收入 / 支出 / 净收入,按分加(不出 0.1 + 0.2 那种小数);退款算负的收入。n = 笔数(只续期没记钱的不算) */
function sums(list: LedgerRow[]) {
  let income = 0;
  let expense = 0;
  let n = 0;
  for (const r of list) {
    if (isEntry(r) && r.kind === 'expense') expense -= rowCents(r);
    else income += rowCents(r);
    if (isEntry(r) || r.amount != null) n++;
  }
  return { income: income / 100, expense: expense / 100, net: (income - expense) / 100, n };
}
const between = (from: number, to: number) => (rows.value ?? []).filter((r) => rowAt(r) >= from && rowAt(r) < to);
const monthLabel = (from: number) => {
  const d = new Date(from);
  return t('payments.month', { y: d.getFullYear(), m: d.getMonth() + 1, mm: String(d.getMonth() + 1).padStart(2, '0') });
};

// ---------- 汇总 ----------
const now = Date.now();
const periods = computed(() => [
  { key: 'this', label: t('ledger.thisMonth'), ...sums(between(monthStart(now), monthStart(now, 1))) },
  { key: 'last', label: t('ledger.lastMonth'), ...sums(between(monthStart(now, -1), monthStart(now))) },
  { key: 'year', label: t('ledger.year'), ...sums(between(monthStart(now, -11), monthStart(now, 1))) },
]);
const fees = computed(() => feeSummary(customers.value, [...panels.value, ...socksList.value]));
const costs = computed(() => costSummary([...panels.value, ...socksList.value]));

// ---------- 每月收支:最近 12 个月,点哪个月下面的明细就只看那个月 ----------
const months = computed(() =>
  Array.from({ length: 12 }, (_, i) => {
    const from = monthStart(now, -i);
    return { from, label: monthLabel(from), ...sums(between(from, monthStart(now, -i + 1))) };
  }),
);
/** 这 12 个月记过支出才画支出的条 */
const hasExpense = computed(() => months.value.some((m) => m.expense > 0));
const maxMonth = computed(() => Math.max(1, ...months.value.map((m) => Math.max(m.income, m.expense))));
const pct = (v: number) => `${(Math.max(0, v) / maxMonth.value) * 100}%`;

// ---------- 收支明细 ----------
type Kind = '' | 'renew' | 'pay' | 'refund' | 'free' | 'income' | 'expense';
const kindOf = (r: LedgerRow): Kind => (isEntry(r) ? r.kind : r.amount == null ? 'free' : r.amount < 0 ? 'refund' : r.months || r.days ? 'renew' : 'pay');
/** 搜索比对的文字:客户名、备注;自己记的还有类别、关联的客户 / 面板 / SOCKS 的名字 */
const textOf = (r: LedgerRow) => (isEntry(r) ? [r.category, r.customer_name, r.panel_name, r.socks_name, r.note] : [r.customer_name, r.note]).join('\n').toLowerCase();
/** 0 = 全部月份,否则是那个月 1 号 0 点 */
const month = ref(0);
const q = ref('');
const kind = ref<Kind>('');
const PAGE = 100;
const limit = ref(PAGE);
/** 有记录的月份,新的在前(超过 12 个月的也能选) */
const monthOptions = computed<SelectOption<number>[]>(() => {
  const seen = new Set<number>((rows.value ?? []).map((r) => monthStart(rowAt(r))));
  for (const m of months.value) seen.add(m.from);
  return [{ value: 0, label: t('ledger.allMonths') }, ...[...seen].sort((a, b) => b - a).map((from) => ({ value: from, label: monthLabel(from) }))];
});
const kindOptions = computed<SelectOption<Kind>[]>(() => [
  { value: '', label: t('ledger.allKinds') },
  { value: 'renew', label: t('ledger.kindRenew') },
  { value: 'pay', label: t('ledger.kindPay') },
  { value: 'refund', label: t('ledger.kindRefund') },
  { value: 'free', label: t('ledger.kindFree') },
  { value: 'income', label: t('ledger.kindIncome') },
  { value: 'expense', label: t('ledger.kindExpense') },
]);
const filtered = computed(() => {
  const k = q.value.trim().toLowerCase();
  const end = month.value ? monthStart(month.value, 1) : 0;
  return (rows.value ?? []).filter((r) => (!month.value || (rowAt(r) >= month.value && rowAt(r) < end)) && (!k || textOf(r).includes(k)) && (!kind.value || kindOf(r) === kind.value));
});
const filteredSums = computed(() => sums(filtered.value));
const filtering = computed(() => !!month.value || !!q.value.trim() || !!kind.value);
watch([month, q, kind], () => (limit.value = PAGE));
function pickMonth(from: number) {
  month.value = month.value === from ? 0 : from;
}
const busy = ref<string | null>(null);
async function remove(r: LedgerRow) {
  const ask = isEntry(r) ? t('ledger.confirmDeleteEntry', { date: fmtDate(r.at), what: t(r.kind === 'expense' ? 'entry.expense' : 'entry.income'), v: fmtCost(r.amount) }) : t('payments.confirmDelete', { date: fmtDate(r.paid_at) });
  if (!confirm(ask)) return;
  busy.value = rowKey(r);
  try {
    await (isEntry(r) ? api.deleteLedgerEntry(r.id) : api.deletePayment(r.id));
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = null;
  }
}

// ---------- 改一笔:自己记的收入 / 支出改全部字段,续费 / 收款改金额、日期、备注 ----------
const editing = ref<LedgerRow | null>(null);
const editSaving = ref(false);
async function onEdited() {
  editing.value = null;
  await load();
}

// ---------- 待续费:7 天内到期、已经到期的客户(没设到期日的不算),先到期的在前 ----------
const due = computed(() => customers.value.filter((c) => c.expire_at > 0 && c.expire_at - now <= 7 * DAY).sort((a, b) => a.expire_at - b.expire_at));
const dueFee = computed(() => due.value.reduce((sum, c) => sum + Math.round((c.monthly_fee ?? 0) * 100), 0) / 100);
const renewFor = ref<Customer | null>(null);
async function onRenewed() {
  await load();
  if (renewFor.value) renewFor.value = customers.value.find((c) => c.id === renewFor.value!.id) ?? null;
}

// ---------- 记一笔:自己记的收入 / 支出 ----------
const adding = ref(false);
const addSaving = ref(false);
async function onAdded() {
  adding.value = false;
  await load();
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
  <header class="page-head">
    <div class="ph-main">
      <h1>{{ t('ledger.title') }}</h1>
      <details class="about">
        <summary>{{ t('common.about') }}</summary>
        <p>{{ t('ledger.intro') }}</p>
      </details>
    </div>
    <div class="ph-actions">
      <button class="primary" @click="adding = true">{{ t('ledger.add') }}</button>
    </div>
  </header>

  <section class="tiles">
    <div v-for="p in periods" :key="p.key" class="tile sheet" :title="t('ledger.netHint')">
      <span class="muted small">{{ p.label }}</span>
      <strong :class="{ 'text-err': p.net < 0 }">{{ fmtCost(p.net) }}</strong>
      <span class="muted small">{{ t('ledger.inOut', { i: fmtCost(p.income), e: fmtCost(p.expense) }) }}</span>
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
      <h3>
        {{ t('ledger.perMonth') }}
        <span v-if="hasExpense" class="legend muted small" aria-hidden="true"><i class="sw in" />{{ t('ledger.colIncome') }}<i class="sw out" />{{ t('ledger.colExpense') }}</span>
      </h3>
      <div class="table-wrap">
        <table class="months">
          <thead>
            <tr>
              <th>{{ t('payments.colMonth') }}</th>
              <th class="wide"><span class="sr-only">{{ t('ledger.colIncome') }}</span></th>
              <th class="num">{{ t('ledger.colIncome') }}</th>
              <th class="num">{{ t('ledger.colExpense') }}</th>
              <th class="num">{{ t('ledger.colNet') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in months" :key="m.from" :class="{ on: m.from === month }">
              <td>
                <button class="link" :aria-pressed="m.from === month" :title="t('ledger.pickMonth')" @click="pickMonth(m.from)">{{ m.label }}</button>
              </td>
              <td class="wide">
                <span class="bars" :class="{ two: hasExpense }">
                  <span class="meter"><i :style="{ width: pct(m.income) }" /></span>
                  <span v-if="hasExpense" class="meter out"><i :style="{ width: pct(m.expense) }" /></span>
                </span>
              </td>
              <td class="num" :class="{ muted: !m.income, 'text-err': m.income < 0 }" :title="t('ledger.count', { n: m.n })">{{ fmtCost(m.income) }}</td>
              <td class="num" :class="{ muted: !m.expense }">{{ fmtCost(m.expense) }}</td>
              <td class="num" :class="{ 'text-err': m.net < 0, muted: !m.n }">{{ fmtCost(m.net) }}</td>
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
      <span v-if="rows" class="muted small">
        {{ filteredSums.expense ? t('ledger.filteredInOut', { i: fmtCost(filteredSums.income), e: fmtCost(filteredSums.expense), v: fmtCost(filteredSums.net), n: filteredSums.n }) : t('ledger.filteredTotal', { v: fmtCost(filteredSums.income), n: filteredSums.n }) }}
      </span>
    </h3>
    <div class="filters">
      <Select v-model="month" :options="monthOptions" :aria-label="t('ledger.monthLabel')" />
      <input v-model="q" type="search" class="search" :placeholder="t('ledger.searchCustomer')" :aria-label="t('ledger.searchCustomer')" />
      <Select v-model="kind" :options="kindOptions" :aria-label="t('ledger.kindLabel')" />
      <button v-if="filtering" type="button" class="link" @click="(month = 0), (q = ''), (kind = '')">{{ t('ledger.clear') }}</button>
    </div>
    <p v-if="!rows" class="muted small">{{ t('common.loading') }}</p>
    <p v-else-if="!filtered.length" class="muted small">{{ rows.length ? t('ledger.emptyFiltered') : t('ledger.empty') }}</p>
    <template v-else>
      <PaymentRows :rows="filtered.slice(0, limit)" show-customer :busy="busy" @edit="(r) => (editing = r)" @remove="remove" />
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

  <Modal v-if="adding" :title="t('entry.title')" @close="adding = false">
    <LedgerEntryForm :entries="entries ?? []" :customers="customers" :panels="panels" :socks="socksList" @saved="onAdded" @saving="(b) => (addSaving = b)" />
    <template #footer>
      <span class="spacer" />
      <button @click="adding = false">{{ t('common.cancel') }}</button>
      <button class="primary" form="ledger-entry-form" :disabled="addSaving">{{ addSaving ? t('common.saving') : t('entry.submit') }}</button>
    </template>
  </Modal>

  <Modal v-if="editing" :title="isEntry(editing) ? t('entry.editTitle') : t('payments.editTitle', { name: editing.customer_name })" @close="editing = null">
    <LedgerEntryForm v-if="isEntry(editing)" :entry="editing" :entries="entries ?? []" :customers="customers" :panels="panels" :socks="socksList" @saved="onEdited" @saving="(b) => (editSaving = b)" />
    <PaymentEditForm v-else :payment="editing" @saved="onEdited" @saving="(b) => (editSaving = b)" />
    <template #footer>
      <span class="spacer" />
      <button @click="editing = null">{{ t('common.cancel') }}</button>
      <button class="primary" :form="isEntry(editing) ? 'ledger-entry-form' : 'payment-edit-form'" :disabled="editSaving">{{ editSaving ? t('common.saving') : t('common.save') }}</button>
    </template>
  </Modal>

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
/* 有支出时收入、支出两根细条叠着,中间留 2px */
.bars {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bars.two .meter {
  height: 4px;
}
.meter.out i {
  background: var(--series-2);
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 400;
}
.sw {
  display: inline-block;
  width: 10px;
  height: 4px;
  border-radius: 2px;
  margin-left: 6px;
}
.sw.in {
  background: var(--series-1);
}
.sw.out {
  background: var(--series-2);
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
  .opt,
  .legend {
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
