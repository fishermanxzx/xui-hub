<script setup lang="ts">
// 客户页:每位客户一张卡片,列出线路(直连 / 中转 → 出口);新建客户后开线路,线路可看链接、删除。
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ClientLinks from '../components/ClientLinks.vue';
import LineTopology from '../components/LineTopology.vue';
import Modal from '../components/Modal.vue';
import { fmtAgo } from '../format';
import { toast, toastError } from '../toast';
import type { ClientProtocol, Customer, Line, LineKind, OpenedLine, OpenLineInput, Panel, PanelInbound, Socks } from '../types';

const customers = ref<Customer[]>([]);
const panels = ref<Panel[]>([]);
const socksList = ref<Socks[]>([]);

async function load() {
  try {
    [customers.value, panels.value, socksList.value] = await Promise.all([api.customers(), api.panels(), api.socks()]);
  } catch (e) {
    toastError(e);
  }
}
onMounted(load);

const PROTOCOL: Record<string, string> = { hysteria: 'hy2' };
const proto = (p: string) => PROTOCOL[p] ?? p;

// ---------- 新建 / 编辑客户 ----------
const editing = ref<Customer | null>(null);
const showForm = ref(false);
const saving = ref(false);
const form = ref({ name: '', remark: '' });

function openForm(c: Customer | null) {
  editing.value = c;
  form.value = { name: c?.name ?? '', remark: c?.remark ?? '' };
  showForm.value = true;
}

