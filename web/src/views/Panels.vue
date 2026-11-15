<script setup lang="ts">
// 面板页:每块面板一张卡片,展开看入站和客户端;添加 / 编辑面板用弹窗。
import { t } from '../i18n';
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import PanelCard from '../components/PanelCard.vue';
import { toast, toastError } from '../toast';
import type { Panel, PanelInput } from '../types';

const panels = ref<Panel[]>([]);
const checking = ref(false);

/** 展开的卡片,记在浏览器里,刷新后保持 */
const OPEN_KEY = 'xui-hub.openPanels';
const open = ref<Set<number>>(new Set());
try {
  open.value = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]'));
} catch {
  /* 忽略坏数据 */
}
function toggle(id: number) {
  const next = new Set(open.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  open.value = next;
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
  } catch {
    /* 存不了就算了 */
  }
}

async function load() {
  try {
    panels.value = await api.panels();
    // 只有一块面板时默认展开
    if (panels.value.length === 1 && !open.value.size) toggle(panels.value[0].id);
  } catch (e) {
    toastError(e);
  }
}

async function checkAll() {
  checking.value = true;
  try {
    panels.value = await api.checkPanels();
    const failed = panels.value.filter((p) => p.check_error).length;
    toast(failed ? t('panels.someDown', { n: failed }) : t('panels.allOk'), failed ? 'err' : 'ok');
  } catch (e) {
    toastError(e);
  } finally {
    checking.value = false;
  }
}

// ---------- 新增 / 编辑 ----------
const editing = ref<Panel | null>(null);
const showForm = ref(false);
const saving = ref(false);
const form = ref({ name: '', base_url: '', token: '' });

function openForm(panel: Panel | null) {
  editing.value = panel;
  form.value = { name: panel?.name ?? '', base_url: panel?.base_url ?? '', token: '' };
  showForm.value = true;
}

async function submit() {
  const body: PanelInput = { name: form.value.name, base_url: form.value.base_url };
  if (form.value.token) body.token = form.value.token;
  saving.value = true;
  try {
    const saved = editing.value ? await api.updatePanel(editing.value.id, body) : await api.createPanel(body);
    showForm.value = false;
    toast(saved.check_error ? t('panels.savedButDown', { error: saved.check_error }) : t('panels.savedOk'), saved.check_error ? 'err' : 'ok');
    await load();
    if (!editing.value && !saved.check_error) toggle(saved.id);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(panel: Panel) {
  const notes = [
    panel.line_count ? t('panels.deleteLines', { n: panel.line_count }) : '',
    panel.exit_line_count ? t('panels.deleteExits', { n: panel.exit_line_count }) : '',
  ].filter(Boolean);
  if (!confirm(t('panels.confirmDelete', { name: panel.name }) + (notes.length ? `\n\n${notes.join('\n')}` : ''))) return;
  try {
    await api.deletePanel(panel.id, panel.line_count > 0);
    toast(t('panels.deleted'));
    await load();
  } catch (e) {
    toastError(e);
  }
}

let timer: number | undefined;
onMounted(() => {
  void load();
  timer = window.setInterval(load, 30_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>{{ t('panels.title') }}</h2>
      <p class="muted small">{{ t('panels.intro') }}</p>
    </div>
    <div class="row">
      <button :disabled="checking || !panels.length" @click="checkAll">{{ checking ? t('panels.checking') : t('panels.checkAll') }}</button>
      <button class="primary" @click="openForm(null)">{{ t('panels.add') }}</button>
    </div>
  </div>

  <div class="cards">
    <PanelCard v-for="p in panels" :key="p.id" :panel="p" :open="open.has(p.id)" @toggle="toggle(p.id)" @edit="openForm(p)" @remove="remove(p)" @changed="load" />
  </div>
  <div v-if="!panels.length" class="empty sheet">{{ t('panels.empty') }}</div>

  <Modal v-if="showForm" :title="editing ? t('panels.editTitle', { name: editing.name }) : t('panels.add')" @close="showForm = false">
    <form id="panel-form" class="form" @submit.prevent="submit">
      <label class="field">{{ t('panels.name') }}<input v-model="form.name" required :placeholder="t('panels.namePlaceholder')" /></label>
      <label class="field">{{ t('panels.baseUrl') }}<input v-model="form.base_url" required placeholder="https://1.2.3.4:2053/path" /></label>
      <label class="field">
        {{ t('panels.token') }}{{ editing ? t('panels.keepBlank') : '' }}
        <input v-model="form.token" type="password" autocomplete="off" :required="!editing" />
      </label>
      <p class="muted small hint">{{ t('panels.hint') }}</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="primary" form="panel-form" :disabled="saving">{{ saving ? t('panels.savingCheck') : t('common.save') }}</button>
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
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
