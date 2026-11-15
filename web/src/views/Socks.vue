<script setup lang="ts">
// SOCKS 页:登记购买的 SOCKS5 代理,测连通性(出口 IP / 地区 / 延迟),给客户页的中转当出口用。
import { t } from '../i18n';
import { onMounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import { fmtAgo, region } from '../format';
import { toast, toastError } from '../toast';
import type { Socks, SocksInput } from '../types';

const list = ref<Socks[]>([]);
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
const form = ref({ name: '', address: '', remark: '' });

function openForm(s: Socks | null) {
  editing.value = s;
  form.value = { name: s?.name ?? '', address: '', remark: s?.remark ?? '' };
  showForm.value = true;
}

async function submit() {
  const body: SocksInput = { name: form.value.name, remark: form.value.remark };
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
            <th>{{ t('socks.colAddress') }}</th>
            <th>{{ t('socks.colAccount') }}</th>
            <th>{{ t('socks.colCheck') }}</th>
            <th>{{ t('socks.colExit') }}</th>
            <th>{{ t('socks.colUsed') }}</th>
            <th>{{ t('socks.colRemark') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in list" :key="s.id">
            <td class="name">{{ s.name }}</td>
            <td class="mono">{{ s.host }}:{{ s.port }}</td>
            <td class="muted">{{ s.username || t('socks.noAccount') }}<template v-if="s.has_password"> / ••••</template></td>
            <td class="small">
              <template v-if="checking.has(s.id)"><span class="muted">{{ t('socks.testing') }}</span></template>
              <template v-else-if="!s.check"><span class="muted">{{ t('socks.neverTested') }}</span></template>
              <template v-else-if="s.check.ok"><span class="text-ok">{{ t('socks.ok') }}</span> <span class="muted">{{ s.check.ms }} ms · {{ fmtAgo(s.check.at) }}</span></template>
              <template v-else><span class="text-err" :title="s.check.error ?? ''">{{ t('socks.failed') }}</span> <span class="muted">{{ (s.check.error ?? '').slice(0, 40) }} · {{ fmtAgo(s.check.at) }}</span></template>
            </td>
            <td class="small">
              <template v-if="s.check?.ok">{{ s.check.ip }} <span class="muted">{{ region(s.check.loc) }}</span></template>
              <span v-else class="muted">—</span>
            </td>
            <td class="small"><template v-if="s.used_by">{{ t('socks.usedBy', { n: s.used_by }, s.used_by) }}</template><span v-else class="muted">—</span></td>
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
        {{ t('socks.address') }}{{ editing ? t('socks.keepBlank') : '' }}
        <input v-model="form.address" :required="!editing" :placeholder="t('socks.addressPlaceholder')" autocomplete="off" />
      </label>
      <label class="field">{{ t('socks.remark') }}<input v-model="form.remark" :placeholder="t('socks.remarkPlaceholder')" /></label>
      <p class="muted small hint">{{ t('socks.hint') }}</p>
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
</style>
