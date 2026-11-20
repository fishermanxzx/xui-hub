<script setup lang="ts">
// 客户页:每位客户一张卡片,列出线路(直连 / 中转 → 出口);新建客户后开线路,线路可看链接、删除。
import { t, te } from '../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ClientLinks from '../components/ClientLinks.vue';
import TopologyGraph from '../components/TopologyGraph.vue';
import Modal from '../components/Modal.vue';
import Select, { type SelectOption } from '../components/Select.vue';
import { copyText } from '../clipboard';
import QrCode from '../components/QrCode.vue';
import { bytesToGb, dateInputToMs, dueLevel, fmtAgo, fmtBytes, fmtDate, fmtDateTime, fmtDue, gbToBytes, msToDateInput, shortUa, stateLabel, subUrl, customSubUrl } from '../format';
import { toast, toastError } from '../toast';
import type { ClientProtocol, Customer, EnforceOp, Line, OpenedLine, OpenLineInput, Panel, PanelInbound, Socks, SubDevice, SubFetch, SubTemplate } from '../types';

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
    const tpl = await api.subTemplates();
    templates.value = tpl.templates;
    templateDefault.value = tpl.default;
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
const form = ref({ name: '', remark: '', quotaGb: '', expire: '', monthlyReset: false, resetDay: '', limitDevices: '', template: '', customTemplate: '', subLinks: '' });
/** 内置的 Clash 订阅模板;第一次打开表单时取 */
const templates = ref<SubTemplate[]>([]);
/** 内置模板的名字和说明按界面语言给(按模板 id 查文案);语言文件里没有的新模板用服务端给的 */
const tplText = (x: SubTemplate, field: 'name' | 'desc') => (te(`subTemplates.${x.id}.${field}`) ? t(`subTemplates.${x.id}.${field}` as 'subTemplates.ACL4SSR_Online.name') : x[field]);
const templateName = (v: string) => {
  const found = templates.value.find((x) => x.id === v);
  return found ? tplText(found, 'name') : v ? t('customers.customTemplate') : '';
};

function openForm(c: Customer | null) {
  editing.value = c;
  const tpl = c?.sub_template ?? '';
  const custom = /^https:/.test(tpl);
  form.value = { name: c?.name ?? '', remark: c?.remark ?? '', quotaGb: c?.quota_bytes ? String(bytesToGb(c.quota_bytes)) : '', expire: c ? msToDateInput(c.expire_at) : '', monthlyReset: !!c?.reset_day, resetDay: c?.reset_day ? String(c.reset_day) : '', limitDevices: c?.limit_devices ? String(c.limit_devices) : '', template: custom ? 'custom' : tpl, customTemplate: custom ? tpl : '', subLinks: (c?.sub_links ?? []).join('\n') };
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
    done('disable') ? t('customers.opsDisabled', { n: done('disable') }) : '',
    done('enable') ? t('customers.opsEnabled', { n: done('enable') }) : '',
    bad.length ? t('customers.opsFailed', { n: bad.length, list: bad.map((o) => t('customers.opsFailedItem', { panel: o.panel, email: o.email, error: o.error })).join(', ') }) : '',
  ]
    .filter(Boolean)
    .join('; ');
}

