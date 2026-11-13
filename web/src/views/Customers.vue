<script setup lang="ts">
// 客户页:每位客户一张卡片,列出线路(直连 / 中转 → 出口);新建客户后开线路,线路可看链接、删除。
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ClientLinks from '../components/ClientLinks.vue';
import TopologyGraph from '../components/TopologyGraph.vue';
import Modal from '../components/Modal.vue';
import { copyText } from '../clipboard';
import QrCode from '../components/QrCode.vue';
import { bytesToGb, dateInputToMs, dueLevel, fmtAgo, fmtBytes, fmtDate, fmtDateTime, fmtDue, gbToBytes, msToDateInput, region, shortUa, STATE_LABEL, subUrl } from '../format';
import { toast, toastError } from '../toast';
import type { ClientProtocol, Customer, EnforceOp, Line, LineKind, OpenedLine, OpenLineInput, Panel, PanelInbound, Socks, SubFetch, SubTemplate } from '../types';

const customers = ref<Customer[]>([]);
const panels = ref<Panel[]>([]);
const socksList = ref<Socks[]>([]);

const templateDefault = ref('');
async function load() {
  try {
    [customers.value, panels.value, socksList.value] = await Promise.all([api.customers(), api.panels(), api.socks()]);
  } catch (e) {
    toastError(e);
  }
}
onMounted(async () => {
  await load();
  try {
    const t = await api.subTemplates();
    templates.value = t.templates;
    templateDefault.value = t.default;
  } catch (e) {
    toastError(e);
  }
});

const PROTOCOL: Record<string, string> = { hysteria: 'hy2' };
const proto = (p: string) => PROTOCOL[p] ?? p;

// ---------- 新建 / 编辑客户 ----------
const editing = ref<Customer | null>(null);
const showForm = ref(false);
const saving = ref(false);
const form = ref({ name: '', remark: '', quotaGb: '', expire: '', resetDay: '', template: '', customTemplate: '' });
/** 内置的 Clash 订阅模板;第一次打开表单时取 */
const templates = ref<SubTemplate[]>([]);
const templateName = (v: string) => templates.value.find((t) => t.id === v)?.name ?? (v ? '自定义模板' : '');

function openForm(c: Customer | null) {
  editing.value = c;
  const tpl = c?.sub_template ?? '';
  const custom = /^https:/.test(tpl);
  form.value = { name: c?.name ?? '', remark: c?.remark ?? '', quotaGb: c?.quota_bytes ? String(bytesToGb(c.quota_bytes)) : '', expire: c ? msToDateInput(c.expire_at) : '', resetDay: c?.reset_day ? String(c.reset_day) : '', template: custom ? 'custom' : tpl, customTemplate: custom ? tpl : '' };
  showForm.value = true;
}

/** 续期:在到期日(已过期或不限期则从今天)基础上加 N 天 */
function extend(days: number) {
  const base = Math.max(dateInputToMs(form.value.expire), Date.now());
  form.value.expire = msToDateInput(base + days * 86_400_000);
}

/** 面板上启停操作的结果提示 */
function opsNote(ops: EnforceOp[]): string {
  const done = (action: EnforceOp['action']) => ops.filter((o) => o.ok && o.action === action).length;
  const bad = ops.filter((o) => !o.ok);
  return [
    done('disable') ? `已停用 ${done('disable')} 个客户端` : '',
    done('enable') ? `已启用 ${done('enable')} 个客户端` : '',
    bad.length ? `${bad.length} 个操作失败:${bad.map((o) => `${o.panel} 上的 ${o.email}(${o.error})`).join('、')}` : '',
  ]
    .filter(Boolean)
    .join(';');
}

