<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import PanelDetail from './PanelDetail.vue';
import RelayLines from '../components/RelayLines.vue';
import UninstallPanel from '../components/UninstallPanel.vue';
import { dateInputToMs, daysUntil, dueLevel, fmtAgo, fmtBytes, fmtDate, fmtDue, fmtPrice, msToDateInput } from '../format';
import { toast, toastError } from '../toast';
import type { Panel, PanelInput, PanelRole, SyncStatus } from '../types';

const panels = ref<Panel[]>([]);
const openPanel = ref<Panel | null>(null);
const status = ref<SyncStatus | null>(null);
const syncing = ref(false);

async function load() {
  try {
    [panels.value, status.value] = await Promise.all([api.panels(), api.syncStatus()]);
  } catch (e) {
    toastError(e);
  }
}

async function syncNow() {
  syncing.value = true;
  try {
    const run = await api.runSync();
    const failed = run.results.filter((r) => !r.ok).length;
    const bytes = run.results.reduce((sum, r) => sum + (r.delta_bytes ?? 0), 0);
    toast(`同步完成：${run.results.length - failed} 台成功，${failed} 台失败，新增流量 ${fmtBytes(bytes)}`, failed ? 'err' : 'ok');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    syncing.value = false;
  }
}

// ---------- 新增 / 编辑 ----------
const editing = ref<Panel | null>(null);
const showForm = ref(false);
// 类型(中转 / 落地)新建时必须自己选,不按名称推断
const form = ref({ name: '', base_url: '', token: '', ip: '', provider: '', role: '' as PanelRole | '', monthly_cost: '', expire: '', forever: false, enabled: true });

function openForm(panel: Panel | null) {
  editing.value = panel;
  form.value = {
    name: panel?.name ?? '',
    base_url: panel?.base_url ?? '',
    token: '',
    ip: panel?.ip ?? '',
    provider: panel?.provider ?? '',
    role: panel?.role ?? '',
    monthly_cost: panel?.monthly_cost == null ? '' : String(panel.monthly_cost),
    expire: panel?.expire_at ? msToDateInput(panel.expire_at) : '',
    forever: panel?.expire_at === 0,
    enabled: panel?.enabled ?? true,
  };
  showForm.value = true;
}

async function submit() {
  if (!form.value.role) return toast('请选择类型：中转或落地', 'err');
  const body: PanelInput = {
    name: form.value.name,
    base_url: form.value.base_url,
    ip: form.value.ip,
    provider: form.value.provider,
    role: form.value.role,
    monthly_cost: form.value.monthly_cost === '' ? null : Number(form.value.monthly_cost),
    // 不限期 = 0,日期空着 = 未填
    expire_at: form.value.forever ? 0 : form.value.expire ? dateInputToMs(form.value.expire) : null,
    enabled: form.value.enabled,
  };
  if (form.value.token) body.token = form.value.token;
  try {
    if (editing.value) await api.updatePanel(editing.value.id, body);
    else await api.createPanel(body);
    showForm.value = false;
    toast('已保存');
    await load();
  } catch (e) {
    toastError(e);
  }
}

/** 按角色分组:中转在前,落地在后,各自给台数和成本小计 */
const groups = computed(() =>
  (['relay', 'exit'] as PanelRole[])
    .map((role) => {
      const list = panels.value.filter((p) => p.role === role);
      const cost = list.reduce((sum, p) => sum + Math.round((p.monthly_cost ?? 0) * 100), 0) / 100;
      return { role, label: role === 'relay' ? '中转' : '落地', list, cost };
    })
    .filter((g) => g.list.length),
);

const costSummary = computed(() => {
  const unset = panels.value.filter((p) => p.monthly_cost == null).length;
  const total = panels.value.reduce((sum, p) => sum + Math.round((p.monthly_cost ?? 0) * 100), 0) / 100;
  return { total, unset };
});

/** 7 天内到期 / 已过期的机器台数(按到期时间填了的算) */
const dueSummary = computed(() => {
  const dated = panels.value.filter((p) => p.expire_at);
  return {
    expired: dated.filter((p) => daysUntil(p.expire_at!) < 0).length,
    soon: dated.filter((p) => dueLevel(p.expire_at!) === 'warn').length,
  };
});