async function submit() {
  saving.value = true;
  const body = { name: form.value.name, remark: form.value.remark, quota_bytes: form.value.quotaGb === '' ? 0 : gbToBytes(Number(form.value.quotaGb)), expire_at: dateInputToMs(form.value.expire), reset_day: form.value.monthlyReset ? Number(form.value.resetDay) || 1 : 0, limit_devices: form.value.limitDevices === '' ? 0 : Number(form.value.limitDevices), sub_template: form.value.template === 'custom' ? form.value.customTemplate.trim() : form.value.template, sub_links: form.value.subLinks.split('\n').map((x) => x.trim()).filter(Boolean) };
  try {
    const saved = editing.value ? await api.updateCustomer(editing.value.id, body) : await api.createCustomer(body);
    showForm.value = false;
    const ops = (saved as { ops?: EnforceOp[] }).ops ?? [];
    const note = opsNote(ops);
    toast(note ? t('customers.savedNote', { note }) : t('customers.saved'), ops.some((o) => !o.ok) ? 'err' : 'ok');
    await load();
    // 新建完直接进开线路
    if (!editing.value) openLineFor(customers.value.find((c) => c.id === saved.id) ?? saved);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

/** 勾上「每月自动重置流量」:有到期日时重置日跟着到期日走,不用填;没有到期日才要填每月几号(先填今天,只能 1-28) */
function onMonthlyReset() {
  if (form.value.monthlyReset && form.value.resetDay === '') form.value.resetDay = String(Math.min(new Date().getDate(), 28));
}

async function resetUsage(c: Customer) {
  if (!confirm(t('customers.confirmReset', { name: c.name, n: c.lines.length }))) return;
  try {
    const r = await api.resetUsage(c.id);
    const note = [r.failed.length ? t('customers.resetNotCleared', { n: r.failed.length, list: r.failed.map((f) => f.line).join(', ') }) : '', opsNote(r.ops)].filter(Boolean).join('; ');
    toast(note ? t('customers.resetDoneNote', { note }) : t('customers.resetDone'), r.failed.length ? 'err' : 'ok');
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
    toast(opsNote(ops) || t('customers.synced'));
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
const fetchesFor = ref<{ customer: Customer; days: number; rows: SubFetch[]; devices: SubDevice[] } | null>(null);
/** 「疑似分享」的门槛(设置页里的 IP 个数);没开这项提醒就是 0,不标 */
const shareIps = ref(0);
onMounted(async () => {
  try {
    const s = (await api.settings()).notify;
    shareIps.value = s.sub_share ? s.sub_share_ips : 0;
  } catch {
    /* 取不到就不标 */
  }
});

async function resetLink(c: Customer) {
  if (!confirm(t('customers.confirmResetLink', { name: c.name }) + (c.sub_links.length ? t('customers.confirmResetLinkCustom', { n: c.sub_links.length }) : ''))) return;
  try {
    await api.resetSubToken(c.id);
    toast(t('customers.linkReset'));
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function removeDevice(d: SubDevice) {
  const f = fetchesFor.value;
  if (!f || !confirm(t('customers.confirmRemoveDevice', { name: shortUa(d.ua) || t('customers.emptyUa') }))) return;
  try {
    await api.deleteDevice(f.customer.id, d.id);
    f.devices = f.devices.filter((x) => x.id !== d.id);
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function showFetches(c: Customer) {
  try {
    const [fetches, devices] = await Promise.all([api.subFetches(c.id), api.devices(c.id)]);
    fetchesFor.value = { customer: c, ...fetches, devices };
  } catch (e) {
    toastError(e);
  }
}

async function remove(c: Customer) {
  if (!confirm(t('customers.confirmDelete', { name: c.name, n: c.lines.length }))) return;
  try {
    const { failed } = await api.deleteCustomer(c.id);
    toast(failed.length ? t('customers.deletedPartly', { n: failed.length, list: failed.map((f) => f.line).join(', ') }) : t('customers.deleted'), failed.length ? 'err' : 'ok');
    await load();
  } catch (e) {
    toastError(e);
  }
}

// ---------- 开线路 ----------
const lineFor = ref<Customer | null>(null);
const opening = ref(false);
const opened = ref<OpenedLine | null>(null);
// 一条线路只动一块面板:选面板和入站,出口默认从这块面板直出,也可以选 SOCKS 页登记的代理
const lf = ref({
  panel_id: 0,
  inbound: 'new' as 'new' | number,
  protocol: 'vless' as ClientProtocol,
  exit: 'direct' as 'direct' | 'socks',
  socks_id: 0,
  node_name: '',
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
const PROTOCOL_OPTIONS: SelectOption<ClientProtocol>[] = [
  { value: 'vless', label: 'vless(reality)' },
  { value: 'hy2', label: 'hy2(hysteria2)' },
];
const panelOptions = (list: Panel[]): SelectOption<number>[] => list.map((p) => ({ value: p.id, label: p.name + (p.check_error ? t('customers.unreachable') : ''), disabled: !!p.check_error }));
/** 出口下拉:只显示 IP(同一 IP 有几个端口时带上端口);名字和 IP 不一样时名字放前面 */
const socksOptions = computed<SelectOption<number>[]>(() =>
  socksList.value.map((s) => {
    const addr = socksList.value.some((o) => o.id !== s.id && o.host === s.host) ? `${s.host}:${s.port}` : s.host;
    return { value: s.id, label: s.name === s.host || s.name === addr ? addr : `${s.name}(${addr})` };
  }),
);
const templateOptions = computed<SelectOption<string>[]>(() => [...templates.value.map((x) => ({ value: x.id === templateDefault.value ? '' : x.id, label: `${tplText(x, 'name')} — ${tplText(x, 'desc')}` })), { value: 'custom', label: t('customers.customTemplateOption') }]);

function openLineFor(c: Customer) {
  lineFor.value = c;
  opened.value = null;
  const usable = panels.value.filter((p) => !p.check_error);
  lf.value = { panel_id: usable[0]?.id ?? 0, inbound: 'new', protocol: 'vless', exit: 'direct', socks_id: socksList.value[0]?.id ?? 0, node_name: '' };
  void fetchInbounds(lf.value.panel_id);
}
watch(
  () => lf.value.panel_id,
  (id) => {
    lf.value.inbound = 'new';
    void fetchInbounds(id);
  },
);

const canOpen = computed(() => {
  const f = lf.value;
  if (!f.panel_id) return false;
  return f.exit === 'direct' || !!f.socks_id;
});

async function open() {
  if (!lineFor.value) return;
  const f = lf.value;
  const viaSocks = f.exit === 'socks';
  const body: OpenLineInput = { kind: viaSocks ? 'relay' : 'direct', panel_id: f.panel_id, inbound: f.inbound === 'new' ? { protocol: f.protocol } : { id: f.inbound } };
  if (viaSocks) body.exit = { kind: 'socks', socks_id: f.socks_id };
  if (f.node_name.trim()) body.node_name = f.node_name.trim();
  if (viaSocks && !confirm(t('customers.confirmRelay', { panel: panels.value.find((p) => p.id === f.panel_id)?.name ?? '' }))) return;
  opening.value = true;
  try {
    opened.value = await api.openLine(lineFor.value.id, body);
    const created = opened.value.created.inbound;
    toast(created ? t('customers.lineOpenedNote', { note: t('customers.openedInbound', { name: created }) }) : t('customers.lineOpened'));
    // 入站变了:缓存清掉,表单正用着的面板马上重取(「再开一条」接着用这张表单)
    inboundsOf.value = {};
    void fetchInbounds(f.panel_id);
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

// ---------- 线路:改节点名 ----------
const renameFor = ref<Line | null>(null);
const renameText = ref('');
const renaming = ref(false);
function openRename(line: Line) {
  renameFor.value = line;
  renameText.value = line.node_name;
}
async function saveRename() {
  const line = renameFor.value;
  if (!line) return;
  renaming.value = true;
  try {
    await api.renameLine(line.customer_id, line.id, renameText.value.trim());
    renameFor.value = null;
    toast(t('customers.renamed'));
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    renaming.value = false;
  }
}

async function removeLine(line: Line) {
  if (!confirm(t(line.kind === 'relay' ? 'customers.confirmDeleteRelayLine' : 'customers.confirmDeleteLine', { panel: line.panel_name, email: line.email }))) return;
  try {
    try {
      await api.deleteLine(line.customer_id, line.id);
    } catch (e) {
      // 面板连不上或已经不在了:可以只删这里的记录
      if (!confirm(t(line.kind === 'relay' ? 'customers.confirmForceRelay' : 'customers.confirmForce', { error: e instanceof Error ? e.message : String(e), panel: line.panel_name }))) return;
      await api.deleteLine(line.customer_id, line.id, true);
    }
    toast(t('customers.deleted'));
    await load();
  } catch (e) {
    toastError(e);
  }
}

function exitText(l: Line): string {
  if (l.kind === 'direct') return t('customers.direct');
  if (l.exit_kind === 'socks') return t('customers.relayToSocks', { name: l.exit_socks_name ?? t('customers.gone') });
  return t('customers.relayToPanel', { name: `${l.exit_panel_name ?? t('customers.gone')}${l.exit_port ? ':' + l.exit_port : ''}` });
}
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>{{ t('customers.title') }}</h2>
      <p class="muted small">{{ t('customers.intro') }}</p>
    </div>
    <div class="row">
      <button :disabled="syncing || !customers.length" :title="t('customers.syncHint')" @click="syncNow">{{ syncing ? t('customers.syncing') : t('customers.syncNow') }}</button>
      <button class="primary" @click="openForm(null)">{{ t('customers.create') }}</button>
    </div>
  </div>

  <div class="cards">
    <article v-for="c in customers" :key="c.id" class="card sheet">
      <header class="head">
        <div class="title">
          <span class="name">{{ c.name }}</span>
          <span v-if="c.state !== 'active'" class="badge" :class="c.state">{{ stateLabel(c.state) }}</span>
          <span v-if="c.remark" class="muted small">{{ c.remark }}</span>
          <span class="muted small">{{ t('customers.lineCount', { n: c.lines.length }, c.lines.length) }}</span>
          <span class="small" :class="{ 'text-err': c.state === 'over_quota' }">
            {{ t('customers.used', { used: fmtBytes(c.used) }) }}<template v-if="c.quota_bytes"> / {{ fmtBytes(c.quota_bytes) }}</template><span v-else class="muted">{{ t('customers.unlimited') }}</span>
          </span>
          <span class="small" :class="{ 'text-warn': dueLevel(c.expire_at) === 'warn', 'text-err': dueLevel(c.expire_at) === 'err', muted: !c.expire_at }" :title="fmtDate(c.expire_at)">
            {{ fmtDue(c.expire_at) }}
          </span>
          <span v-if="c.sub_template" class="muted small" :title="c.sub_template">{{ t('customers.template', { name: templateName(c.sub_template) }) }}</span>
          <span v-if="c.limit_devices" class="small" :class="c.sub_devices >= c.limit_devices ? 'text-warn' : 'muted'" :title="t('customers.devicesHint')">{{ t('customers.devices', { n: c.sub_devices, max: c.limit_devices }) }}</span>
          <span v-if="c.next_reset_at" class="muted small" :title="c.expire_at ? t('customers.resetFollows') : t('customers.resetEveryDay', { day: c.reset_day })">{{ t('customers.nextReset', { date: fmtDate(c.next_reset_at) }) }}</span>
        </div>
        <div class="ops">
          <button class="primary small-btn" :disabled="!panels.length" @click="openLineFor(c)">{{ t('customers.openLine') }}</button>
          <button class="link" :disabled="!c.lines.length" @click="topoFor = c">{{ t('customers.topology') }}</button>
          <button class="link" :disabled="!c.lines.length" @click="resetUsage(c)">{{ t('customers.resetUsage') }}</button>
          <button class="link" @click="openForm(c)">{{ t('common.edit') }}</button>
          <button class="link danger" @click="remove(c)">{{ t('common.delete') }}</button>
        </div>
      </header>
      <div class="sub-row">
        <span class="muted small">{{ t('customers.sub') }}</span>
        <input class="sub-input" readonly :value="subUrl(c)" :aria-label="t('customers.subAria')" @focus="($event.target as HTMLInputElement).select()" />
        <button class="link" @click="copyText(subUrl(c), t('customers.subCopied', { name: c.name }))">{{ t('common.copy') }}</button>
        <button class="link" @click="qrFor = c">{{ t('customers.qr') }}</button>
        <button class="link" @click="resetLink(c)">{{ t('customers.resetLink') }}</button>
        <span class="muted small sub-meta" :title="c.sub_fetched_ua ?? ''">
          <template v-if="c.sub_fetched_at">{{ t('customers.lastFetch', { ago: fmtAgo(c.sub_fetched_at) }) }}<template v-if="c.sub_fetched_ua">, {{ shortUa(c.sub_fetched_ua) }}</template>{{ t('customers.fetchStats', { clients: c.sub_clients, ips: c.sub_ips }) }}</template>
          <template v-else>{{ t('customers.neverFetched') }}</template>
          <span v-if="shareIps && c.sub_ips_day >= shareIps" class="text-warn" :title="t('customers.shareHint', { n: c.sub_ips_day })">{{ t('customers.shareWarn', { n: c.sub_ips_day }) }}</span>
          <button class="link small" @click="showFetches(c)">{{ t('customers.records') }}</button>
        </span>
        <div v-for="l in c.sub_links" :key="l" class="custom-link small">
          <span class="muted">{{ t('customers.customLink') }}</span>
          <code :title="customSubUrl(c, l)">{{ customSubUrl(c, l) }}</code>
          <button class="link" @click="copyText(customSubUrl(c, l), t('customers.subCopied', { name: c.name }))">{{ t('common.copy') }}</button>
        </div>
      </div>
      <ul v-if="c.lines.length" class="lines">
        <li v-for="l in c.lines" :key="l.id" class="line">
          <span class="chip" :class="l.kind">{{ l.kind === 'direct' ? t('customers.direct') : t('customers.relay') }}</span>
          <span class="where">
            <strong>{{ l.panel_name }}</strong>
            <span v-if="l.node_name" class="small node-name" :title="t('customers.nodeNameTitle')">「{{ l.node_name }}」</span>
            <span class="muted small">{{ l.inbound_remark || l.inbound_id }} · {{ proto(l.protocol) }} · {{ l.email }}</span>
          </span>
          <span class="small exit" :class="{ muted: l.kind === 'direct' }">{{ exitText(l) }}</span>
          <span class="muted small stat">
            {{ t('customers.lineUsage', { used: fmtBytes(l.up + l.down), ago: fmtAgo(l.last_online, '—') }) }}
            <span v-if="!l.enable" class="badge err">{{ l.auto_disabled ? t('customers.autoDisabled') : t('customers.panelDisabled') }}</span>
          </span>
          <span class="l-ops">
            <button class="link" :disabled="loadingLinks === l.id" @click="showLinks(l)">{{ loadingLinks === l.id ? t('common.loading') : t('customers.links') }}</button>
            <button class="link" @click="openRename(l)">{{ t('customers.rename') }}</button>
            <button class="link danger" @click="removeLine(l)">{{ t('common.delete') }}</button>
          </span>
        </li>
      </ul>
      <p v-else class="muted small none">{{ t('customers.noLines') }}</p>
    </article>
  </div>
  <div v-if="!customers.length" class="empty sheet">{{ t('customers.empty') }}</div>

  <Modal v-if="showForm" :title="editing ? t('customers.editTitle', { name: editing.name }) : t('customers.create')" @close="showForm = false">
    <form id="customer-form" class="form" @submit.prevent="submit">
      <label class="field">{{ t('customers.name') }}<input v-model="form.name" required :placeholder="t('customers.namePlaceholder')" /></label>
      <label class="field">{{ t('customers.remark') }}<input v-model="form.remark" /></label>
      <div class="two">
        <label class="field">{{ t('customers.quota') }}<input v-model="form.quotaGb" type="number" min="0" step="1" /></label>
        <div class="field">
          <label class="row small check"><input v-model="form.monthlyReset" type="checkbox" @change="onMonthlyReset" />{{ t('customers.monthlyReset') }}</label>
          <span v-if="!form.monthlyReset" class="muted small">{{ t('customers.monthlyOff') }}</span>
          <span v-else-if="form.expire" class="muted small">{{ t('customers.monthlyFollow', { day: Number(form.expire.slice(8, 10)) }) }}</span>
          <i18n-t v-else keypath="customers.monthlyDay" tag="span" class="row small reset-day" scope="global"><template #day><input v-model="form.resetDay" type="number" min="1" max="28" step="1" required :aria-label="t('customers.monthlyDayAria')" /></template></i18n-t>
        </div>
      </div>
      <div class="two">
        <label class="field">{{ t('customers.expire') }}<input v-model="form.expire" type="date" /></label>
        <label class="field">{{ t('customers.limitDevices') }}<input v-model="form.limitDevices" type="number" min="1" max="100" step="1" :placeholder="t('customers.limitPlaceholder')" /></label>
      </div>
      <div class="row extend">
        <span class="muted small">{{ t('customers.renew') }}</span>
        <button type="button" class="link" @click="extend(30)">{{ t('customers.plusDays', { n: 30 }) }}</button>
        <button type="button" class="link" @click="extend(90)">{{ t('customers.plusDays', { n: 90 }) }}</button>
        <button type="button" class="link" @click="extend(180)">{{ t('customers.plusDays', { n: 180 }) }}</button>
        <button type="button" class="link" @click="extend(365)">{{ t('customers.plusYear') }}</button>
        <span class="muted small">{{ t('customers.renewHint') }}</span>
      </div>
      <label class="field">
        {{ t('customers.subTemplate') }}
        <Select v-model="form.template" :options="templateOptions" />
      </label>
      <label v-if="form.template === 'custom'" class="field">{{ t('customers.templateUrl') }}<input v-model="form.customTemplate" required :placeholder="t('customers.templateUrlPlaceholder')" /></label>
      <label class="field">
        {{ t('customers.subLinks') }}
        <textarea v-model="form.subLinks" rows="2" spellcheck="false" :placeholder="t('customers.subLinksPlaceholder')" />
        <span class="muted small">{{ t('customers.subLinksHint') }}</span>
      </label>
      <p class="muted small hint">{{ t('customers.formHint') }}</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="primary" form="customer-form" :disabled="saving">{{ saving ? t('common.saving') : editing ? t('common.save') : t('customers.nextOpenLine') }}</button>
    </template>
  </Modal>

  <Modal v-if="lineFor" :title="opened ? t('customers.lineOpenedTitle', { name: lineFor.name }) : t('customers.openLineTitle', { name: lineFor.name })" @close="lineFor = null">
    <template v-if="!opened">
      <div class="form">
        <label class="field">
          {{ t('customers.panel') }}
          <Select v-model="lf.panel_id" :options="panelOptions(panels)" />
        </label>
        <div class="field-block">
          <span class="label">{{ t('customers.inbound') }}</span>
          <div class="choices">
            <label class="row small"><input v-model="lf.inbound" type="radio" value="new" />{{ t('customers.inboundAuto') }}</label>
            <span v-if="lf.inbound === 'new'" class="inline"><Select v-model="lf.protocol" :options="PROTOCOL_OPTIONS" :aria-label="t('customers.inboundAuto')" /></span>
            <template v-if="inboundsOf[lf.panel_id] === 'loading'"><span class="muted small">{{ t('customers.readingInbounds') }}</span></template>
            <template v-else-if="inboundsOf[lf.panel_id] === 'error'"><span class="text-err small">{{ t('customers.inboundsError') }} <button type="button" class="link" @click="fetchInbounds(lf.panel_id)">{{ t('customers.retry') }}</button></span></template>
            <template v-else-if="clientInbounds.length">
              <label v-for="i in clientInbounds" :key="i.id" class="row small">
                <input v-model="lf.inbound" type="radio" :value="i.id" />{{ t('customers.inboundOption', { remark: i.remark || t('customers.unnamed'), proto: proto(i.protocol), port: i.port, n: i.clients.length }) }}
              </label>
            </template>
            <span v-else class="muted small">{{ t('customers.noInbounds') }}</span>
          </div>
        </div>

        <div class="field-block">
          <span class="label">{{ t('customers.exit') }}</span>
          <div class="choices">
            <label class="row small"><input v-model="lf.exit" type="radio" value="direct" />{{ t('customers.exitDirect') }}</label>
            <label class="row small"><input v-model="lf.exit" type="radio" value="socks" :disabled="!socksList.length" />{{ t('customers.exitSocks') }}{{ socksList.length ? '' : t('customers.noSocks') }}</label>
            <span v-if="lf.exit === 'socks'" class="inline"><Select v-model="lf.socks_id" :options="socksOptions" :aria-label="t('customers.exitSocks')" /></span>
          </div>
          <p class="muted small hint">{{ t('customers.relayHint') }}</p>
        </div>
        <label class="field">
          {{ t('customers.nodeNameOptional') }}
          <input v-model="lf.node_name" maxlength="64" :placeholder="t('customers.nodeNamePlaceholder')" />
        </label>
      </div>
    </template>
    <template v-else>
      <p class="muted small">
        {{ t('customers.openedSummary', { exit: exitText(opened.line), panel: opened.line.panel_name, inbound: opened.line.inbound_remark || opened.line.inbound_id, proto: proto(opened.line.protocol), email: opened.line.email }) }}
      </p>
      <ClientLinks :links="opened.links" :name="opened.line.email" />
    </template>
    <template #footer>
      <span class="spacer" />
      <template v-if="!opened">
        <button @click="lineFor = null">{{ t('common.cancel') }}</button>
        <button class="primary" :disabled="opening || !canOpen" @click="open">{{ opening ? t('customers.opening') : t('customers.open') }}</button>
      </template>
      <template v-else>
        <button @click="opened = null">{{ t('customers.another') }}</button>
        <button class="primary" @click="lineFor = null">{{ t('customers.done') }}</button>
      </template>
    </template>
  </Modal>

  <Modal v-if="qrFor" :title="t('customers.qrTitle', { name: qrFor.name })" @close="qrFor = null">
    <QrCode :text="subUrl(qrFor)" :name="t('customers.qrName', { name: qrFor.name })" />
    <p class="muted small">{{ t('customers.qrHint') }}</p>
  </Modal>

  <Modal v-if="fetchesFor" :title="t('customers.fetchesTitle', { name: fetchesFor.customer.name })" wide @close="fetchesFor = null">
    <h4 class="sec">{{ t('customers.devicesHead') }}<span class="muted small">{{ fetchesFor.customer.limit_devices ? t('customers.devicesCountMax', { n: fetchesFor.devices.length, max: fetchesFor.customer.limit_devices }) : t('customers.devicesCount', { n: fetchesFor.devices.length }) }}</span></h4>
    <p v-if="!fetchesFor.devices.length" class="muted small">{{ t('customers.noDevices') }}</p>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr><th>{{ t('customers.colClient') }}</th><th>{{ t('customers.colLastIp') }}</th><th>{{ t('customers.colFirst') }}</th><th>{{ t('customers.colLast') }}</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="d in fetchesFor.devices" :key="d.id">
            <td class="small" :title="d.ua">{{ shortUa(d.ua) || t('customers.emptyUa') }}</td>
            <td class="small">{{ d.ip }}</td>
            <td class="small">{{ fmtDateTime(d.first_at) }}</td>
            <td class="small">{{ fmtDateTime(d.last_at) }}</td>
            <td><button class="link danger small" @click="removeDevice(d)">{{ t('customers.remove') }}</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted small">{{ t('customers.devicesNote') }}</p>
    <h4 class="sec">{{ t('customers.fetchesHead', { n: fetchesFor.days }) }}</h4>
    <p v-if="!fetchesFor.rows.length" class="muted small">{{ t('customers.noFetches') }}</p>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr><th>{{ t('customers.colTime') }}</th><th>{{ t('customers.colClient') }}</th><th>{{ t('customers.colIp') }}</th><th>{{ t('customers.colFormat') }}</th><th>{{ t('customers.colResult') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="(f, i) in fetchesFor.rows" :key="i">
            <td class="small">{{ fmtDateTime(f.at) }}</td>
            <td class="small" :title="f.ua">{{ shortUa(f.ua) || t('customers.emptyUa') }}</td>
            <td class="small">{{ f.ip }}</td>
            <td class="small">{{ f.target }}</td>
            <td class="small" :class="f.status >= 400 ? 'text-err' : 'text-ok'">{{ f.status }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted small">{{ t('customers.fetchesNote') }}</p>
  </Modal>

  <Modal v-if="topoFor" :title="t('customers.topoTitle', { name: topoFor.name })" wide @close="topoFor = null">
    <p class="muted small topo-hint">{{ t('customers.topoHint') }}</p>
    <TopologyGraph :customer="topoFor" :panels="panels" :socks="socksList" :height="420" />
  </Modal>

  <Modal v-if="renameFor" :title="t('customers.renameTitle', { panel: renameFor.panel_name, email: renameFor.email })" @close="renameFor = null">
    <form id="rename-form" class="form" @submit.prevent="saveRename">
      <label class="field">
        {{ t('customers.nodeName') }}
        <input v-model="renameText" maxlength="64" autofocus :placeholder="t('customers.nodeNamePlaceholder')" />
      </label>
      <p class="muted small hint">{{ t('customers.nodeNameHint') }}</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="renameFor = null">{{ t('common.cancel') }}</button>
      <button class="primary" form="rename-form" :disabled="renaming">{{ renaming ? t('common.saving') : t('common.save') }}</button>
    </template>
  </Modal>

  <Modal v-if="linksFor" :title="t('customers.linksTitle', { email: linksFor.line.email })" @close="linksFor = null">
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
.sec {
  margin: 12px 0 6px;
  font-size: 14px;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.sec:first-child {
  margin-top: 0;
}
.sub-meta {
  flex-basis: 100%;
}
.node-name {
  font-weight: 500;
}
.custom-link {
  flex-basis: 100%;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.custom-link code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.check {
  gap: 8px;
  cursor: pointer;
  min-height: 36px;
}
.reset-day {
  gap: 6px;
  align-items: center;
}
.reset-day input {
  width: 72px;
}
</style>