async function submit() {
  saving.value = true;
  const body = { name: form.value.name, remark: form.value.remark, quota_bytes: form.value.quotaGb === '' ? 0 : gbToBytes(Number(form.value.quotaGb)), expire_at: dateInputToMs(form.value.expire), reset_day: form.value.resetDay === '' ? 0 : Number(form.value.resetDay), sub_template: form.value.template === 'custom' ? form.value.customTemplate.trim() : form.value.template };
  try {
    const saved = editing.value ? await api.updateCustomer(editing.value.id, body) : await api.createCustomer(body);
    showForm.value = false;
    const note = opsNote((saved as { ops?: EnforceOp[] }).ops ?? []);
    toast(note ? `已保存,${note}` : '已保存', note.includes('失败') ? 'err' : 'ok');
    await load();
    // 新建完直接进开线路
    if (!editing.value) openLineFor(customers.value.find((c) => c.id === saved.id) ?? saved);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function resetUsage(c: Customer) {
  if (!confirm(`把「${c.name}」的已用流量清零?会把他 ${c.lines.length} 个客户端在面板上的流量都清零,超额停掉的会恢复。`)) return;
  try {
    const r = await api.resetUsage(c.id);
    const note = [r.failed.length ? `${r.failed.length} 个客户端没清成:${r.failed.map((f) => f.line).join('、')}` : '', opsNote(r.ops)].filter(Boolean).join(';');
    toast(note ? `已清零,${note}` : '已清零', r.failed.length ? 'err' : 'ok');
    await load();
  } catch (e) {
    toastError(e);
  }
}

const syncing = ref(false);
async function syncNow() {
  syncing.value = true;
  try {
    const { ops } = await api.syncNow();
    toast(opsNote(ops) || '已同步,没有需要启停的客户端');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    syncing.value = false;
  }
}

/** 拓扑弹窗 */
const topoFor = ref<Customer | null>(null);

// ---------- 订阅 ----------
const qrFor = ref<Customer | null>(null);
const fetchesFor = ref<{ customer: Customer; days: number; rows: SubFetch[] } | null>(null);

async function resetLink(c: Customer) {
  if (!confirm(`重置「${c.name}」的订阅链接?客户手里的旧链接立即失效,需要把新链接发给他。`)) return;
  try {
    await api.resetSubToken(c.id);
    toast('订阅链接已重置');
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function showFetches(c: Customer) {
  try {
    fetchesFor.value = { customer: c, ...(await api.subFetches(c.id)) };
  } catch (e) {
    toastError(e);
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
  // 取过的不再取;上次没读到的再试一次
  const cached = inboundsOf.value[panelId];
  if (!panelId || (cached && cached !== 'error')) return;
  inboundsOf.value[panelId] = 'loading';
  try {
    inboundsOf.value[panelId] = (await api.panelInbounds(panelId)).inbounds;
  } catch {
    inboundsOf.value[panelId] = 'error';
  }
}

const list = (id: number) => {
  const v = inboundsOf.value[id];
  return Array.isArray(v) ? v : [];
};
const clientInbounds = computed(() => list(lf.value.panel_id).filter((i) => i.accepts_clients && i.enable));
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
  if (f.kind === 'relay' && !confirm('开中转线路会给中转面板加一条路由规则并重启 Xray,中转上所有客户端会断流几秒。继续?')) return;
  opening.value = true;
  try {
    opened.value = await api.openLine(lineFor.value.id, body);
    const notes = [opened.value.created.inbound ? `中转 / 面板上新建了入站 ${opened.value.created.inbound}` : '', opened.value.created.exit_inbound ? `落地上新建了 socks 入站 ${opened.value.created.exit_inbound}` : ''].filter(Boolean);
    toast(notes.length ? `线路已开通,${notes.join(',')}` : '线路已开通');
    // 入站变了:缓存清掉,表单正用着的两块马上重取(「再开一条」接着用这张表单)
    inboundsOf.value = {};
    void fetchInbounds(f.panel_id);
    void fetchInbounds(f.exit_panel_id);
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
  if (!confirm(`删除这条线路?会从 ${line.panel_name} 上删掉客户端 ${line.email},链接立即失效${line.kind === 'relay' ? ',并去掉他的出口规则(重启 Xray)' : ''}。入站不动。`)) return;
  try {
    try {
      await api.deleteLine(line.customer_id, line.id);
    } catch (e) {
      // 面板连不上或已经不在了:可以只删这里的记录
      const left = line.kind === 'relay' ? '客户端和出口规则' : '客户端';
      if (!confirm(`面板上没删成:${e instanceof Error ? e.message : e}\n\n只删这里的线路记录?${line.panel_name} 上的${left}要是还在,得自己去面板上清理。`)) return;
      await api.deleteLine(line.customer_id, line.id, true);
    }
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
      <p class="muted small">一位客户可以有多条线路:直连某块面板,或经中转面板转到落地面板 / SOCKS,每条线路就是面板上的一个客户端。额度和到期按客户算:各线路流量加起来超过额度、或到了到期日,自动停用他所有客户端;加额度、续期或清零后自动恢复。</p>
    </div>
    <div class="row">
      <button :disabled="syncing || !customers.length" title="马上读一遍各面板的流量,并执行额度 / 到期" @click="syncNow">{{ syncing ? '同步中…' : '立即同步' }}</button>
      <button class="primary" @click="openForm(null)">新建客户</button>
    </div>
  </div>

  <div class="cards">
    <article v-for="c in customers" :key="c.id" class="card sheet">
      <header class="head">
        <div class="title">
          <span class="name">{{ c.name }}</span>
          <span v-if="c.state !== 'active'" class="badge" :class="c.state">{{ STATE_LABEL[c.state] }}</span>
          <span v-if="c.remark" class="muted small">{{ c.remark }}</span>
          <span class="muted small">{{ c.lines.length }} 条线路</span>
          <span class="small" :class="{ 'text-err': c.state === 'over_quota' }">
            已用 {{ fmtBytes(c.used) }}<template v-if="c.quota_bytes"> / {{ fmtBytes(c.quota_bytes) }}</template><span v-else class="muted">(不限额)</span>
          </span>
          <span class="small" :class="{ 'text-warn': dueLevel(c.expire_at) === 'warn', 'text-err': dueLevel(c.expire_at) === 'err', muted: !c.expire_at }" :title="fmtDate(c.expire_at)">
            {{ fmtDue(c.expire_at) }}
          </span>
          <span v-if="c.sub_template" class="muted small" :title="c.sub_template">模板:{{ templateName(c.sub_template) }}</span>
          <span v-if="c.reset_day" class="muted small" :title="c.last_reset_at ? `上次清零 ${fmtDateTime(c.last_reset_at)}` : '还没清过'">每月 {{ c.reset_day }} 号清零</span>
        </div>
        <div class="ops">
          <button class="primary small-btn" :disabled="!panels.length" @click="openLineFor(c)">开线路</button>
          <button class="link" :disabled="!c.lines.length" @click="topoFor = c">网络拓扑</button>
          <button class="link" :disabled="!c.lines.length" @click="resetUsage(c)">清零流量</button>
          <button class="link" @click="openForm(c)">编辑</button>
          <button class="link danger" @click="remove(c)">删除</button>
        </div>
      </header>
      <div class="sub-row">
        <span class="muted small">订阅</span>
        <input class="sub-input" readonly :value="subUrl(c)" aria-label="订阅链接" @focus="($event.target as HTMLInputElement).select()" />
        <button class="link" @click="copyText(subUrl(c), `已复制「${c.name}」的订阅链接`)">复制</button>
        <button class="link" @click="qrFor = c">二维码</button>
        <button class="link" @click="resetLink(c)">重置链接</button>
        <span class="muted small sub-meta" :title="c.sub_fetched_ua ?? ''">
          <template v-if="c.sub_fetched_at">上次拉取 {{ fmtAgo(c.sub_fetched_at) }}<template v-if="c.sub_fetched_ua">,{{ shortUa(c.sub_fetched_ua) }}</template>;{{ c.sub_clients }} 个客户端 / {{ c.sub_ips }} 个 IP</template>
          <template v-else>还没被拉取过</template>
          <button class="link small" @click="showFetches(c)">记录</button>
        </span>
      </div>
      <ul v-if="c.lines.length" class="lines">
        <li v-for="l in c.lines" :key="l.id" class="line">
          <span class="chip" :class="l.kind">{{ l.kind === 'direct' ? '直连' : '中转' }}</span>
          <span class="where">
            <strong>{{ l.panel_name }}</strong>
            <span class="muted small">{{ l.inbound_remark || l.inbound_id }} · {{ proto(l.protocol) }} · {{ l.email }}</span>
          </span>
          <span class="small exit" :class="{ muted: l.kind === 'direct' }">{{ exitText(l) }}</span>
          <span class="muted small stat">
            已用 {{ fmtBytes(l.up + l.down) }} · 在线 {{ fmtAgo(l.last_online, '—') }}
            <span v-if="!l.enable" class="badge err">{{ l.auto_disabled ? '已停用(超额 / 到期)' : '面板上已停用' }}</span>
          </span>
          <span class="l-ops">
            <button class="link" :disabled="loadingLinks === l.id" @click="showLinks(l)">{{ loadingLinks === l.id ? '读取中…' : '链接' }}</button>
            <button class="link danger" @click="removeLine(l)">删除</button>
          </span>
        </li>
      </ul>
      <p v-else class="muted small none">还没有线路,点「开线路」;面板上已有的客户端可以在「面板」页点「归入客户」。</p>
    </article>
  </div>
  <div v-if="!customers.length" class="empty sheet">还没有客户。点「新建客户」,建好后给他开线路。</div>

  <Modal v-if="showForm" :title="editing ? `编辑客户「${editing.name}」` : '新建客户'" @close="showForm = false">
    <form id="customer-form" class="form" @submit.prevent="submit">
      <label class="field">名称<input v-model="form.name" required placeholder="客户端的名字会用它生成" /></label>
      <label class="field">备注<input v-model="form.remark" /></label>
      <div class="two">
        <label class="field">总额度(GB,空 = 不限)<input v-model="form.quotaGb" type="number" min="0" step="1" /></label>
        <label class="field">每月清零日(1-28,空 = 不清零)<input v-model="form.resetDay" type="number" min="1" max="28" step="1" placeholder="如 1" /></label>
      </div>
      <label class="field">到期日(空 = 不限期)<input v-model="form.expire" type="date" /></label>
      <div class="row extend">
        <span class="muted small">续期</span>
        <button type="button" class="link" @click="extend(30)">+30 天</button>
        <button type="button" class="link" @click="extend(90)">+90 天</button>
        <button type="button" class="link" @click="extend(180)">+180 天</button>
        <button type="button" class="link" @click="extend(365)">+1 年</button>
        <span class="muted small">(从到期日起算,已到期的从今天起算)</span>
      </div>
      <label class="field">
        订阅模板(Clash / Mihomo / Stash / Shadowrocket 的分组和规则)
        <select v-model="form.template">
          <option v-for="t in templates" :key="t.id" :value="t.id === templateDefault ? '' : t.id">{{ t.name }} — {{ t.desc }}</option>
          <option value="custom">自定义模板地址…</option>
        </select>
      </label>
      <label v-if="form.template === 'custom'" class="field">模板地址<input v-model="form.customTemplate" required placeholder="https://… subconverter 的 ini 模板" /></label>
      <p class="muted small hint">流量按客户所有线路加总,每分钟从面板同步一次;超额或到期后自动停用他的全部客户端,改大额度、延后到期或清零流量会自动恢复。设了清零日,每月这天 0 点自动把他的流量清零。</p>
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
            <label class="row small"><input v-model="lf.inbound" type="radio" value="new" />自动:面板上有同协议的入站就挂上去,没有就新建</label>
            <select v-if="lf.inbound === 'new'" v-model="lf.protocol" class="inline">
              <option value="vless">vless(reality)</option>
              <option value="hy2">hy2(hysteria2)</option>
            </select>
            <template v-if="inboundsOf[lf.panel_id] === 'loading'"><span class="muted small">正在读取入站…</span></template>
            <template v-else-if="inboundsOf[lf.panel_id] === 'error'"><span class="text-err small">读不到这块面板的入站 <button type="button" class="link" @click="fetchInbounds(lf.panel_id)">重试</button></span></template>
            <template v-else-if="clientInbounds.length">
              <label v-for="i in clientInbounds" :key="i.id" class="row small">
                <input v-model="lf.inbound" type="radio" :value="i.id" />{{ i.remark || '(无名称)' }} · {{ proto(i.protocol) }} {{ i.port }} · {{ i.clients.length }} 个客户端
              </label>
            </template>
            <span v-else class="muted small">这块面板上还没有能挂客户端的入站</span>
          </div>
          <p v-if="lf.kind === 'relay'" class="muted small hint">出口按客户端配路由规则,同一个入站上的客户端可以各走各的出口,直连的客户端不受影响。</p>
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
                <label class="row small"><input v-model="lf.exit_inbound" type="radio" value="new" />自动:落地上有 xui-hub 建过的 socks 入站(relay-socks)就接着用,没有就新建</label>
                <template v-if="inboundsOf[lf.exit_panel_id] === 'loading'"><span class="muted small">正在读取入站…</span></template>
                <template v-else-if="inboundsOf[lf.exit_panel_id] === 'error'"><span class="text-err small">读不到落地面板的入站 <button type="button" class="link" @click="fetchInbounds(lf.exit_panel_id)">重试</button></span></template>
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

  <Modal v-if="qrFor" :title="`「${qrFor.name}」的订阅二维码`" @close="qrFor = null">
    <QrCode :text="subUrl(qrFor)" :name="`${qrFor.name}的订阅`" />
    <p class="muted small">Shadowrocket、Hiddify、Stash 等客户端扫码会直接添加订阅。订阅按客户端自动给格式:Clash、Mihomo、Stash、Shadowrocket 拿 Clash 配置,sing-box、Hiddify 拿 sing-box 配置,v2rayN 等拿节点链接。</p>
  </Modal>

  <Modal v-if="fetchesFor" :title="`「${fetchesFor.customer.name}」近 ${fetchesFor.days} 天的订阅拉取记录`" wide @close="fetchesFor = null">
    <p v-if="!fetchesFor.rows.length" class="muted small">还没有记录。</p>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr><th>时间</th><th>客户端</th><th>来源 IP</th><th>格式</th><th>结果</th></tr>
        </thead>
        <tbody>
          <tr v-for="(f, i) in fetchesFor.rows" :key="i">
            <td class="small">{{ fmtDateTime(f.at) }}</td>
            <td class="small" :title="f.ua">{{ shortUa(f.ua) || '(空 UA)' }}</td>
            <td class="small">{{ f.ip }}</td>
            <td class="small">{{ f.target }}</td>
            <td class="small" :class="f.status >= 400 ? 'text-err' : 'text-ok'">{{ f.status }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted small">来源 IP 多、客户端杂,可能是链接被分享了;「重置链接」可以让旧链接失效。</p>
  </Modal>

  <Modal v-if="topoFor" :title="`「${topoFor.name}」的网络拓扑`" wide @close="topoFor = null">
    <p class="muted small topo-hint">滚轮缩放,拖动画布或节点;点节点看下游路径和线上的协议 / 客户端名,点空白恢复。蓝边是面板,黄底是 SOCKS,虚线箭头是出网。</p>
    <TopologyGraph :customer="topoFor" :panels="panels" :socks="socksList" :height="420" />
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
.topo-hint {
  margin: 0 0 8px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.badge.over_quota {
  background: var(--caution-bg);
  color: var(--caution);
}
.badge.expired {
  background: var(--fault-bg);
  color: var(--fault);
}
.stat .badge {
  margin-left: 6px;
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
.sub-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 6px 16px 10px;
}
.sub-input {
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  padding: 4px 8px;
}
.sub-meta {
  flex-basis: 100%;
}
.sub-meta .link {
  margin-left: 8px;
}
.lines {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--rule-soft);
}
.line {
  display: grid;
  grid-template-columns: auto minmax(160px, 1.3fr) minmax(140px, 1fr) minmax(160px, 1fr) auto;
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
.extend {
  gap: 4px 10px;
  margin-top: -6px;
}
@media (max-width: 720px) {
  .line {
    grid-template-columns: auto 1fr auto;
  }
  .exit,
  .stat {
    grid-column: 2 / -1;
  }
}
</style>
