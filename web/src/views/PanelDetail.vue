<script setup lang="ts">
// 面板详情:现取这台面板的入站和 client(只读);在这里创建客户端(vless / hy2)、看链接、删除 client。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import ClientLinks from '../components/ClientLinks.vue';
import Modal from '../components/Modal.vue';
import { dueLevel, fmtAgo, fmtBytes, fmtDue } from '../format';
import { toast, toastError } from '../toast';
import type { ClientProtocol, CreatedClient, PanelClient, PanelDetail, PanelInbound } from '../types';

const props = defineProps<{ id: number; name: string; url: string }>();
const emit = defineEmits<{ close: [] }>();

const detail = ref<PanelDetail | null>(null);
const loading = ref(false);
const error = ref('');
const q = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    detail.value = await api.panelInbounds(props.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const PROTOCOL: Record<string, string> = { hysteria: 'hy2', mixed: 'socks' };

const summary = computed(() => {
  const d = detail.value;
  if (!d) return null;
  const emails = new Set([...d.inbounds.flatMap((i) => i.clients), ...d.unattached].map((c) => c.email));
  return { inbounds: d.inbounds.length, off: d.inbounds.filter((i) => !i.enable).length, clients: emails.size };
});

/** 搜索:入站名匹配时整组显示,否则只显示匹配的 client */
const groups = computed(() => {
  const d = detail.value;
  if (!d) return [];
  const word = q.value.trim().toLowerCase();
  const all: { key: string; inbound: PanelInbound | null; clients: PanelClient[] }[] = [
    ...d.inbounds.map((i) => ({ key: `ib-${i.id}`, inbound: i, clients: i.clients })),
    ...(d.unattached.length ? [{ key: 'unattached', inbound: null, clients: d.unattached }] : []),
  ];
  if (!word) return all;
  return all
    .map((g) => {
      const hit = g.inbound?.remark.toLowerCase().includes(word) ?? false;
      return { ...g, hit, clients: hit ? g.clients : g.clients.filter((c) => c.email.toLowerCase().includes(word)) };
    })
    .filter((g) => g.clients.length || g.hit);
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
    created.value = await api.createClient(props.id, form.value.name, form.value.protocol);
    toast(created.value.inbound.created ? `已创建，并新建了入站 ${created.value.inbound.remark}(端口 ${created.value.inbound.port})` : '已创建');
    void load();
  } catch (e) {
    toastError(e);
  } finally {
    creating.value = false;
  }
}

// ---------- 查看链接 / 删除 ----------
const linksFor = ref<{ email: string; links: string[] } | null>(null);
const loadingLinks = ref('');

async function showLinks(c: PanelClient) {
  loadingLinks.value = c.email;
  try {
    linksFor.value = { email: c.email, ...(await api.clientLinks(props.id, c.email)) };
  } catch (e) {
    toastError(e);
  } finally {
    loadingLinks.value = '';
  }
}

async function remove(c: PanelClient) {
  if (!confirm(`删除客户端「${c.email}」？会从面板上删掉这个 client，它的链接立即失效。`)) return;
  try {
    await api.deleteClient(props.id, c.email);
    toast('已删除');
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <Modal :title="detail?.panel.name ?? name" wide @close="emit('close')">
    <div v-if="error" class="notice">
      读取面板失败：{{ error }}
      <button class="link" :disabled="loading" @click="load">重试</button>
    </div>
    <div v-else-if="!detail" class="empty">正在读取面板…</div>

    <template v-if="detail && summary">
      <section class="head">
        <dl class="facts">
          <div>
            <dt>入站</dt>
            <dd>
              <span class="figure">{{ summary.inbounds }}</span> 个<span v-if="summary.off" class="muted small">，{{ summary.off }} 个已停用</span>
            </dd>
          </div>
          <div>
            <dt>client</dt>
            <dd><span class="figure">{{ summary.clients }}</span> 个</dd>
          </div>
          <div>
            <dt>读取于</dt>
            <dd>
              {{ fmtAgo(detail.fetched_at) }}
              <button class="link refresh" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
            </dd>
          </div>
          <div>
            <dt>面板网页</dt>
            <dd><a class="link" :href="url" target="_blank" rel="noopener noreferrer" title="需要用面板的账号密码登录">打开面板</a></dd>
          </div>
        </dl>
        <div class="row">
          <input v-model="q" class="search" type="search" placeholder="搜 client 或入站" aria-label="搜 client 或入站" />
          <button class="primary" @click="openCreate">创建客户端</button>
        </div>
      </section>

      <section v-for="g in groups" :key="g.key" class="inbound" :class="{ off: g.inbound && !g.inbound.enable }">
        <header class="ib-head">
          <div v-if="g.inbound" class="ib-title">
            <h3>{{ g.inbound.remark || '(无名称)' }}</h3>
            <span class="chip">{{ PROTOCOL[g.inbound.protocol] ?? g.inbound.protocol }} {{ g.inbound.port }}</span>
            <span v-if="g.inbound.transport" class="muted small">{{ g.inbound.transport }}</span>
            <span v-if="!g.inbound.enable" class="badge warn">入站已停用</span>
          </div>
          <div v-else class="ib-title">
            <h3>没挂在任何入站上</h3>
          </div>
          <span class="ib-count muted small">{{ g.clients.length }} 个 client</span>
        </header>

        <div v-if="g.clients.length" class="table-wrap">
          <table class="clients">
            <thead>
              <tr>
                <th>client</th>
                <th class="num">已用</th>
                <th>到期</th>
                <th>最近在线</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in g.clients" :key="c.email">
                <td class="email">
                  {{ c.email }}
                  <span v-if="!c.enable" class="badge err">停用</span>
                </td>
                <td class="num">
                  {{ fmtBytes(c.up + c.down) }}<span v-if="c.total_bytes" class="muted"> / {{ fmtBytes(c.total_bytes) }}</span>
                </td>
                <td :class="{ 'text-warn': dueLevel(c.expiry_ms) === 'warn', 'text-err': dueLevel(c.expiry_ms) === 'err', muted: !c.expiry_ms }">{{ fmtDue(c.expiry_ms) }}</td>
                <td class="muted">{{ fmtAgo(c.last_online, '—') }}</td>
                <td class="num">
                  <div class="ops">
                    <button class="link" :disabled="loadingLinks === c.email" @click="showLinks(c)">{{ loadingLinks === c.email ? '读取中…' : '链接' }}</button>
                    <button class="link danger" @click="remove(c)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="none muted small">没有 client</p>
      </section>

      <div v-if="!groups.length" class="empty">
        {{ q.trim() ? '没有匹配的入站或 client' : '面板上还没有入站。点「创建客户端」，会自动建一个入站。' }}
      </div>
    </template>
  </Modal>

  <Modal v-if="showCreate" :title="created ? `客户端「${created.email}」已创建` : '创建客户端'" @close="showCreate = false">
    <form v-if="!created" id="client-form" class="form" @submit.prevent="create">
      <label class="field">名称<input v-model="form.name" required placeholder="如 zhangsan，作为面板上 client 的 email" /></label>
      <div class="protocol-field">
        <span class="label">协议</span>
        <div class="protocols">
          <label class="row small"><input v-model="form.protocol" type="radio" value="vless" />vless（reality，TCP）</label>
          <label class="row small"><input v-model="form.protocol" type="radio" value="hy2" />hy2（hysteria2，UDP）</label>
        </div>
      </div>
      <p class="muted small hint">面板上已有这个协议的入站就直接挂上去；没有就自动新建一个（hy2 需要面板已配置证书）。</p>
    </form>
    <template v-else>
      <p class="muted small">
        挂在入站 {{ created.inbound.remark || created.inbound.port }}（端口 {{ created.inbound.port }}）<template v-if="created.inbound.created">，这个入站是刚新建的</template>。把下面的链接或二维码发给使用者。
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
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 24px;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--rule-soft);
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 28px;
  margin: 0;
}
.facts dt {
  font-size: 12px;
  color: var(--ink-soft);
}
.facts dd {
  margin: 2px 0 0;
  font-variant-numeric: tabular-nums;
}
.refresh {
  margin-left: 6px;
  font-size: 12px;
}
.search {
  width: 200px;
  max-width: 100%;
}
.inbound {
  border: 1px solid var(--rule);
  border-radius: 10px;
  margin-bottom: 12px;
  overflow: hidden;
}
.inbound.off {
  border-style: dashed;
}
.ib-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--hover);
  border-bottom: 1px solid var(--rule-soft);
}
.ib-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
h3 {
  font-size: 14px;
  font-weight: 600;
}
.inbound table th {
  background: none;
}
.inbound th,
.inbound td {
  padding: 8px 14px;
}
.email {
  overflow-wrap: anywhere;
}
.ops {
  display: flex;
  justify-content: flex-end;
  gap: 14px;
}
.none {
  margin: 0;
  padding: 10px 14px;
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
@media (max-width: 640px) {
  .search {
    width: 100%;
  }
  .head .row {
    width: 100%;
  }
}
</style>
