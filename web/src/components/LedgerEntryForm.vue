<script setup lang="ts">
// 账本页的「记一笔」:自己记一笔收入或支出(客户续费在客户的「续费」里记)。
// 可以关联一块面板或一个 SOCKS,收入还可以关联客户,都可以不选。
// 放在 Modal 里用,底部按钮用 form="ledger-entry-form" 提交。
import { locale, t } from '../i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import Select, { type SelectOption } from './Select.vue';
import { fmtCost, msToDateInput } from '../format';
import { toast, toastError } from '../toast';
import type { Customer, EntryKind, LedgerEntry, Panel, Socks } from '../types';

const props = defineProps<{ entries: LedgerEntry[]; customers: Customer[]; panels: Panel[]; socks: Socks[] }>();
const emit = defineEmits<{ saved: [e: LedgerEntry]; saving: [busy: boolean] }>();

const kind = ref<EntryKind>('expense');
const amount = ref('');
const today = () => msToDateInput(Date.now());
const day = ref(today());
const category = ref('');
const note = ref('');
/** 关联的面板 / SOCKS:'' = 不关联,p<id> = 面板,s<id> = SOCKS */
const link = ref('');
/** 关联的客户(只有收入):0 = 不关联 */
const customer = ref(0);
const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, locale.value));
const linkOptions = computed<SelectOption<string>[]>(() => [
  { value: '', label: t('entry.linkNone') },
  ...byName(props.panels).map((p) => ({ value: `p${p.id}`, label: t('entry.linkPanel', { name: p.name }) })),
  ...byName(props.socks).map((s) => ({ value: `s${s.id}`, label: t('entry.linkSocks', { name: s.name }) })),
]);
const customerOptions = computed<SelectOption<number>[]>(() => [{ value: 0, label: t('entry.linkNone') }, ...byName(props.customers).map((c) => ({ value: c.id, label: c.name }))]);
const amountInput = ref<HTMLInputElement | null>(null);
// 弹窗是后插进页面的,autofocus 不生效,打开时手动聚焦金额
onMounted(() => amountInput.value?.focus());

/** 类别的候选:以前记过的(同一类的在前、用得多的在前),再补几个常用的 */
const suggestions = computed(() => {
  const count = new Map<string, number>();
  for (const e of props.entries) if (e.category && e.kind === kind.value) count.set(e.category, (count.get(e.category) ?? 0) + 1);
  const used = [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)!);
  const preset = (kind.value === 'expense' ? t('entry.presetExpense') : t('entry.presetIncome')).split(',');
  return [...new Set([...used, ...preset])];
});

const value = computed(() => Number(String(amount.value ?? '').trim()));
const valid = computed(() => String(amount.value ?? '').trim() !== '' && Number.isFinite(value.value) && value.value > 0);

/** 日期:今天 = 就是现在;别的日子记当天中午(按月汇总时不会因为时区落到隔壁月) */
function at(): number | undefined {
  if (!day.value || day.value === today()) return undefined;
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
    const e = await api.addLedgerEntry({
      kind: kind.value,
      amount: value.value,
      at: at(),
      category: category.value,
      note: note.value,
      panel_id: link.value.startsWith('p') ? id : null,
      socks_id: link.value.startsWith('s') ? id : null,
      customer_id: kind.value === 'income' && customer.value ? customer.value : null,
    });
    toast(t(e.kind === 'expense' ? 'entry.savedExpense' : 'entry.savedIncome', { v: fmtCost(e.amount) }));
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
