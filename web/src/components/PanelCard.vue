<script setup lang="ts">
// 一块面板一张卡片:头部是名称、地址、连接状态和操作;展开后现取入站和 client,可在卡片里创建客户端、看链接、删 client。
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { dueLevel, fmtAgo, fmtBytes, fmtDue, hostOf } from '../format';
import { toast, toastError } from '../toast';
import type { ClientProtocol, CreatedClient, Panel, PanelClient, PanelDetail, PanelInbound } from '../types';
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
  if (!confirm(`删除客户端「${c.email}」?会从面板上删掉这个 client,它的链接立即失效。`)) return;
  try {
    await api.deleteClient(props.panel.id, c.email);
    toast('已删除');
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
        </template>
        <span v-else class="muted">还没检查</span>
      </div>
      <div class="ops">
        <button class="primary small-btn" @click="openCreate">创建客户端</button>
        <button class="link" :disabled="checking" @click="check">{{ checking ? '检查中…' : '检查' }}</button>
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
        <div class="meta muted small">
          读取于 {{ fmtAgo(detail.fetched_at) }}
          <button class="link" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
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
              <span class="email">{{ c.email }}<span v-if="!c.enable" class="badge err">停用</span></span>
              <span class="stats small">
                <span class="muted">已用 {{ fmtBytes(c.up + c.down) }}<template v-if="c.total_bytes"> / {{ fmtBytes(c.total_bytes) }}</template></span>
                <span :class="{ 'text-warn': dueLevel(c.expiry_ms) === 'warn', 'text-err': dueLevel(c.expiry_ms) === 'err', muted: !c.expiry_ms }">{{ fmtDue(c.expiry_ms) }}</span>
                <span class="muted">在线 {{ fmtAgo(c.last_online, '—') }}</span>
              </span>
              <span class="c-ops">
                <button class="link" :disabled="loadingLinks === c.email" @click="showLinks(c)">{{ loadingLinks === c.email ? '读取中…' : '链接' }}</button>
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
  gap: 8px;
  margin-bottom: 8px;
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
