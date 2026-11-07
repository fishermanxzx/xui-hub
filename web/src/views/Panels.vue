<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import { fmtAgo, hostOf } from '../format';
import { toast, toastError } from '../toast';
import type { Panel, PanelInput } from '../types';
import PanelDetail from './PanelDetail.vue';

const panels = ref<Panel[]>([]);
const openPanel = ref<Panel | null>(null);
const checking = ref(false);

async function load() {
  try {
    panels.value = await api.panels();
  } catch (e) {
    toastError(e);
  }
}

async function checkAll() {
  checking.value = true;
  try {
    panels.value = await api.checkPanels();
    const failed = panels.value.filter((p) => p.check_error).length;
    toast(failed ? `${failed} 台面板连不上` : '全部面板正常', failed ? 'err' : 'ok');
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
    toast(saved.check_error ? `已保存，但连不上面板：${saved.check_error}` : '已保存，面板连接正常', saved.check_error ? 'err' : 'ok');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(panel: Panel) {
  if (!confirm(`删除面板「${panel.name}」？只是从这里移除，面板上的入站和 client 不受影响。`)) return;
  try {
    await api.deletePanel(panel.id);
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
  <section class="sheet">
    <div class="toolbar">
      <div class="title">
        <h2>面板</h2>
        <p class="muted small">接入的 3x-ui 面板。点名称查看入站和 client，在里面创建客户端。</p>
      </div>
      <div class="row">
        <button :disabled="checking || !panels.length" @click="checkAll">{{ checking ? '检查中…' : '检查连接' }}</button>
        <button class="primary" @click="openForm(null)">添加面板</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>地址</th>
            <th class="num">入站</th>
            <th class="num">client</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in panels" :key="p.id">
            <td class="name"><button class="link name-link" title="查看入站和 client" @click="openPanel = p">{{ p.name }}</button></td>
            <td>{{ hostOf(p.base_url) }}</td>
            <td class="num">{{ p.inbound_count ?? '—' }}</td>
            <td class="num">{{ p.client_count ?? '—' }}</td>
            <td class="small status">
              <template v-if="p.check_error">
                <div class="text-err" :title="p.check_error">连不上：{{ p.check_error.slice(0, 40) }}</div>
                <div v-if="p.check_ok_at" class="muted">上次正常在 {{ fmtAgo(p.check_ok_at) }}</div>
              </template>
              <span v-else-if="p.check_ok_at" class="text-ok">正常，{{ fmtAgo(p.check_ok_at) }}检查</span>
              <span v-else class="muted">还没检查</span>
            </td>
            <td class="num">
              <div class="ops">
                <!-- 面板网页只认账号密码登录(API token 只管 /panel/api),这里只负责在新标签页打开 -->
                <a class="link" :href="p.base_url" target="_blank" rel="noopener noreferrer">打开面板</a>
                <button class="link" @click="openForm(p)">编辑</button>
                <button class="link danger" @click="remove(p)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!panels.length" class="empty">还没有面板。点「添加面板」，填上 3x-ui 的地址和 API token。</div>
    </div>
  </section>

  <PanelDetail v-if="openPanel" :id="openPanel.id" :name="openPanel.name" :url="openPanel.base_url" @close="openPanel = null" />

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
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--rule);
}
h2 {
  font-size: 16px;
}
.title p {
  margin: 4px 0 0;
}
.name {
  font-weight: 500;
  white-space: nowrap;
}
.name-link {
  color: var(--ink);
  font-weight: 500;
}
.status {
  max-width: 280px;
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
