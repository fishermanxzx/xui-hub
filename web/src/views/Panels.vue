<script setup lang="ts">
// 面板页:每块面板一张卡片,展开看入站和客户端;添加 / 编辑面板用弹窗。
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
    toast(failed ? `${failed} 块面板连不上` : '全部面板正常', failed ? 'err' : 'ok');
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
    toast(saved.check_error ? `已保存,但连不上面板:${saved.check_error}` : '已保存,面板连接正常', saved.check_error ? 'err' : 'ok');
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
    panel.line_count ? `这块面板上的 ${panel.line_count} 条客户线路会从客户名下消失,订阅里也不再有它们` : '',
    panel.exit_line_count ? `${panel.exit_line_count} 条中转线路拿它当落地出口,之后显示成「落地 (已删除)」` : '',
  ].filter(Boolean);
  if (!confirm(`删除面板「${panel.name}」?只是从这里移除,面板上的入站和 client 不受影响。${notes.length ? `\n\n${notes.join(';')}。` : ''}`)) return;
  try {
    await api.deletePanel(panel.id, panel.line_count > 0);
    toast('已删除');
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
      <h2>面板</h2>
      <p class="muted small">接入的 3x-ui 面板。展开卡片看入站和客户端,在卡片里创建客户端。</p>
    </div>
    <div class="row">
      <button :disabled="checking || !panels.length" @click="checkAll">{{ checking ? '检查中…' : '检查全部' }}</button>
      <button class="primary" @click="openForm(null)">添加面板</button>
    </div>
  </div>

  <div class="cards">
    <PanelCard v-for="p in panels" :key="p.id" :panel="p" :open="open.has(p.id)" @toggle="toggle(p.id)" @edit="openForm(p)" @remove="remove(p)" @changed="load" />
  </div>
  <div v-if="!panels.length" class="empty sheet">还没有面板。点「添加面板」,填上 3x-ui 的地址和 API token。</div>

  <Modal v-if="showForm" :title="editing ? `编辑面板「${editing.name}」` : '添加面板'" @close="showForm = false">
    <form id="panel-form" class="form" @submit.prevent="submit">
      <label class="field">名称<input v-model="form.name" required placeholder="如 美国-1" /></label>
      <label class="field">面板地址(含 webBasePath)<input v-model="form.base_url" required placeholder="https://1.2.3.4:2053/path" /></label>
      <label class="field">
        API token{{ editing ? '(留空不修改)' : '' }}
        <input v-model="form.token" type="password" autocomplete="off" :required="!editing" />
      </label>
      <p class="muted small hint">API token 在 3x-ui 的「面板设置 → API」里生成。保存后会立即检查一次能不能连上。</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">取消</button>
      <button class="primary" form="panel-form" :disabled="saving">{{ saving ? '保存并检查中…' : '保存' }}</button>
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
