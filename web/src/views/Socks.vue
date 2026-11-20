<script setup lang="ts">
// SOCKS 页:登记购买的 SOCKS5 代理,测连通性(出口 IP / 地区 / 延迟),给客户页的中转当出口用。
import { t } from '../i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import { costSummary, dateInputToMs, dueClass, fmtAgo, fmtCost, fmtDate, fmtDue, msToDateInput, region } from '../format';
import { toast, toastError } from '../toast';
import type { Socks, SocksInput } from '../types';

const list = ref<Socks[]>([]);
const summary = computed(() => costSummary(list.value));
const checkingAll = ref(false);
const checking = ref(new Set<number>());

async function load() {
  try {
    list.value = await api.socks();
  } catch (e) {
    toastError(e);
  }
}
onMounted(load);

async function checkOne(s: Socks) {
  checking.value.add(s.id);
  try {
    const updated = await api.checkSocks(s.id);
    Object.assign(s, updated);
    if (updated.check?.ok) toast(t('socks.okToast', { name: s.name, ms: updated.check.ms, ip: updated.check.ip ?? t('socks.unknown'), region: region(updated.check.loc) }));
    else toast(t('socks.failToast', { name: s.name, error: updated.check?.error ?? t('socks.testFailed') }), 'err');
  } catch (e) {
    toastError(e);
  } finally {
    checking.value.delete(s.id);
  }
}

async function checkAll() {
  checkingAll.value = true;
  try {
    list.value = await api.checkAllSocks();
    const bad = list.value.filter((s) => !s.check?.ok).length;
    toast(t('socks.allDone', { ok: list.value.length - bad, bad }), bad ? 'err' : 'ok');
  } catch (e) {
    toastError(e);
  } finally {
    checkingAll.value = false;
  }
}

// ---------- 新增 / 编辑 ----------
const editing = ref<Socks | null>(null);
const showForm = ref(false);
const saving = ref(false);
const form = ref({ name: '', address: '', remark: '', cost: '', expire: '' });

function openForm(s: Socks | null) {
  editing.value = s;
  form.value = { name: s?.name ?? '', address: '', remark: s?.remark ?? '', cost: s?.monthly_cost == null ? '' : String(s.monthly_cost), expire: msToDateInput(s?.expire_at ?? 0) };
  showForm.value = true;
}

