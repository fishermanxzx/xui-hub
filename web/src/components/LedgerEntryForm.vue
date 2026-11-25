<script setup lang="ts">
// 自己记一笔收入或支出(客户续费在客户的「续费」里记);给了 entry 就是改这一笔。
// 可以关联一块面板或一个 SOCKS,收入还可以关联客户,都可以不选。
// 放在 Modal 里用,底部按钮用 form="ledger-entry-form" 提交。
// 客户 / 面板 / SOCKS 列表没传进来时自己去取(在客户的续费弹窗里改一笔时)。
import { locale, t } from '../i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import Select, { type SelectOption } from './Select.vue';
import { fmtCost, msToDateInput } from '../format';
import { toast, toastError } from '../toast';
import type { Customer, EntryKind, LedgerEntry, Panel, Socks } from '../types';

const props = defineProps<{ entry?: LedgerEntry; entries?: LedgerEntry[]; customers?: Customer[]; panels?: Panel[]; socks?: Socks[] }>();
const emit = defineEmits<{ saved: [e: LedgerEntry]; saving: [busy: boolean] }>();

const e0 = props.entry;
const kind = ref<EntryKind>(e0?.kind ?? 'expense');
const amount = ref(e0 ? String(e0.amount) : '');
const today = () => msToDateInput(Date.now());
const day = ref(e0 ? msToDateInput(e0.at) : today());
const category = ref(e0?.category ?? '');
const note = ref(e0?.note ?? '');
/** 关联的面板 / SOCKS:'' = 不关联,p<id> = 面板,s<id> = SOCKS */
const link = ref(e0?.panel_id != null ? `p${e0.panel_id}` : e0?.socks_id != null ? `s${e0.socks_id}` : '');
/** 关联的客户(只有收入):0 = 不关联 */
const customer = ref(e0?.customer_id ?? 0);

const entryList = ref<LedgerEntry[]>(props.entries ?? []);
const customerList = ref<Customer[]>(props.customers ?? []);
const panelList = ref<Panel[]>(props.panels ?? []);
const socksList = ref<Socks[]>(props.socks ?? []);
async function loadLists() {
  try {
    await Promise.all([
      props.entries ? null : api.ledger().then((v) => (entryList.value = v)),
      props.customers ? null : api.customers().then((v) => (customerList.value = v)),
      props.panels ? null : api.panels().then((v) => (panelList.value = v)),
      props.socks ? null : api.socks().then((v) => (socksList.value = v)),
    ]);
  } catch (err) {
    toastError(err);
  }
}

const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, locale.value));
/** 改的这笔原来关联的东西已经删了:也列出来(标上已删除),不然下拉框里没有它 */
const gone = (id: number | null | undefined, deleted: boolean | undefined, name = '') => (id != null && deleted ? [{ id, name: `${name}${t('entry.deletedMark')}` }] : []);
const linkOptions = computed<SelectOption<string>[]>(() => [
  { value: '', label: t('entry.linkNone') },
  ...byName(panelList.value).map((p) => ({ value: `p${p.id}`, label: t('entry.linkPanel', { name: p.name }) })),
  ...gone(e0?.panel_id, e0?.panel_deleted, e0?.panel_name).map((x) => ({ value: `p${x.id}`, label: t('entry.linkPanel', { name: x.name }) })),
  ...byName(socksList.value).map((s) => ({ value: `s${s.id}`, label: t('entry.linkSocks', { name: s.name }) })),
  ...gone(e0?.socks_id, e0?.socks_deleted, e0?.socks_name).map((x) => ({ value: `s${x.id}`, label: t('entry.linkSocks', { name: x.name }) })),
]);
const customerOptions = computed<SelectOption<number>[]>(() => [
  { value: 0, label: t('entry.linkNone') },
  ...byName(customerList.value).map((c) => ({ value: c.id, label: c.name })),
  ...gone(e0?.customer_id, e0?.customer_deleted, e0?.customer_name).map((x) => ({ value: x.id, label: x.name })),
]);
const amountInput = ref<HTMLInputElement | null>(null);
// 弹窗是后插进页面的,autofocus 不生效,打开时手动聚焦金额
onMounted(() => {
  amountInput.value?.focus();
  loadLists();
});