/** 表格内直接改月成本:回车或离开输入框即保存,清空 = 未填 */
async function saveCost(panel: Panel, event: Event) {
  const input = event.target as HTMLInputElement;
  const text = input.value.trim();
  const cost = text === '' ? null : Number(text);
  if (cost === panel.monthly_cost) return;
  try {
    const updated = await api.updatePanel(panel.id, { monthly_cost: cost });
    panel.monthly_cost = updated.monthly_cost;
    input.value = updated.monthly_cost == null ? '' : String(updated.monthly_cost);
    toast(`${panel.name} 月成本已保存`);
  } catch (e) {
    input.value = panel.monthly_cost == null ? '' : String(panel.monthly_cost);
    toastError(e);
  }
}

async function toggle(panel: Panel) {
  try {
    await api.updatePanel(panel.id, { enabled: !panel.enabled });
    await load();
  } catch (e) {
    toastError(e);
  }
}

/** 正在卸载的面板(打开卸载对话框) */
const uninstalling = ref<Panel | null>(null);
/** 中转批量开线路 */
const relayLines = ref<Panel | null>(null);

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

let timer: number | undefined;
onMounted(() => {
  void load();
  // 正在表格里改成本时跳过自动刷新,免得输入被覆盖
  timer = window.setInterval(() => {
    if (!document.activeElement?.classList.contains('cost')) void load();
  }, 30_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section class="sheet">
    <div class="toolbar">
      <div class="title">
        <h2>面板</h2>
        <p class="muted small">
          <template v-if="status">每 {{ status.interval_sec }} 秒同步一次，上次在 {{ fmtAgo(status.last_run?.finished_at, '还没运行过') }}。</template>
          月成本合计 <span class="figure">{{ fmtPrice(costSummary.total) }}</span><template v-if="costSummary.unset">，{{ costSummary.unset }} 台没填</template>。
          <span v-if="dueSummary.expired" class="text-err">{{ dueSummary.expired }} 台已过期。</span>
          <span v-if="dueSummary.soon" class="text-warn">{{ dueSummary.soon }} 台 7 天内到期。</span>
        </p>
      </div>
      <div class="row">
        <button :disabled="syncing" @click="syncNow">{{ syncing ? '同步中…' : '立即同步' }}</button>
        <button class="primary" @click="openForm(null)">添加面板</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>类型</th>
            <th>地址</th>
            <th>商家</th>
            <th class="num">月成本(元)</th>
            <th>到期</th>
            <th class="num">client</th>
            <th>同步</th>
            <th></th>
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.role">
          <tr class="group">
            <th colspan="9" scope="rowgroup">
              {{ g.label }}
              <span class="muted">{{ g.list.length }} 台，月成本 {{ fmtPrice(g.cost) }}</span>
            </th>
          </tr>
          <tr v-for="p in g.list" :key="p.id" :class="{ off: !p.enabled }">
            <td class="name"><button class="link name-link" title="查看入站和 client" @click="openPanel = p">{{ p.name }}</button></td>
            <td><span class="type" :class="p.role">{{ p.role === 'relay' ? '中转' : '落地' }}</span></td>
            <td>{{ host(p.base_url) }}</td>
            <td class="muted">{{ p.provider || '—' }}</td>
            <td class="num">
              <input
                class="cost"
                type="number"
                min="0"
                step="0.01"
                placeholder="未填"
                :value="p.monthly_cost ?? ''"
                :aria-label="p.name + ' 月成本'"
                @change="saveCost(p, $event)"
                @keyup.enter="($event.target as HTMLInputElement).blur()"
              />
            </td>
            <td class="due">
              <template v-if="p.expire_at">
                <div :class="{ 'text-warn': dueLevel(p.expire_at) === 'warn', 'text-err': dueLevel(p.expire_at) === 'err' }">{{ fmtDue(p.expire_at) }}</div>
                <div class="muted small">{{ fmtDate(p.expire_at) }}</div>
              </template>
              <span v-else class="muted">{{ p.expire_at === 0 ? '不限期' : '未填' }}</span>
            </td>
            <td class="num">{{ p.client_count ?? '—' }}</td>
            <td class="small sync">
              <span v-if="!p.enabled" class="muted">已暂停同步</span>
              <template v-else-if="p.last_sync_error">
                <div class="text-err" :title="p.last_sync_error">同步失败：{{ p.last_sync_error.slice(0, 40) }}</div>
                <div class="muted">上次成功在 {{ fmtAgo(p.last_sync_ok_at) }}</div>
              </template>
              <span v-else-if="p.last_sync_ok_at" class="muted">{{ fmtAgo(p.last_sync_ok_at) }}同步</span>
              <span v-else class="muted">等待首次同步</span>
            </td>
            <td class="num">
              <div class="ops">
                <!-- 面板网页只认账号密码登录(API token 只管 /panel/api),这里只负责在新标签页打开 -->
                <a class="link" :href="p.base_url" target="_blank" rel="noopener noreferrer">打开面板</a>
                <button class="link" @click="toggle(p)">{{ p.enabled ? '暂停' : '恢复' }}</button>
                <button class="link" @click="openForm(p)">编辑</button>
                <button v-if="p.role === 'relay' && p.enabled" class="link" title="勾选客户，按各自在用的落地在这台中转上开线路" @click="relayLines = p">开线路</button>
                <button class="link danger" @click="uninstalling = p">卸载</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!panels.length" class="empty">
        还没有面板。点「添加面板」，填上 3x-ui 的地址、API token 和类型（中转 / 落地）。
      </div>
    </div>
  </section>

  <UninstallPanel v-if="uninstalling" :panel="uninstalling" @close="uninstalling = null" @done="load" />

  <RelayLines v-if="relayLines" :panel="relayLines" @close="relayLines = null" @done="load" />

  <PanelDetail v-if="openPanel" :id="openPanel.id" :name="openPanel.name" :url="openPanel.base_url" @close="openPanel = null" />

  <Modal v-if="showForm" :title="editing ? `编辑面板「${editing.name}」` : '添加面板'" @close="showForm = false">
    <form id="panel-form" class="form" @submit.prevent="submit">
      <label class="field">名称<input v-model="form.name" required /></label>
      <label class="field">面板地址(含 webBasePath)<input v-model="form.base_url" required placeholder="https://1.2.3.4:2053/path" /></label>
      <label class="field">
        API token{{ editing ? '(留空不修改)' : '' }}
        <input v-model="form.token" type="password" autocomplete="off" :required="!editing" />
      </label>
      <div class="grid">
        <label class="field">
          类型
          <select v-model="form.role" required>
            <option value="" disabled>请选择</option>
            <option value="relay">中转</option>
            <option value="exit">落地</option>
          </select>
        </label>
        <label class="field">IP<input v-model="form.ip" /></label>
        <label class="field">商家<input v-model="form.provider" /></label>
        <label class="field">月成本(元)<input v-model="form.monthly_cost" type="number" min="0" step="0.01" /></label>
        <label class="field">到期日(空 = 未填)<input v-model="form.expire" type="date" :disabled="form.forever" /></label>
      </div>
      <p v-if="editing && form.role && form.role !== editing.role" class="role-change small">
        <template v-if="form.role === 'relay'">
          改成中转后：开通线路时它和其他中转一起列出，可以「开线路」；不再作为落地出现在出口选项和「开通直连」里。
        </template>
        <template v-else>
          改成落地后：开通线路时不再在它上面开 client，「开线路」按钮消失；有 mixed / socks 入站的话可作为出口，也可「开通直连」。
        </template>
        以前的流量仍按原来的类型统计，客户已用量和订阅不受影响。
      </p>
      <div class="checks">
        <label class="row small"><input v-model="form.forever" type="checkbox" />不限期</label>
        <label class="row small"><input v-model="form.enabled" type="checkbox" />参与流量同步</label>
      </div>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">取消</button>
      <button class="primary" form="panel-form">保存</button>
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
tr.group th {
  padding-top: 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  background: var(--hover);
}
tr.group .muted {
  font-weight: 400;
  margin-left: 8px;
}
.name {
  font-weight: 500;
  white-space: nowrap;
}
/* 类型标签:中转靛蓝、落地绿 */
.type {
  display: inline-block;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 22px;
  white-space: nowrap;
}
.type.relay {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.type.exit {
  background: var(--ok-bg);
  color: var(--ok);
}
.name-link {
  color: var(--ink);
  font-weight: 500;
}
tr.off td {
  color: var(--ink-soft);
}
.cost {
  width: 84px;
  text-align: right;
  padding: 3px 8px;
  font-variant-numeric: tabular-nums;
}
.sync {
  max-width: 260px;
}
.due {
  white-space: nowrap;
}
.checks {
  display: flex;
  gap: 20px;
}
.role-change {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--caution-bg);
  color: var(--caution);
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
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 12px;
}
code {
  font-size: 12px;
}
</style>
