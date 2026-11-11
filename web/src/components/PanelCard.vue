<script setup lang="ts">
// 一块面板一张卡片:头部是名称、地址、连接状态和操作;展开后现取入站和 client,可在卡片里创建客户端、看链接、删 client。
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { dueLevel, fmtAgo, fmtBytes, fmtDue, hostOf } from '../format';
import { toast, toastError } from '../toast';
import type { ClientProtocol, CreatedClient, Customer, Panel, PanelClient, PanelDetail, PanelInbound, PanelVersions } from '../types';
import ClientLinks from './ClientLinks.vue';
import Modal from './Modal.vue';

const props = defineProps<{ panel: Panel; open: boolean }>();
const emit = defineEmits<{ toggle: []; edit: []; remove: []; changed: [] }>();

const detail = ref<PanelDetail | null>(null);
const loading = ref(false);
const error = ref('');
const checking = ref(false);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    detail.value = await api.panelInbounds(props.panel.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(() => props.open && load());
watch(
  () => props.open,
  (open) => open && !detail.value && load(),
);

async function check() {
  checking.value = true;
  try {
    const p = await api.checkPanel(props.panel.id);
    toast(p.check_error ? `连不上:${p.check_error}` : '连接正常', p.check_error ? 'err' : 'ok');
    emit('changed');
    if (props.open) await load();
  } catch (e) {
    toastError(e);
  } finally {
    checking.value = false;
  }
}

const PROTOCOL: Record<string, string> = { hysteria: 'hy2', mixed: 'socks' };

const groups = computed(() => {
  const d = detail.value;
  if (!d) return [];
  const all: { key: string; inbound: PanelInbound | null; clients: PanelClient[] }[] = d.inbounds.map((i) => ({ key: `ib-${i.id}`, inbound: i, clients: i.clients }));
  if (d.unattached.length) all.push({ key: 'unattached', inbound: null, clients: d.unattached });
  return all;
});

// ---------- 版本:内核切换 / 面板升级 ----------
const versions = ref<PanelVersions | null>(null);
const loadingVersions = ref(false);
const showXray = ref(false);
const xrayPick = ref('');
const switching = ref(false);
const upgrading = ref(false);
const upgradeNote = ref('');

async function loadVersions() {
  loadingVersions.value = true;
  try {
    versions.value = await api.panelVersions(props.panel.id);
    xrayPick.value = versions.value.xray.available.find((v) => v.replace(/^v/, '') === versions.value!.xray.current) ?? versions.value.xray.available[0] ?? '';
  } catch (e) {
    toastError(e);
  } finally {
    loadingVersions.value = false;
  }
}

async function openXray() {
  showXray.value = true;
  if (!versions.value) await loadVersions();
}

async function switchXray() {
  const v = xrayPick.value;
  if (!v) return;
  if (!confirm(`把「${props.panel.name}」的 Xray 内核切换到 ${v}?面板会下载对应版本并重启 Xray,上面所有客户端会断流几秒。`)) return;
  switching.value = true;
  try {
    await api.installXray(props.panel.id, v);
    toast(`内核已切换到 ${v}`);
    showXray.value = false;
    versions.value = null;
    emit('changed');
  } catch (e) {
    toastError(e);
  } finally {
    switching.value = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function upgradePanel() {
  const latest = versions.value?.panel.latest;
  if (!confirm(`升级面板「${props.panel.name}」${latest ? `到 ${latest}` : ''}?面板会自己下载新版本并重启,期间短暂不可用。`)) return;
  upgrading.value = true;
  upgradeNote.value = '已通知面板开始升级…';
  try {
    const { run_id } = await api.upgradePanel(props.panel.id);
    // 面板在后台跑升级脚本,这里每 5 秒问一次结果,最多等 5 分钟
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      let st;
      try {
        st = await api.updateStatus(props.panel.id);
      } catch {
        upgradeNote.value = '面板正在重启,等它回来…';
        continue;
      }
      if (st.runId === run_id && st.state === 'success') {
        toast('面板升级完成');
        upgradeNote.value = '';
        versions.value = null;
        emit('changed');
        return;
      }
      if (st.runId === run_id && st.state === 'failed') throw new Error(`面板升级失败(退出码 ${st.exitCode}),去面板日志里看原因`);
      upgradeNote.value = `升级中…(${(i + 1) * 5} 秒)`;
    }
    throw new Error('等了 5 分钟面板还没报告结果,去面板上确认');
  } catch (e) {
    toastError(e);
    upgradeNote.value = '';
  } finally {
    upgrading.value = false;
  }
}

// ---------- 创建客户端 ----------
const showCreate = ref(false);
const creating = ref(false);
const form = ref({ name: '', protocol: 'vless' as ClientProtocol });
const created = ref<CreatedClient | null>(null);

function openCreate() {
  form.value = { name: '', protocol: 'vless' };
  created.value = null;
  showCreate.value = true;
}

async function create() {
  creating.value = true;
  try {
    created.value = await api.createClient(props.panel.id, form.value.name, form.value.protocol);
    toast(created.value.inbound.created ? `已创建,并新建了入站 ${created.value.inbound.remark}(端口 ${created.value.inbound.port})` : '已创建');
    emit('changed');
    void load();
  } catch (e) {
    toastError(e);
  } finally {
    creating.value = false;
  }
}

// ---------- 归入客户:面板上已有的客户端记成某位客户的直连线路 ----------
const assignFor = ref<PanelClient | null>(null);
const customers = ref<Customer[]>([]);
const assignTo = ref<number | 'new'>('new');
const newName = ref('');
const assigning = ref(false);

async function openAssign(c: PanelClient) {
  assignFor.value = c;
  newName.value = c.email;
  try {
    customers.value = await api.customers();
    // 名字和客户端一样的客户大概率就是他
    assignTo.value = customers.value.find((x) => x.name === c.email)?.id ?? customers.value[0]?.id ?? 'new';
  } catch (e) {
    toastError(e);
  }
}

async function assign() {
  if (!assignFor.value) return;
  assigning.value = true;
  try {
    const id = assignTo.value === 'new' ? (await api.createCustomer({ name: newName.value })).id : assignTo.value;
    const r = await api.importClients(id, props.panel.id, [assignFor.value.email]);
    if (r.failed.length) throw new Error(r.failed[0].error);
    toast(`已归入客户「${r.customer.name}」`);
    assignFor.value = null;
    emit('changed');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    assigning.value = false;
  }
}

// ---------- 链接 / 删除 ----------
const linksFor = ref<{ email: string; links: string[] } | null>(null);
const loadingLinks = ref('');

async function showLinks(c: PanelClient) {
  loadingLinks.value = c.email;
  try {
    linksFor.value = { email: c.email, ...(await api.clientLinks(props.panel.id, c.email)) };
  } catch (e) {
    toastError(e);
  } finally {
    loadingLinks.value = '';
  }
}

async function removeClient(c: PanelClient) {
  if (!confirm(`删除客户端「${c.email}」?会从面板上删掉这个 client,它的链接立即失效;它要是某位客户的线路,线路也一并删掉。`)) return;
  try {
    const { line_removed } = await api.deleteClient(props.panel.id, c.email);
    toast(line_removed ? '已删除,客户名下的这条线路也一并删了' : '已删除');
    emit('changed');
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <article class="card sheet" :class="{ open, bad: panel.check_error }">
    <header class="head">
      <button class="title" :aria-expanded="open" @click="emit('toggle')">
        <span class="caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
        <span class="name">{{ panel.name }}</span>
        <span class="muted small host">{{ hostOf(panel.base_url) }}</span>
      </button>
      <div class="facts small">
        <span v-if="panel.check_error" class="text-err" :title="panel.check_error">连不上:{{ panel.check_error.slice(0, 36) }}</span>
        <template v-else-if="panel.check_ok_at">
          <span class="text-ok">正常</span>
          <span class="muted">{{ panel.inbound_count ?? 0 }} 入站 · {{ panel.client_count ?? 0 }} 客户端 · {{ fmtAgo(panel.check_ok_at) }}检查</span>
          <span v-if="panel.panel_version" class="muted">面板 {{ panel.panel_version }}</span>
          <span v-if="panel.xray_version" :class="panel.xray_state === 'running' ? 'muted' : 'text-err'" :title="panel.xray_state ?? ''">
            内核 {{ panel.xray_version }}<template v-if="panel.xray_state && panel.xray_state !== 'running'">({{ panel.xray_state }})</template>
          </span>
        </template>
        <span v-else class="muted">还没检查</span>
      </div>
      <div class="ops">
        <button class="primary small-btn" @click="openCreate">创建客户端</button>
        <button class="link" :disabled="checking" @click="check">{{ checking ? '检查中…' : '检查' }}</button>
        <button class="link" :disabled="!!panel.check_error" @click="openXray">内核版本</button>
        <a class="link" :href="panel.base_url" target="_blank" rel="noopener noreferrer" title="需要用面板的账号密码登录">打开面板</a>
        <button class="link" @click="emit('edit')">编辑</button>
        <button class="link danger" @click="emit('remove')">删除</button>
      </div>
    </header>

    <div v-if="open" class="body">
      <div v-if="error" class="notice small">
        读取面板失败:{{ error }}
        <button class="link" :disabled="loading" @click="load">重试</button>
      </div>
      <p v-else-if="!detail" class="muted small loading">正在读取入站和 client…</p>
      <template v-else>
        <div class="meta small">
          <span class="muted">读取于 {{ fmtAgo(detail.fetched_at) }}</span>
          <button class="link" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
          <span class="spacer" />
          <template v-if="versions">
            <span class="muted">面板 {{ versions.panel.current }}</span>
            <template v-if="versions.panel.update_available">
              <span class="text-warn">可升级到 {{ versions.panel.latest }}</span>
              <button class="link" :disabled="upgrading" @click="upgradePanel">{{ upgrading ? '升级中…' : '升级面板' }}</button>
            </template>
            <span v-else-if="versions.panel.latest" class="muted">已是最新</span>
            <span v-else class="muted">(查不到最新版本)</span>
            <span v-if="upgradeNote" class="muted">{{ upgradeNote }}</span>
          </template>
          <button v-else class="link" :disabled="loadingVersions" @click="loadVersions">{{ loadingVersions ? '查询中…' : '检查面板更新' }}</button>
        </div>
        <section v-for="g in groups" :key="g.key" class="inbound" :class="{ off: g.inbound && !g.inbound.enable }">
          <header class="ib-head">
            <template v-if="g.inbound">
              <strong>{{ g.inbound.remark || '(无名称)' }}</strong>
              <span class="chip">{{ PROTOCOL[g.inbound.protocol] ?? g.inbound.protocol }} {{ g.inbound.port }}</span>
              <span v-if="g.inbound.transport" class="muted small">{{ g.inbound.transport }}</span>
              <span v-if="!g.inbound.enable" class="badge warn">已停用</span>
            </template>
            <strong v-else>没挂在任何入站上</strong>
            <span class="spacer" />
            <span class="muted small">{{ g.clients.length }} 个客户端</span>
          </header>
          <ul v-if="g.clients.length" class="clients">
            <li v-for="c in g.clients" :key="c.email" class="client">
              <span class="email">{{ c.email }}<span v-if="!c.enable" class="badge err">停用</span><span v-if="c.customer" class="chip owner" :title="`客户「${c.customer.name}」的线路`">{{ c.customer.name }}</span></span>
              <span class="stats small">
                <span class="muted">已用 {{ fmtBytes(c.up + c.down) }}<template v-if="c.total_bytes"> / {{ fmtBytes(c.total_bytes) }}</template></span>
                <span :class="{ 'text-warn': dueLevel(c.expiry_ms) === 'warn', 'text-err': dueLevel(c.expiry_ms) === 'err', muted: !c.expiry_ms }">{{ fmtDue(c.expiry_ms) }}</span>
                <span class="muted">在线 {{ fmtAgo(c.last_online, '—') }}</span>
              </span>
              <span class="c-ops">
                <button class="link" :disabled="loadingLinks === c.email" @click="showLinks(c)">{{ loadingLinks === c.email ? '读取中…' : '链接' }}</button>
                <button v-if="!c.customer && g.inbound?.accepts_clients" class="link" title="记成某位客户的线路,面板上不改" @click="openAssign(c)">归入客户</button>
                <button class="link danger" @click="removeClient(c)">删除</button>
              </span>
            </li>
          </ul>
          <p v-else class="muted small none">没有客户端</p>
        </section>
        <p v-if="!groups.length" class="empty small">面板上还没有入站。点「创建客户端」,会自动建一个。</p>
      </template>
    </div>
  </article>

  <Modal v-if="showCreate" :title="created ? `客户端「${created.email}」已创建` : `在「${panel.name}」上创建客户端`" @close="showCreate = false">
    <form v-if="!created" id="client-form" class="form" @submit.prevent="create">
      <label class="field">名称<input v-model="form.name" required placeholder="如 zhangsan,作为面板上 client 的 email" /></label>
      <div class="protocol-field">
        <span class="label">协议</span>
        <div class="protocols">
          <label class="row small"><input v-model="form.protocol" type="radio" value="vless" />vless(reality,TCP)</label>
          <label class="row small"><input v-model="form.protocol" type="radio" value="hy2" />hy2(hysteria2,UDP)</label>
        </div>
      </div>
      <p class="muted small hint">面板上已有这个协议的入站就直接挂上去;没有就自动新建一个(hy2 需要面板已配置证书)。</p>
    </form>
    <template v-else>
      <p class="muted small">
        挂在入站 {{ created.inbound.remark || created.inbound.port }}(端口 {{ created.inbound.port }})<template v-if="created.inbound.created">,这个入站是刚新建的</template>。把下面的链接或二维码发给使用者。
      </p>
      <ClientLinks :links="created.links" :name="created.email" />
    </template>
    <template #footer>
      <span class="spacer" />
      <template v-if="!created">
        <button @click="showCreate = false">取消</button>
        <button class="primary" form="client-form" :disabled="creating">{{ creating ? '创建中…' : '创建' }}</button>
      </template>
      <template v-else>
        <button @click="created = null">再创建一个</button>
        <button class="primary" @click="showCreate = false">完成</button>
      </template>
    </template>
  </Modal>

  <Modal v-if="showXray" :title="`「${panel.name}」的 Xray 内核`" @close="showXray = false">
    <p v-if="!versions" class="muted small">{{ loadingVersions ? '正在从面板读取版本…' : '读取失败,关掉重试' }}</p>
    <template v-else>
      <p class="small">
        当前 <strong>{{ versions.xray.current || '未知' }}</strong>
        <span :class="versions.xray.state === 'running' ? 'text-ok' : 'text-err'">{{ versions.xray.state === 'running' ? '运行中' : versions.xray.state || '状态未知' }}</span>
        <span v-if="versions.xray.error" class="text-err">{{ versions.xray.error }}</span>
      </p>
      <label class="field">
        切换到
        <select v-model="xrayPick">
          <option v-for="v in versions.xray.available" :key="v" :value="v">{{ v }}{{ v.replace(/^v/, '') === versions.xray.current ? '(当前)' : '' }}</option>
        </select>
      </label>
      <p class="muted small hint">版本列表由面板从 GitHub 读取。切换时面板下载对应版本并重启 Xray,上面所有客户端断流几秒;切到更老的版本可能不支持现有入站的配置。</p>
    </template>
    <template #footer>
      <span class="spacer" />
      <button @click="showXray = false">取消</button>
      <button class="primary" :disabled="!versions || switching || !xrayPick || xrayPick.replace(/^v/, '') === versions.xray.current" @click="switchXray">{{ switching ? '切换中…' : '切换' }}</button>
    </template>
  </Modal>

  <Modal v-if="assignFor" :title="`把「${assignFor.email}」归入客户`" @close="assignFor = null">
    <form id="assign-form" class="form" @submit.prevent="assign">
      <p class="muted small">面板上不会改任何东西,只是把这个客户端记成该客户的一条直连线路:之后它的流量计入客户额度,超额 / 到期会被停用,订阅里也会带上它。</p>
      <label class="field">
        客户
        <select v-model="assignTo">
          <option v-for="x in customers" :key="x.id" :value="x.id">{{ x.name }}{{ x.remark ? ` · ${x.remark}` : '' }}</option>
          <option value="new">新建客户…</option>
        </select>
      </label>
      <label v-if="assignTo === 'new'" class="field">新客户名称<input v-model="newName" required /></label>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="assignFor = null">取消</button>
      <button class="primary" form="assign-form" :disabled="assigning">{{ assigning ? '处理中…' : '归入' }}</button>
    </template>
  </Modal>

  <Modal v-if="linksFor" :title="`「${linksFor.email}」的链接`" @close="linksFor = null">
    <ClientLinks :links="linksFor.links" :name="linksFor.email" />
  </Modal>
</template>

<style scoped>
.card {
  overflow: hidden;
}
.card.bad {
  border-color: color-mix(in srgb, var(--fault) 40%, var(--rule));
}
.head {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 16px;
  padding: 12px 16px;
  align-items: center;
}
.title {
  grid-column: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0;
  border: none;
  background: none;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.caret {
  color: var(--ink-soft);
  font-size: 12px;
}
.name {
  font-weight: 600;
  font-size: 15px;
}
.host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.facts {
  grid-column: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding-left: 20px;
}
.ops {
  grid-column: 2;
  grid-row: 1 / span 2;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px 14px;
}
.small-btn {
  padding: 4px 10px;
  font-size: 13px;
}
.body {
  border-top: 1px solid var(--rule-soft);
  padding: 10px 16px 14px;
  background: var(--hover);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 8px;
}
.meta .spacer {
  flex: 1;
}
.loading {
  margin: 0;
}
.inbound {
  background: var(--sheet);
  border: 1px solid var(--rule);
  border-radius: 8px;
  margin-bottom: 8px;
  overflow: hidden;
}
.inbound.off {
  border-style: dashed;
}
.ib-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--rule-soft);
}
.ib-head .spacer {
  flex: 1;
}
.clients {
  list-style: none;
  margin: 0;
  padding: 0;
}
.client {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(0, 1.6fr) auto;
  gap: 4px 12px;
  align-items: center;
  padding: 7px 12px;
  border-bottom: 1px solid var(--rule-soft);
}
.client:last-child {
  border-bottom: none;
}
.email {
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.chip.owner {
  margin-left: 8px;
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.email .badge {
  margin-left: 6px;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
}
.stats > span {
  white-space: nowrap;
}
.c-ops {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
.none {
  margin: 0;
  padding: 8px 12px;
}
.empty {
  padding: 8px 0;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.protocol-field .label {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
}
.protocols {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin-top: 6px;
}
.hint {
  margin: 0;
}
@media (max-width: 720px) {
  .head {
    grid-template-columns: 1fr;
  }
  .ops {
    grid-column: 1;
    grid-row: auto;
    justify-content: flex-start;
    padding-left: 20px;
  }
  /* 手机上:第一行 email + 操作,第二行统计横排自动换行 */
  .client {
    grid-template-columns: 1fr auto;
  }
  .stats {
    grid-column: 1 / -1;
  }
  .c-ops {
    grid-column: 2;
    grid-row: 1;
  }
}
</style>