/** 类别的候选:以前记过的(同一类的在前、用得多的在前),再补几个常用的 */
const suggestions = computed(() => {
  const count = new Map<string, number>();
  for (const e of entryList.value) if (e.category && e.kind === kind.value) count.set(e.category, (count.get(e.category) ?? 0) + 1);
  const used = [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)!);
  const preset = (kind.value === 'expense' ? t('entry.presetExpense') : t('entry.presetIncome')).split(',');
  return [...new Set([...used, ...preset])];
});

const value = computed(() => Number(String(amount.value ?? '').trim()));
const valid = computed(() => String(amount.value ?? '').trim() !== '' && Number.isFinite(value.value) && value.value > 0);

/** 日期:今天 = 就是现在;别的日子记当天中午(按月汇总时不会因为时区落到隔壁月)。改一笔时日子没动就照旧 */
function at(): number | undefined {
  if (e0 && day.value === msToDateInput(e0.at)) return e0.at;
  if (!day.value || (!e0 && day.value === today())) return undefined;
  const [y, m, d] = day.value.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

const saving = ref(false);
async function submit() {
  if (!valid.value || saving.value) return;
  saving.value = true;
  emit('saving', true);
  try {
    const id = Number(link.value.slice(1)) || null;
    const body = {
      kind: kind.value,
      amount: value.value,
      at: at(),
      category: category.value,
      note: note.value,
      panel_id: link.value.startsWith('p') ? id : null,
      socks_id: link.value.startsWith('s') ? id : null,
      customer_id: kind.value === 'income' && customer.value ? customer.value : null,
    };
    const e = e0 ? await api.updateLedgerEntry(e0.id, body) : await api.addLedgerEntry(body);
    toast(e0 ? t('entry.updated') : t(e.kind === 'expense' ? 'entry.savedExpense' : 'entry.savedIncome', { v: fmtCost(e.amount) }));
    emit('saved', e);
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
    emit('saving', false);
  }
}
</script>

<template>
  <form id="ledger-entry-form" class="entry" @submit.prevent="submit">
    <div class="seg" role="group" :aria-label="t('entry.kind')">
      <button type="button" :class="{ on: kind === 'expense' }" :aria-pressed="kind === 'expense'" @click="kind = 'expense'">{{ t('entry.expense') }}</button>
      <button type="button" :class="{ on: kind === 'income' }" :aria-pressed="kind === 'income'" @click="kind = 'income'">{{ t('entry.income') }}</button>
    </div>
    <div class="two">
      <label class="field">
        {{ t('entry.amount') }}
        <input ref="amountInput" v-model="amount" type="number" min="0.01" step="0.01" required />
      </label>
      <label class="field">{{ t('entry.date') }}<input v-model="day" type="date" required /></label>
    </div>
    <label class="field">
      {{ t('entry.category') }}
      <input v-model="category" maxlength="20" list="ledger-entry-categories" :placeholder="t('entry.categoryPlaceholder')" />
      <datalist id="ledger-entry-categories">
        <option v-for="c in suggestions" :key="c" :value="c" />
      </datalist>
    </label>
    <div :class="{ two: kind === 'income' }">
      <label class="field">
        {{ t('entry.link') }}
        <Select v-model="link" :options="linkOptions" searchable :search-placeholder="t('entry.searchLink')" />
      </label>
      <label v-if="kind === 'income'" class="field">
        {{ t('entry.customer') }}
        <Select v-model="customer" :options="customerOptions" searchable :search-placeholder="t('entry.searchCustomer')" />
      </label>
    </div>
    <label class="field">{{ t('entry.note') }}<input v-model="note" maxlength="200" /></label>
    <p class="muted small hint">{{ t('entry.hint') }}</p>
  </form>
</template>

<style scoped>
.entry {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.seg {
  align-self: flex-start;
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: 8px;
  overflow: hidden;
  background: var(--sheet);
}
.seg button {
  border: none;
  border-radius: 0;
  background: none;
  padding: 6px 16px;
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