async function submit() {
  const body: SocksInput = { name: form.value.name, remark: form.value.remark, monthly_cost: form.value.cost === '' ? null : Number(form.value.cost), expire_at: dateInputToMs(form.value.expire) };
  if (form.value.address.trim()) body.address = form.value.address.trim();
  const used = editing.value?.used_by ?? 0;
  if (body.address && used && !confirm(t('socks.confirmAddress', { n: used }))) return;
  saving.value = true;
  try {
    const saved = editing.value ? await api.updateSocks(editing.value.id, body) : await api.createSocks(body);
    showForm.value = false;
    toast(t('socks.saved'));
    await load();
    // 新登记的顺手测一下
    if (!editing.value) {
      const row = list.value.find((s) => s.id === saved.id);
      if (row) void checkOne(row);
    }
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(s: Socks) {
  if (s.used_by) return toast(t('socks.inUse', { n: s.used_by, name: s.name }), 'err');
  if (!confirm(t('socks.confirmDelete', { name: s.name }))) return;
  try {
    await api.deleteSocks(s.id);
    toast(t('socks.deleted'));
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>SOCKS</h2>
      <p class="muted small">{{ t('socks.intro') }}</p>
      <p v-if="list.length" class="small summary">
        <span>{{ t('cost.total', { total: fmtCost(summary.total) }) }}</span>
        <span v-if="summary.unset" class="muted">{{ t('cost.unset', { n: summary.unset }) }}</span>
        <span v-if="summary.soon" class="text-warn">{{ t('cost.soon', { n: summary.soon }) }}</span>
        <span v-if="summary.overdue" class="text-err">{{ t('cost.overdue', { n: summary.overdue }) }}</span>
      </p>
    </div>
    <div class="row">
      <button :disabled="checkingAll || !list.length" @click="checkAll">{{ checkingAll ? t('socks.testing') : t('socks.testAll') }}</button>
      <button class="primary" @click="openForm(null)">{{ t('socks.add') }}</button>
    </div>
  </div>

  <section class="sheet">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('socks.colName') }}</th>
            <th>{{ t('socks.colCheck') }}</th>
            <th>{{ t('socks.colExit') }}</th>
            <th>{{ t('socks.colUsed') }}</th>
            <th>{{ t('cost.col') }}</th>
            <th>{{ t('cost.colExpire') }}</th>
            <th>{{ t('socks.colRemark') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in list" :key="s.id">
            <td class="name" :title="`${s.host}:${s.port}`">{{ s.name }}</td>
            <td class="small">
              <template v-if="checking.has(s.id)"><span class="muted">{{ t('socks.testing') }}</span></template>
              <template v-else-if="!s.check"><span class="muted">{{ t('socks.neverTested') }}</span></template>
              <template v-else-if="s.check.ok"><span class="text-ok">{{ t('socks.ok') }}</span> <span class="muted">{{ s.check.ms }} ms · {{ fmtAgo(s.check.at) }}</span></template>
              <template v-else><span class="text-err" :title="s.check.error ?? ''">{{ t('socks.failed') }}</span> <span class="muted">{{ (s.check.error ?? '').slice(0, 40) }} · {{ fmtAgo(s.check.at) }}</span></template>
            </td>
            <td class="small nowrap">
              <template v-if="s.check?.ok">{{ s.check.ip }} <span class="muted">{{ region(s.check.loc) }}</span></template>
              <span v-else class="muted">—</span>
            </td>
            <td class="small nowrap"><template v-if="s.used_by">{{ t('socks.usedBy', { n: s.used_by }, s.used_by) }}</template><span v-else class="muted">—</span></td>
            <td class="small mono"><template v-if="s.monthly_cost != null">{{ fmtCost(s.monthly_cost) }}</template><span v-else class="muted">—</span></td>
            <td class="small nowrap">
              <template v-if="s.expire_at">{{ fmtDate(s.expire_at) }} <span :class="dueClass(s.expire_at, 'muted')">{{ fmtDue(s.expire_at) }}</span></template>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted small">{{ s.remark || '' }}</td>
            <td class="num">
              <div class="ops">
                <button class="link" :disabled="checking.has(s.id)" @click="checkOne(s)">{{ t('socks.test') }}</button>
                <button class="link" @click="openForm(s)">{{ t('common.edit') }}</button>
                <button class="link danger" @click="remove(s)">{{ t('common.delete') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!list.length" class="empty">{{ t('socks.empty') }}</div>
    </div>
  </section>

  <Modal v-if="showForm" :title="editing ? t('socks.editTitle', { name: editing.name }) : t('socks.add')" @close="showForm = false">
    <form id="socks-form" class="form" @submit.prevent="submit">
      <label class="field">{{ t('socks.name') }}<input v-model="form.name" required :placeholder="t('socks.namePlaceholder')" /></label>
      <label class="field">
        {{ t('socks.address') }}{{ editing ? t('socks.keepBlankCurrent', { addr: `${editing.host}:${editing.port}` }) : '' }}
        <input v-model="form.address" :required="!editing" :placeholder="t('socks.addressPlaceholder')" autocomplete="off" />
      </label>
      <div class="two">
        <label class="field">{{ t('cost.field') }}<input v-model="form.cost" type="number" min="0" step="0.01" /></label>
        <label class="field">{{ t('cost.expireField') }}<input v-model="form.expire" type="date" /></label>
      </div>
      <label class="field">{{ t('socks.remark') }}<input v-model="form.remark" :placeholder="t('socks.remarkPlaceholder')" /></label>
      <p class="muted small hint">{{ t('socks.hint') }} {{ t('cost.hint') }}</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="primary" form="socks-form" :disabled="saving">{{ saving ? t('common.saving') : t('common.save') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
h2 {
  font-size: 18px;
}
.toolbar p {
  margin: 4px 0 0;
  max-width: 60ch;
}
.name {
  font-weight: 500;
  white-space: nowrap;
}
.mono {
  font-variant-numeric: tabular-nums;
}
.ops {
  display: flex;
  justify-content: flex-end;
  gap: 14px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hint {
  margin: 0;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}
.nowrap {
  white-space: nowrap;
}
</style>