async function submit() {
  saving.value = true;
  try {
    const saved = editing.value ? await api.updateCustomer(editing.value.id, form.value) : await api.createCustomer(form.value);
    showForm.value = false;
    toast('已保存');
    await load();
    // 新建完直接进开线路
    if (!editing.value) openLineFor(customers.value.find((c) => c.id === saved.id) ?? saved);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(c: Customer) {
  if (!confirm(`删除客户「${c.name}」?会先删掉他在各面板上的 ${c.lines.length} 个客户端,链接立即失效。`)) return;
  try {
    const { failed } = await api.deleteCustomer(c.id);
    toast(failed.length ? `已删除,但 ${failed.length} 个客户端没从面板上删掉:${failed.map((f) => f.line).join('、')}` : '已删除', failed.length ? 'err' : 'ok');
    await load();
  } catch (e) {
    toastError(e);
  }
}

// ---------- 开线路 ----------
const lineFor = ref<Customer | null>(null);
const opening = ref(false);
const opened = ref<OpenedLine | null>(null);
const lf = ref({
  kind: 'direct' as LineKind,
  panel_id: 0,
  inbound: 'new' as 'new' | number,
  protocol: 'vless' as ClientProtocol,
  exit_kind: 'panel' as 'panel' | 'socks',
  exit_panel_id: 0,
  exit_inbound: 'new' as 'new' | number,
  socks_id: 0,
});
/** 各面板现取的入站(按面板 id 缓存) */
const inboundsOf = ref<Record<number, PanelInbound[] | 'loading' | 'error'>>({});

async function fetchInbounds(panelId: number) {
  if (!panelId || inboundsOf.value[panelId]) return;
  inboundsOf.value[panelId] = 'loading';
  try {
    inboundsOf.value[panelId] = (await api.panelInbounds(panelId)).inbounds;
  } catch {
    inboundsOf.value[panelId] = 'error';
  }
}

const CLIENT_PROTOCOLS = new Set(['vless', 'hysteria', 'trojan', 'vmess']);
const list = (id: number) => {
  const v = inboundsOf.value[id];
  return Array.isArray(v) ? v : [];
};
const clientInbounds = computed(() => list(lf.value.panel_id).filter((i) => CLIENT_PROTOCOLS.has(i.protocol) && i.enable));
const socksInbounds = computed(() => list(lf.value.exit_panel_id).filter((i) => (i.protocol === 'mixed' || i.protocol === 'socks') && i.enable));
const landingPanels = computed(() => panels.value.filter((p) => p.id !== lf.value.panel_id));

function openLineFor(c: Customer) {
  lineFor.value = c;
  opened.value = null;
  const usable = panels.value.filter((p) => !p.check_error);
  lf.value = { kind: 'direct', panel_id: usable[0]?.id ?? 0, inbound: 'new', protocol: 'vless', exit_kind: socksList.value.length && panels.value.length < 2 ? 'socks' : 'panel', exit_panel_id: 0, exit_inbound: 'new', socks_id: socksList.value[0]?.id ?? 0 };
  lf.value.exit_panel_id = landingPanels.value[0]?.id ?? 0;
  void fetchInbounds(lf.value.panel_id);
  void fetchInbounds(lf.value.exit_panel_id);
}
watch(
  () => lf.value.panel_id,
  (id) => {
    lf.value.inbound = 'new';
    void fetchInbounds(id);
    if (lf.value.exit_panel_id === id) lf.value.exit_panel_id = landingPanels.value[0]?.id ?? 0;
  },
);
watch(
  () => lf.value.exit_panel_id,
  (id) => {
    lf.value.exit_inbound = 'new';
    void fetchInbounds(id);
  },
);

const canOpen = computed(() => {
  const f = lf.value;
  if (!f.panel_id) return false;
  if (f.kind === 'relay') return f.exit_kind === 'socks' ? !!f.socks_id : !!f.exit_panel_id;
  return true;
});

async function open() {
  if (!lineFor.value) return;
  const f = lf.value;
  const body: OpenLineInput = { kind: f.kind, panel_id: f.panel_id, inbound: f.inbound === 'new' ? { protocol: f.protocol } : { id: f.inbound } };
  if (f.kind === 'relay') body.exit = f.exit_kind === 'socks' ? { kind: 'socks', socks_id: f.socks_id } : { kind: 'panel', panel_id: f.exit_panel_id, inbound_id: f.exit_inbound === 'new' ? null : f.exit_inbound };
  if (f.kind === 'relay' && !confirm('开中转线路会改中转面板的 Xray 路由并重启 Xray,中转上所有客户端会断流几秒。继续?')) return;
  opening.value = true;
  try {
    opened.value = await api.openLine(lineFor.value.id, body);
    const notes = [opened.value.created.inbound ? `中转 / 面板上新建了入站 ${opened.value.created.inbound}` : '', opened.value.created.exit_inbound ? `落地上新建了 socks 入站 ${opened.value.created.exit_inbound}` : ''].filter(Boolean);
    toast(notes.length ? `线路已开通,${notes.join(',')}` : '线路已开通');
    // 入站变了,下次打开重新取
    inboundsOf.value = {};
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    opening.value = false;
  }
}

// ---------- 线路:链接 / 删除 ----------
const linksFor = ref<{ line: Line; links: string[] } | null>(null);
const loadingLinks = ref(0);

async function showLinks(line: Line) {
  loadingLinks.value = line.id;
  try {
    linksFor.value = { line, ...(await api.lineLinks(line.customer_id, line.id)) };
  } catch (e) {
    toastError(e);
  } finally {
    loadingLinks.value = 0;
  }
}

async function removeLine(line: Line) {
  if (!confirm(`删除这条线路?会从 ${line.panel_name} 上删掉客户端 ${line.email},链接立即失效。入站和路由不动。`)) return;
  try {
    await api.deleteLine(line.customer_id, line.id);
    toast('已删除');
    await load();
  } catch (e) {
    toastError(e);
  }
}

function exitText(l: Line): string {
  if (l.kind === 'direct') return '直连';
  if (l.exit_kind === 'socks') return `中转 → SOCKS ${l.exit_socks_name ?? '(已删除)'}`;
  return `中转 → 落地 ${l.exit_panel_name ?? '(已删除)'}${l.exit_port ? ':' + l.exit_port : ''}`;
}
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>客户</h2>
      <p class="muted small">一位客户可以有多条线路:直连某块面板,或经中转面板转到落地面板 / SOCKS。每条线路就是面板上的一个客户端。</p>
    </div>
    <button class="primary" @click="openForm(null)">新建客户</button>
  </div>

  <div class="cards">
    <article v-for="c in customers" :key="c.id" class="card sheet">
      <header class="head">
        <div class="title">
          <span class="name">{{ c.name }}</span>
          <span v-if="c.remark" class="muted small">{{ c.remark }}</span>
          <span class="muted small">{{ c.lines.length }} 条线路</span>
        </div>
        <div class="ops">
          <button class="primary small-btn" :disabled="!panels.length" @click="openLineFor(c)">开线路</button>
          <button class="link" @click="openForm(c)">编辑</button>
          <button class="link danger" @click="remove(c)">删除</button>
        </div>
      </header>
      <LineTopology v-if="c.lines.length" :lines="c.lines" />
      <ul v-if="c.lines.length" class="lines">
        <li v-for="l in c.lines" :key="l.id" class="line">
          <span class="chip" :class="l.kind">{{ l.kind === 'direct' ? '直连' : '中转' }}</span>
          <span class="where">
            <strong>{{ l.panel_name }}</strong>
            <span class="muted small">{{ l.inbound_remark || l.inbound_id }} · {{ proto(l.protocol) }} · {{ l.email }}</span>
          </span>
          <span class="small exit" :class="{ muted: l.kind === 'direct' }">{{ exitText(l) }}</span>
          <span class="muted small">{{ fmtAgo(l.created_at) }}开通</span>
          <span class="l-ops">
            <button class="link" :disabled="loadingLinks === l.id" @click="showLinks(l)">{{ loadingLinks === l.id ? '读取中…' : '链接' }}</button>
            <button class="link danger" @click="removeLine(l)">删除</button>
          </span>
        </li>
      </ul>
      <p v-else class="muted small none">还没有线路,点「开线路」。</p>
    </article>
  </div>
  <div v-if="!customers.length" class="empty sheet">还没有客户。点「新建客户」,建好后给他开线路。</div>

  <Modal v-if="showForm" :title="editing ? `编辑客户「${editing.name}」` : '新建客户'" @close="showForm = false">
    <form id="customer-form" class="form" @submit.prevent="submit">
      <label class="field">名称<input v-model="form.name" required placeholder="客户端的名字会用它生成" /></label>
      <label class="field">备注<input v-model="form.remark" /></label>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">取消</button>
      <button class="primary" form="customer-form" :disabled="saving">{{ saving ? '保存中…' : editing ? '保存' : '下一步:开线路' }}</button>
    </template>
  </Modal>

  <Modal v-if="lineFor" :title="opened ? `「${lineFor.name}」的线路已开通` : `给「${lineFor.name}」开线路`" @close="lineFor = null">
    <template v-if="!opened">
      <div class="form">
        <div class="field-block">
          <span class="label">线路类型</span>
          <div class="choices">
            <label class="row small"><input v-model="lf.kind" type="radio" value="direct" />直连:客户端直接连一块面板</label>
            <label class="row small"><input v-model="lf.kind" type="radio" value="relay" />中转:客户端连中转面板,流量转到落地 / SOCKS</label>
          </div>
        </div>

        <label class="field">
          {{ lf.kind === 'relay' ? '中转面板' : '面板' }}
          <select v-model="lf.panel_id">
            <option v-for="p in panels" :key="p.id" :value="p.id" :disabled="!!p.check_error">{{ p.name }}{{ p.check_error ? '(连不上)' : '' }}</option>
          </select>
        </label>
        <div class="field-block">
          <span class="label">{{ lf.kind === 'relay' ? '中转上的入站' : '入站' }}</span>
          <div class="choices">
            <label class="row small"><input v-model="lf.inbound" type="radio" value="new" />新建入站(或复用同协议的)</label>
            <select v-if="lf.inbound === 'new'" v-model="lf.protocol" class="inline">
              <option value="vless">vless(reality)</option>
              <option value="hy2">hy2(hysteria2)</option>
            </select>
            <template v-if="inboundsOf[lf.panel_id] === 'loading'"><span class="muted small">正在读取入站…</span></template>
            <template v-else-if="inboundsOf[lf.panel_id] === 'error'"><span class="text-err small">读不到这块面板的入站</span></template>
            <template v-else-if="clientInbounds.length">
              <label v-for="i in clientInbounds" :key="i.id" class="row small">
                <input v-model="lf.inbound" type="radio" :value="i.id" />{{ i.remark || '(无名称)' }} · {{ proto(i.protocol) }} {{ i.port }} · {{ i.clients.length }} 个客户端
              </label>
            </template>
            <span v-else class="muted small">这块面板上还没有能挂客户端的入站</span>
          </div>
          <p v-if="lf.kind === 'relay' && lf.inbound !== 'new'" class="muted small hint">同一个入站上的客户端共用出口:选已有入站会把它整个路由到下面的出口。</p>
        </div>

        <template v-if="lf.kind === 'relay'">
          <div class="field-block">
            <span class="label">出口</span>
            <div class="choices">
              <label class="row small"><input v-model="lf.exit_kind" type="radio" value="panel" :disabled="!landingPanels.length" />落地面板{{ landingPanels.length ? '' : '(没有第二块面板)' }}</label>
              <label class="row small"><input v-model="lf.exit_kind" type="radio" value="socks" :disabled="!socksList.length" />SOCKS{{ socksList.length ? '' : '(SOCKS 页还没登记)' }}</label>
            </div>
          </div>
          <template v-if="lf.exit_kind === 'panel'">
            <label class="field">
              落地面板
              <select v-model="lf.exit_panel_id">
                <option v-for="p in landingPanels" :key="p.id" :value="p.id" :disabled="!!p.check_error">{{ p.name }}{{ p.check_error ? '(连不上)' : '' }}</option>
              </select>
            </label>
            <div class="field-block">
              <span class="label">落地上给中转用的 socks 入站</span>
              <div class="choices">
                <label class="row small"><input v-model="lf.exit_inbound" type="radio" value="new" />新建一个(随机端口和账号)</label>
                <template v-if="inboundsOf[lf.exit_panel_id] === 'loading'"><span class="muted small">正在读取入站…</span></template>
                <template v-else-if="socksInbounds.length">
                  <label v-for="i in socksInbounds" :key="i.id" class="row small"><input v-model="lf.exit_inbound" type="radio" :value="i.id" />{{ i.remark || '(无名称)' }} · {{ i.protocol }} {{ i.port }}</label>
                </template>
                <span v-else-if="lf.exit_panel_id" class="muted small">落地上还没有 socks / mixed 入站</span>
              </div>
            </div>
          </template>
          <label v-else class="field">
            SOCKS
            <select v-model="lf.socks_id">
              <option v-for="s in socksList" :key="s.id" :value="s.id">{{ s.name }} · {{ s.host }}:{{ s.port }}{{ s.check ? (s.check.ok ? ' · 可用' : ' · 上次测试失败') : '' }}</option>
            </select>
          </label>
        </template>
      </div>
    </template>
    <template v-else>
      <p class="muted small">
        {{ exitText(opened.line) }},客户端在 <strong>{{ opened.line.panel_name }}</strong> 的入站 {{ opened.line.inbound_remark || opened.line.inbound_id }}({{ proto(opened.line.protocol) }}),名字 {{ opened.line.email }}。把链接或二维码发给客户。
      </p>
      <ClientLinks :links="opened.links" :name="opened.line.email" />
    </template>
    <template #footer>
      <span class="spacer" />
      <template v-if="!opened">
        <button @click="lineFor = null">取消</button>
        <button class="primary" :disabled="opening || !canOpen" @click="open">{{ opening ? '开通中…' : '开通' }}</button>
      </template>
      <template v-else>
        <button @click="opened = null">再开一条</button>
        <button class="primary" @click="lineFor = null">完成</button>
      </template>
    </template>
  </Modal>

  <Modal v-if="linksFor" :title="`「${linksFor.line.email}」的链接`" @close="linksFor = null">
    <ClientLinks :links="linksFor.links" :name="linksFor.line.email" />
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
  max-width: 64ch;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 12px 16px;
}
.title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.name {
  font-weight: 600;
  font-size: 15px;
}
.ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 14px;
}
.small-btn {
  padding: 4px 10px;
  font-size: 13px;
}
.lines {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--rule-soft);
}
.line {
  display: grid;
  grid-template-columns: auto minmax(160px, 1.4fr) minmax(140px, 1fr) auto auto;
  gap: 4px 12px;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--rule-soft);
}
.line:last-child {
  border-bottom: none;
}
.chip.relay {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.where {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.where span {
  overflow-wrap: anywhere;
}
.l-ops {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
.none {
  margin: 0;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--rule-soft);
}
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field-block .label {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-bottom: 6px;
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.inline {
  max-width: 220px;
  margin-left: 22px;
}
.hint {
  margin: 6px 0 0;
}
@media (max-width: 720px) {
  .line {
    grid-template-columns: auto 1fr auto;
  }
  .exit,
  .line > .muted.small:nth-child(4) {
    grid-column: 2 / -1;
  }
}
</style>
