<script setup lang="ts">
// 客户页:每位客户一张卡片,列出线路(直连 / 中转 → 出口);新建客户后开线路,线路可看链接、删除。
import { t, te } from '../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ClientLinks from '../components/ClientLinks.vue';
import TopologyGraph from '../components/TopologyGraph.vue';
import Modal from '../components/Modal.vue';
import Select, { type SelectOption } from '../components/Select.vue';
import MultiSelect from '../components/MultiSelect.vue';
import { CUSTOMER_SORTS, CUSTOMER_STATES, matchState, queryCustomers, usesPanel, type CustomerQuery, type CustomerSort } from '../customerQuery';
import { copyText } from '../clipboard';
import QrCode from '../components/QrCode.vue';
import { bytesToGb, dateInputToMs, dueLevel, feeSummary, fmtAgo, fmtBytes, fmtCost, fmtDate, fmtDateTime, fmtDue, fmtSignedBytes, gbToBytes, msToDateInput, shortUa, stateLabel, subUrl, customSubUrl, routeHopText, routeTarget } from '../format';
import { toast, toastError } from '../toast';
import type { ClientProtocol, Customer, EnforceOp, Line, LineRule, OpenedLine, OpenLineInput, Panel, PanelInbound, Socks, SubDevice, SubFetch, SubTemplate } from '../types';

const customers = ref<Customer[]>([]);
const panels = ref<Panel[]>([]);
const socksList = ref<Socks[]>([]);

/** 月费合计和结余(面板 + SOCKS 的月成本) */
const fees = computed(() => feeSummary(customers.value, [...panels.value, ...socksList.value]));

// ---------- 搜索 / 过滤 / 排序 ----------
/** 排序记在浏览器里;搜索和过滤每次打开都从「全部」开始,免得以为客户少了 */
const SORT_KEY = 'xui-hub.customerSort';
function savedSort(): Pick<CustomerQuery, 'sort' | 'reverse'> {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_KEY) ?? 'null');
    if (CUSTOMER_SORTS.includes(v?.sort)) return { sort: v.sort, reverse: !!v.reverse };
  } catch {
    /* 忽略坏数据 */
  }
  return { sort: 'name', reverse: false };
}
const query = ref<CustomerQuery>({ q: '', panels: [], state: '', ...savedSort() });
watch(
  () => [query.value.sort, query.value.reverse],
  () => {
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify({ sort: query.value.sort, reverse: query.value.reverse }));
    } catch {
      /* 存不了就算了 */
    }
  },
);
// 面板删掉了就从过滤里去掉
watch(panels, (list) => {
  const ids = new Set(list.map((p) => p.id));
  if (query.value.panels.some((id) => !ids.has(id))) query.value.panels = query.value.panels.filter((id) => ids.has(id));
});
const shown = computed(() => queryCustomers(customers.value, query.value));
/** 按面板过滤时,客户卡片里不在这些面板上的线路淡一点 */
const pickedPanels = computed(() => new Set(query.value.panels));
const offPanel = (l: Line) => pickedPanels.value.size > 0 && !pickedPanels.value.has(l.panel_id) && !(l.exit_panel_id != null && pickedPanels.value.has(l.exit_panel_id));
const filtering = computed(() => !!query.value.q.trim() || !!query.value.panels.length || !!query.value.state);
function clearFilters() {
  query.value = { ...query.value, q: '', panels: [], state: '' };
}
const panelFilterOptions = computed<SelectOption<number>[]>(() =>
  panels.value.map((p) => ({ value: p.id, label: t('customers.panelOption', { name: p.name, n: customers.value.filter((c) => usesPanel(c, new Set([p.id]))).length }) })),
);
const panelFilterLabel = computed(() => {
  const picked = query.value.panels;
  if (!picked.length) return t('customers.allPanels');
  if (picked.length === 1) return panels.value.find((p) => p.id === picked[0])?.name ?? t('customers.allPanels');
  return t('customers.panelsPicked', { n: picked.length });
});
const stateOptions = computed<SelectOption<CustomerQuery['state']>[]>(() => [
  { value: '', label: t('customers.allStates') },
  ...CUSTOMER_STATES.map((s) => ({ value: s, label: t('customers.stateOption', { label: s === 'soon' ? t('customers.stateSoon') : stateLabel(s), n: customers.value.filter((c) => matchState(c, s)).length }) })),
]);
const sortOptions = computed<SelectOption<CustomerSort>[]>(() => CUSTOMER_SORTS.map((s) => ({ value: s, label: t(`customers.sort.${s}`) })));
const sortDir = computed(() => t(`customers.sortDir.${query.value.sort}${query.value.reverse ? '_r' : ''}` as 'customers.sortDir.name'));

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
const form = ref({ name: '', remark: '', fee: '', ratio: '1', adjustGb: '', quotaGb: '', expire: '', monthlyReset: false, resetDay: '', limitDevices: '', template: '', customTemplate: '', subLinks: '', upstreams: [] as { url: string; node_name: string }[], upstreamReplace: false, upstreamUserinfo: false });
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
  form.value = { name: c?.name ?? '', remark: c?.remark ?? '', fee: c?.monthly_fee == null ? '' : String(c.monthly_fee), ratio: String(c?.traffic_ratio ?? 1), adjustGb: '', quotaGb: c?.quota_bytes ? String(bytesToGb(c.quota_bytes)) : '', expire: c ? msToDateInput(c.expire_at) : '', monthlyReset: !!c?.reset_day, resetDay: c?.reset_day ? String(c.reset_day) : '', limitDevices: c?.limit_devices ? String(c.limit_devices) : '', template: custom ? 'custom' : tpl, customTemplate: custom ? tpl : '', subLinks: (c?.sub_links ?? []).join('\n'), upstreams: (c?.upstreams ?? []).map((u) => ({ url: u.url, node_name: u.node_name })), upstreamReplace: c?.upstream_mode === 'replace', upstreamUserinfo: !!c?.upstream_userinfo };
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
  const body = { name: form.value.name, remark: form.value.remark, monthly_fee: form.value.fee === '' ? null : Number(form.value.fee), traffic_ratio: form.value.ratio === '' ? 1 : Number(form.value.ratio), quota_bytes: form.value.quotaGb === '' ? 0 : gbToBytes(Number(form.value.quotaGb)), expire_at: dateInputToMs(form.value.expire), reset_day: form.value.monthlyReset ? Number(form.value.resetDay) || 1 : 0, limit_devices: form.value.limitDevices === '' ? 0 : Number(form.value.limitDevices), sub_template: form.value.template === 'custom' ? form.value.customTemplate.trim() : form.value.template, sub_links: form.value.subLinks.split('\n').map((x) => x.trim()).filter(Boolean), upstreams: form.value.upstreams.map((u) => ({ url: u.url.trim(), node_name: u.node_name.trim() })).filter((u) => u.url), upstream_mode: form.value.upstreamReplace ? ('replace' as const) : ('merge' as const), upstream_userinfo: form.value.upstreamUserinfo };
  try {
    const saved = editing.value ? await api.updateCustomer(editing.value.id, body) : await api.createCustomer(body);
    let ops = (saved as { ops?: EnforceOp[] }).ops ?? [];
    // 调整本期已用:客户信息已经存了,这一步没成就留着表单,改了再存一次
    // type="number" 的 v-model 会给数字,统一按字符串看
    const adjustText = String(form.value.adjustGb ?? '').trim();
    const adjust = editing.value && adjustText !== '' ? gbToBytes(Number(adjustText)) : 0;
    if (adjust) {
      try {
        ops = [...ops, ...(await api.adjustUsage(saved.id, { down: adjust })).ops];
        form.value.adjustGb = '';
      } catch (e) {
        await load();
        throw e;
      }
    }
    showForm.value = false;
    // 新填的外部订阅保存时马上取了一次:没取到的提醒一下(照样保存了,原因在客户卡片上)
    const missed = (saved.upstreams ?? []).filter((u) => !u.nodes).length;
    const note = [opsNote(ops), missed ? t('customers.upstreamMissed', { n: missed }) : ''].filter(Boolean).join('; ');
    toast(note ? t('customers.savedNote', { note }) : t('customers.saved'), ops.some((o) => !o.ok) || missed ? 'err' : 'ok');
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

// ---------- 批量开线路:同一块面板、同样的入站和出口,给勾上的客户各开一条(一条一条开,开完一条显示一条) ----------
interface BatchResult {
  state: 'wait' | 'doing' | 'ok' | 'err' | 'skip';
  text: string;
}
/** exits:单独改过出口的客户 → 'direct' / 'socks:<id>' / 'copy:<线路 id>'(照抄他这条现有线路的出口和出口规则) */
const batch = ref<{ ids: Set<number>; q: string; running: boolean; stop: boolean; done: boolean; results: Record<number, BatchResult>; exits: Record<number, string> } | null>(null);
function openBatch() {
  lineFor.value = null;
  opened.value = null;
  const usable = panels.value.filter((p) => !p.check_error);
  lf.value = { panel_id: usable[0]?.id ?? 0, inbound: 'new', protocol: 'vless', exit: 'direct', socks_id: socksList.value[0]?.id ?? 0, node_name: '' };
  void fetchInbounds(lf.value.panel_id);
  batch.value = { ids: new Set(), q: '', running: false, stop: false, done: false, results: {}, exits: {} };
}
/** 这位客户在这块面板上已经有几条线路 */
const onPanelCount = (c: Customer, panelId: number) => c.lines.filter((l) => l.panel_id === panelId).length;
const batchList = computed(() => {
  const q = batch.value?.q.trim().toLowerCase() ?? '';
  return customers.value.filter((c) => !q || c.name.toLowerCase().includes(q) || c.remark.toLowerCase().includes(q));
});
function batchToggle(id: number) {
  const ids = batch.value?.ids;
  if (!ids) return;
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
}
/** 全选(列表里的):已经在这块面板上有线路的跳过,要给他们再开一条就单独勾 */
function batchAll() {
  for (const c of batchList.value) if (!onPanelCount(c, lf.value.panel_id)) batch.value?.ids.add(c.id);
}
/** 能照抄的现有线路:直出,或走还在的 SOCKS;规则里用到的 SOCKS 也都还在(老的「中转到面板」那种不行) */
const socksAlive = (id: number | null | undefined) => id != null && socksList.value.some((s) => s.id === id);
const copyable = (l: Line) => (l.kind === 'direct' || (l.exit_kind === 'socks' && socksAlive(l.exit_socks_id))) && (l.rules ?? []).every((r) => r.to.kind !== 'socks' || socksAlive(r.to.socks_id));
/** 每位客户的出口各选各的:默认照抄他最新的一条现有线路,没有能照抄的就直出 */
function defaultExit(c: Customer): string {
  const latest = [...c.lines].reverse().find(copyable);
  return latest ? `copy:${latest.id}` : 'direct';
}
const exitOf = (c: Customer) => batch.value?.exits[c.id] ?? defaultExit(c);
/** 改了出口就是要给他开:顺手勾上 */
function setExit(c: Customer, v: string) {
  if (!batch.value) return;
  batch.value.exits[c.id] = v;
  batch.value.ids.add(c.id);
}
function batchExitOptions(c: Customer): SelectOption<string>[] {
  const copies = c.lines.filter(copyable).map((l) => {
    const exit = l.kind === 'relay' ? t('customers.routeSocks', { name: l.exit_socks_name ?? '' }) : t('customers.direct');
    const rules = l.rules?.length ? t('customers.batchCopyRules', { n: l.rules.length }) : '';
    return { value: `copy:${l.id}`, label: t('customers.batchCopy', { line: l.node_name ? `${l.panel_name}「${l.node_name}」` : l.panel_name, exit: exit + rules }) };
  });
  return [...copies, { value: 'direct', label: t('customers.direct') }, ...socksList.value.map((s) => ({ value: `socks:${s.id}`, label: t('customers.routeSocks', { name: s.name }) }))];
}
/** 这位客户这次要开的出口和规则 */
function planFor(c: Customer): { socks: number | null; rules: LineRule[] } {
  const v = exitOf(c);
  if (v.startsWith('copy:')) {
    const l = c.lines.find((x) => x.id === Number(v.slice(5)));
    return { socks: l?.kind === 'relay' ? (l.exit_socks_id ?? null) : null, rules: l?.rules ?? [] };
  }
  return { socks: v.startsWith('socks:') ? Number(v.slice(6)) : null, rules: [] };
}
const batchText = (r: BatchResult) =>
  r.state === 'wait' ? t('customers.batchWait') : r.state === 'doing' ? t('customers.batchDoing') : r.state === 'ok' ? t('customers.batchOk', { email: r.text }) : r.state === 'skip' ? t('customers.batchSkipped') : t('customers.batchErr', { error: r.text });
async function runBatch() {
  const b = batch.value;
  if (!b || b.running) return;
  const f = lf.value;
  const targets = customers.value.filter((c) => b.ids.has(c.id));
  if (!targets.length || !canOpen.value) return;
  const plans = new Map(targets.map((c) => [c.id, planFor(c)]));
  // 走 SOCKS 或带规则的,每条都要改一次路由、重启一次 Xray
  const xray = [...plans.values()].filter((p) => p.socks || p.rules.length).length;
  const panelName = panels.value.find((p) => p.id === f.panel_id)?.name ?? '';
  if (!confirm(xray ? t('customers.batchConfirmXray', { panel: panelName, n: targets.length, m: xray }) : t('customers.batchConfirm', { panel: panelName, n: targets.length }))) return;
  b.running = true;
  b.stop = false;
  b.done = false;
  b.results = Object.fromEntries(targets.map((c) => [c.id, { state: 'wait', text: '' } as BatchResult]));
  // 选「自动新建」时第一条会新建(或复用)入站,后面的都挂到同一个入站上
  let inbound: OpenLineInput['inbound'] = f.inbound === 'new' ? { protocol: f.protocol } : { id: f.inbound };
  let ok = 0;
  let created = '';
  for (const c of targets) {
    if (b.stop) break;
    b.results[c.id] = { state: 'doing', text: '' };
    const plan = plans.get(c.id)!;
    const body: OpenLineInput = { kind: plan.socks ? 'relay' : 'direct', panel_id: f.panel_id, inbound };
    if (plan.socks) body.exit = { kind: 'socks', socks_id: plan.socks };
    if (plan.rules.length) body.rules = plan.rules;
    if (f.node_name.trim()) body.node_name = f.node_name.trim();
    try {
      const r = await api.openLine(c.id, body);
      inbound = { id: r.line.inbound_id };
      if (r.created.inbound) created = r.created.inbound;
      b.results[c.id] = { state: 'ok', text: r.line.email };
      ok++;
    } catch (e) {
      b.results[c.id] = { state: 'err', text: e instanceof Error ? e.message : String(e) };
    }
  }
  // 点了停止:还没轮到的标成「没开」
  for (const r of Object.values(b.results)) if (r.state === 'wait') r.state = 'skip';
  const failed = Object.values(b.results).filter((r) => r.state === 'err').length;
  const skipped = Object.values(b.results).filter((r) => r.state === 'skip').length;
  b.running = false;
  b.done = true;
  b.ids = new Set(targets.filter((c) => b.results[c.id]?.state !== 'ok').map((c) => c.id));
  inboundsOf.value = {};
  void fetchInbounds(f.panel_id);
  await load();
  const note = [created ? t('customers.openedInbound', { name: created }) : '', failed ? t('customers.batchFailed', { n: failed }) : '', skipped ? t('customers.batchStopped', { n: skipped }) : ''].filter(Boolean).join('; ');
  toast(t('customers.batchDone', { n: ok }) + (note ? `;${note}` : ''), failed ? 'err' : 'ok');
}
function closeLineForm() {
  if (batch.value?.running) return;
  lineFor.value = null;
  batch.value = null;
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
// ---------- 出口规则(写到面板的 Xray 路由) ----------
interface RuleRow {
  domain: string;
  ip: string;
  port: string;
  network: string;
  /** 'direct' / 'block' / 'socks:<id>' */
  to: string;
}
const rulesFor = ref<Line | null>(null);
const ruleRows = ref<RuleRow[]>([]);
const savingRules = ref(false);
const toRow = (r: LineRule): RuleRow => ({ domain: r.domain.join('\n'), ip: r.ip.join(', '), port: r.port, network: r.network, to: r.to.kind === 'socks' ? `socks:${r.to.socks_id}` : r.to.kind });
const fromRow = (r: RuleRow): LineRule => ({
  domain: r.domain.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
  ip: r.ip.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
  port: r.port.trim(),
  network: r.network,
  to: r.to.startsWith('socks:') ? { kind: 'socks', socks_id: Number(r.to.slice(6)) } : r.to === 'block' ? { kind: 'block' } : { kind: 'direct' },
});
const ruleTargets = computed<SelectOption<string>[]>(() => [
  ...socksList.value.map((s) => ({ value: `socks:${s.id}`, label: t('customers.routeSocks', { name: s.name }) })),
  { value: 'direct', label: t('customers.direct') },
  { value: 'block', label: t('customers.routeBlock') },
]);
const networkOptions = computed<SelectOption<string>[]>(() => [
  { value: '', label: t('customers.rulesNetworkAny') },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
]);
/** 常用的几组:流媒体 / AI / 国内直连 / 去广告 */
const RULE_PRESETS: { key: string; row: Partial<RuleRow> }[] = [
  { key: 'streaming', row: { domain: 'geosite:netflix\ngeosite:disney\ngeosite:hbo\ngeosite:primevideo' } },
  { key: 'ai', row: { domain: 'geosite:openai\ngeosite:anthropic' } },
  { key: 'cn', row: { domain: 'geosite:cn', ip: 'geoip:cn', to: 'direct' } },
  { key: 'ads', row: { domain: 'geosite:category-ads-all', to: 'block' } },
];
const defaultTarget = () => (socksList.value[0] ? `socks:${socksList.value[0].id}` : 'direct');
function openRules(line: Line) {
  rulesFor.value = line;
  ruleRows.value = (line.rules ?? []).map(toRow);
}
function addRule(preset?: Partial<RuleRow>) {
  ruleRows.value.push({ domain: '', ip: '', port: '', network: '', to: defaultTarget(), ...preset });
}
function moveRule(i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= ruleRows.value.length) return;
  const rows = ruleRows.value;
  [rows[i], rows[j]] = [rows[j], rows[i]];
}
/** 线路原来的出口(规则没命中的流量走它) */
const baseExit = (l: Line) => (l.kind === 'direct' ? t('customers.direct') : l.exit_socks_name ? t('customers.routeSocks', { name: l.exit_socks_name }) : l.exit_label || t('customers.gone'));
async function saveRules() {
  const line = rulesFor.value;
  if (!line) return;
  savingRules.value = true;
  try {
    await api.setLineRules(line.customer_id, line.id, ruleRows.value.map(fromRow));
    rulesFor.value = null;
    toast(t('customers.rulesSaved', { panel: line.panel_name }));
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    savingRules.value = false;
  }
}

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
  if (!confirm(t(line.kind === 'relay' ? 'customers.confirmDeleteRelayLine' : 'customers.confirmDeleteLine', { panel: line.panel_name, email: line.email, used: fmtBytes(line.up + line.down) }))) return;
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

const refreshing = ref<number | null>(null);
async function refreshUpstreams(c: Customer) {
  refreshing.value = c.id;
  try {
    const fresh = await api.refreshUpstreams(c.id);
    const missed = fresh.upstreams.filter((u) => u.error).length;
    toast(missed ? t('customers.upstreamRefreshMissed', { n: missed }) : t('customers.upstreamRefreshed'), missed ? 'err' : 'ok');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    refreshing.value = null;
  }
}

/** 外部订阅地址只显示域名(完整地址在悬停提示里) */
function upstreamHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 面板上按规则分了多个出口(读到的路由规则不止一条去向) */
const multiExit = (l: Line) => (l.routes?.length ?? 0) > 1;

function exitText(l: Line): string {
  // 读到了面板的路由规则:以面板上实际的为准
  if (l.routes?.length === 1) {
    const to = l.routes[0].to;
    return to.kind === 'direct' ? t('customers.direct') : t('customers.exitVia', { name: routeTarget(to, socksList.value) });
  }
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
      <p v-if="fees.show" class="small summary" :title="t('customers.feeSummaryHint')">
        <span>{{ t('customers.feeTotal', { total: fmtCost(fees.income), n: fees.payers }) }}</span>
        <span v-if="fees.unset" class="muted">{{ t('customers.feeUnset', { n: fees.unset }) }}</span>
        <span v-if="fees.expired" class="muted">{{ t('customers.feeExpired', { n: fees.expired }) }}</span>
        <template v-if="fees.hasCost">
          <span class="muted">{{ t('customers.feeCost', { total: fmtCost(fees.cost) }) }}</span>
          <span :class="{ 'text-err': fees.balance < 0 }">{{ t('customers.feeBalance', { v: fmtCost(fees.balance) }) }}</span>
        </template>
      </p>
    </div>
    <div class="row">
      <button :disabled="syncing || !customers.length" :title="t('customers.syncHint')" @click="syncNow">{{ syncing ? t('customers.syncing') : t('customers.syncNow') }}</button>
      <button :disabled="!panels.length || !customers.length" :title="t('customers.batchHint')" @click="openBatch">{{ t('customers.batchButton') }}</button>
      <button class="primary" @click="openForm(null)">{{ t('customers.create') }}</button>
    </div>
  </div>

  <div v-if="customers.length" class="filters">
    <input v-model="query.q" type="search" class="search" :placeholder="t('customers.searchPlaceholder')" :aria-label="t('customers.search')" />
    <MultiSelect v-model="query.panels" :options="panelFilterOptions" :label="panelFilterLabel" :all-label="t('customers.allPanels')" :aria-label="t('customers.filterPanels')" />
    <Select v-model="query.state" :options="stateOptions" :aria-label="t('customers.filterState')" />
    <span class="sort">
      <Select v-model="query.sort" :options="sortOptions" :aria-label="t('customers.sortBy')" />
      <button type="button" class="dir" :title="t('customers.sortDirHint')" :aria-pressed="query.reverse" @click="query.reverse = !query.reverse">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3v10M2.5 10.5 5 13l2.5-2.5M11 13V3M8.5 5.5 11 3l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>{{ sortDir }}
      </button>
    </span>
    <span v-if="filtering" class="muted small">{{ t('customers.shown', { n: shown.length, total: customers.length }) }}</span>
    <button v-if="filtering" type="button" class="link" @click="clearFilters">{{ t('customers.clearFilters') }}</button>
  </div>

  <div class="cards">
    <article v-for="c in shown" :key="c.id" class="card sheet">
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
          <span v-if="c.traffic_ratio !== 1" class="small ratio" :title="t('customers.ratioHint')">{{ t('customers.ratioValue', { v: c.traffic_ratio }) }}<span class="muted"> · {{ t('customers.actualUsed', { v: fmtBytes(c.actual_used) }) }}</span></span>
          <span v-if="c.carried_up || c.carried_down" class="muted small" :title="t('customers.carriedHint')">{{ t('customers.carried', { v: fmtSignedBytes(c.carried_up + c.carried_down) }) }}</span>
          <span v-if="c.monthly_fee != null" class="muted small">{{ t('customers.feeValue', { v: fmtCost(c.monthly_fee) }) }}</span>
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
        <div v-for="u in c.upstreams" :key="u.id" class="custom-link small">
          <span class="muted">{{ t('customers.upstream') }}</span>
          <code :title="u.url">{{ upstreamHost(u.url) }}</code>
          <span v-if="u.node_name" class="node-name" :title="t('customers.upstreamNodeNameTitle')">「{{ u.node_name }}」</span>
          <span :class="u.nodes ? 'names' : 'text-err'" :title="u.names.join('\n')">{{ t('customers.upstreamNodes', { n: u.nodes }) }}</span>
          <span v-if="u.skipped" class="muted" :title="t('customers.upstreamSkippedHint')">{{ t('customers.upstreamSkipped', { n: u.skipped }) }}</span>
          <span class="muted">{{ u.ok_at ? t('customers.upstreamOk', { ago: fmtAgo(u.ok_at) }) : t('customers.upstreamNever') }}</span>
          <span v-if="u.error" class="text-warn upstream-err" :title="u.error">{{ t('customers.upstreamErr', { error: u.error }) }}</span>
        </div>
        <div v-if="c.upstreams.length" class="custom-link small">
          <span class="muted">{{ c.upstream_mode === 'replace' ? t('customers.upstreamReplace') : t('customers.upstreamMerge') }}<template v-if="c.upstream_userinfo"> · {{ t('customers.upstreamUserinfoOn') }}</template></span>
          <button class="link" :disabled="refreshing === c.id" @click="refreshUpstreams(c)">{{ refreshing === c.id ? t('customers.upstreamRefreshing') : t('customers.upstreamRefresh') }}</button>
        </div>
      </div>
      <ul v-if="c.lines.length" class="lines">
        <li v-for="l in c.lines" :key="l.id" class="line" :class="{ dim: offPanel(l) }">
          <span class="chip" :class="l.kind">{{ l.kind === 'direct' ? t('customers.direct') : t('customers.relay') }}</span>
          <span class="where">
            <strong>{{ l.panel_name }}</strong>
            <span v-if="l.node_name" class="small node-name" :title="t('customers.nodeNameTitle')">「{{ l.node_name }}」</span>
            <span class="muted small">{{ l.inbound_remark || l.inbound_id }} · {{ proto(l.protocol) }} · {{ l.email }}</span>
          </span>
          <span v-if="multiExit(l)" class="small exit hops" :title="t('customers.routesTitle', { ago: fmtAgo(l.routes_at) })">
            <span v-for="(h, i) in l.routes" :key="i" class="hop" :title="routeHopText(h, socksList)">{{ routeHopText(h, socksList) }}</span>
          </span>
          <span v-else class="small exit" :class="{ muted: exitText(l) === t('customers.direct') }" :title="l.routes ? t('customers.routesTitle', { ago: fmtAgo(l.routes_at) }) : ''">{{ exitText(l) }}</span>
          <span class="muted small stat">
            {{ t('customers.lineUsage', { used: fmtBytes(l.up + l.down), ago: fmtAgo(l.last_online, '—') }) }}
            <span v-if="!l.enable" class="badge err">{{ l.auto_disabled ? t('customers.autoDisabled') : t('customers.panelDisabled') }}</span>
          </span>
          <span class="l-ops">
            <button class="link" :disabled="loadingLinks === l.id" @click="showLinks(l)">{{ loadingLinks === l.id ? t('common.loading') : t('customers.links') }}</button>
            <button class="link" @click="openRules(l)">{{ l.rules?.length ? t('customers.rulesCount', { n: l.rules.length }) : t('customers.rules') }}</button>
            <button class="link" @click="openRename(l)">{{ t('customers.rename') }}</button>
            <button class="link danger" @click="removeLine(l)">{{ t('common.delete') }}</button>
          </span>
        </li>
      </ul>
      <p v-else class="muted small none">{{ t('customers.noLines') }}</p>
    </article>
  </div>
  <div v-if="!customers.length" class="empty sheet">{{ t('customers.empty') }}</div>
  <div v-else-if="!shown.length" class="empty sheet">
    {{ t('customers.noMatch') }} <button type="button" class="link" @click="clearFilters">{{ t('customers.clearFilters') }}</button>
  </div>

  <Modal v-if="showForm" :title="editing ? t('customers.editTitle', { name: editing.name }) : t('customers.create')" @close="showForm = false">
    <form id="customer-form" class="form" @submit.prevent="submit">
      <label class="field">{{ t('customers.name') }}<input v-model="form.name" required :placeholder="t('customers.namePlaceholder')" /></label>
      <div class="two">
        <label class="field">{{ t('customers.remark') }}<input v-model="form.remark" /></label>
        <label class="field">{{ t('customers.monthlyFee') }}<input v-model="form.fee" type="number" min="0" step="0.01" /></label>
      </div>
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
        <label class="field">{{ t('customers.trafficRatio') }}<input v-model="form.ratio" type="number" min="0.01" max="100" step="0.01" :title="t('customers.ratioHint')" /></label>
        <label v-if="editing" class="field">{{ t('customers.adjustUsage') }}<input v-model="form.adjustGb" type="number" step="any" :placeholder="t('customers.adjustPlaceholder')" :title="t('customers.adjustHint')" /></label>
      </div>
      <p class="muted small hint ratio-hint">{{ t('customers.ratioHint') }}<template v-if="editing"> {{ t('customers.adjustHint') }}</template></p>
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
      <div class="upstream-field">
        {{ t('customers.upstreams') }}
        <div v-for="(u, i) in form.upstreams" :key="i" class="upstream-row">
          <input v-model="u.url" spellcheck="false" :placeholder="t('customers.upstreamsPlaceholder')" :aria-label="t('customers.upstreamUrl')" />
          <input v-model="u.node_name" maxlength="64" :placeholder="t('customers.upstreamNodeNamePlaceholder')" :aria-label="t('customers.upstreamNodeName')" />
          <button type="button" class="link danger" @click="form.upstreams.splice(i, 1)">{{ t('common.delete') }}</button>
        </div>
        <button v-if="form.upstreams.length < 10" type="button" class="link add-upstream" @click="form.upstreams.push({ url: '', node_name: '' })">{{ t('customers.upstreamAdd') }}</button>
        <span class="muted small">{{ t('customers.upstreamsHint') }}</span>
        <span v-if="form.upstreams.length" class="muted small">{{ t('customers.upstreamNodeNameHint', { name: '{name}', n: '{n}' }) }}</span>
      </div>
      <div v-if="form.upstreams.some((u) => u.url.trim())" class="field">
        <label class="row small check"><input v-model="form.upstreamReplace" type="checkbox" />{{ t('customers.upstreamReplaceLabel') }}</label>
        <label class="row small check"><input v-model="form.upstreamUserinfo" type="checkbox" />{{ t('customers.upstreamUserinfoLabel') }}</label>
      </div>
      <p class="muted small hint">{{ t('customers.formHint') }}</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="primary" form="customer-form" :disabled="saving">{{ saving ? t('common.saving') : editing ? t('common.save') : t('customers.nextOpenLine') }}</button>
    </template>
  </Modal>

  <Modal v-if="lineFor || batch" :title="batch ? t('customers.batchTitle') : opened ? t('customers.lineOpenedTitle', { name: lineFor!.name }) : t('customers.openLineTitle', { name: lineFor!.name })" :wide="!!batch" @close="closeLineForm">
    <template v-if="!opened">
      <fieldset class="form plain" :disabled="!!batch?.running">
        <p v-if="batch" class="muted small">{{ t('customers.batchIntro') }}</p>
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

        <div v-if="!batch" class="field-block">
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
          <span v-if="batch" class="muted small">{{ t('customers.batchNodeName') }}</span>
        </label>

        <div v-if="batch" class="field-block">
          <span class="label">{{ t('customers.batchCustomers', { n: batch.ids.size }) }}</span>
          <div class="row batch-tools">
            <input v-model="batch.q" type="search" :placeholder="t('customers.batchSearch')" :aria-label="t('customers.batchSearch')" />
            <button type="button" class="link" @click="batchAll">{{ t('customers.batchAll') }}</button>
            <button type="button" class="link" @click="batch.ids.clear()">{{ t('customers.batchNone') }}</button>
          </div>
          <ul class="batch-list">
            <li class="b-row b-head muted small" aria-hidden="true">
              <span>{{ t('customers.batchColCustomer') }}</span><span>{{ t('customers.batchColExit') }}</span><span>{{ t('customers.batchColResult') }}</span>
            </li>
            <li v-for="c in batchList" :key="c.id" class="b-row" :class="{ picked: batch.ids.has(c.id) }">
              <label class="b-who small">
                <input type="checkbox" :checked="batch.ids.has(c.id)" @change="batchToggle(c.id)" />
                <span class="b-name">{{ c.name }}</span>
                <span v-if="c.state !== 'active'" class="badge" :class="c.state">{{ stateLabel(c.state) }}</span>
                <span v-if="onPanelCount(c, lf.panel_id)" class="muted">{{ t('customers.batchHas', { n: onPanelCount(c, lf.panel_id) }) }}</span>
              </label>
              <span class="b-exit"><Select :model-value="exitOf(c)" :options="batchExitOptions(c)" :aria-label="t('customers.batchExitFor', { name: c.name })" @update:model-value="(v: string) => setExit(c, v)" /></span>
              <span class="small b-res" :class="batch.results[c.id]?.state" :title="batch.results[c.id]?.text">{{ batch.results[c.id] ? batchText(batch.results[c.id]) : '' }}</span>
            </li>
            <li v-if="!batchList.length" class="muted small">{{ t('customers.batchEmpty') }}</li>
          </ul>
          <p class="muted small hint">{{ t('customers.batchExitHint') }}</p>
          <p class="muted small hint">{{ t('customers.batchAllHint') }}</p>
        </div>
      </fieldset>
    </template>
    <template v-else>
      <p class="muted small">
        {{ t('customers.openedSummary', { exit: exitText(opened.line), panel: opened.line.panel_name, inbound: opened.line.inbound_remark || opened.line.inbound_id, proto: proto(opened.line.protocol), email: opened.line.email }) }}
      </p>
      <ClientLinks :links="opened.links" :name="opened.line.email" />
    </template>
    <template #footer>
      <span class="spacer" />
      <template v-if="batch">
        <button v-if="batch.running" :disabled="batch.stop" @click="batch.stop = true">{{ batch.stop ? t('customers.batchStopping') : t('customers.batchStop') }}</button>
        <button v-else @click="closeLineForm">{{ batch.done ? t('customers.done') : t('common.cancel') }}</button>
        <button class="primary" :disabled="batch.running || !batch.ids.size || !canOpen" @click="runBatch">{{ batch.running ? t('customers.batchRunning') : t('customers.batchStart', { n: batch.ids.size }) }}</button>
      </template>
      <template v-else-if="!opened">
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

  <Modal v-if="rulesFor" :title="t('customers.rulesTitle', { panel: rulesFor.panel_name, email: rulesFor.email })" @close="rulesFor = null">
    <form id="rules-form" class="form" @submit.prevent="saveRules">
      <p class="muted small">{{ t('customers.rulesIntro') }}</p>
      <div v-for="(r, i) in ruleRows" :key="i" class="rule-card">
        <div class="rule-head">
          <strong class="small">{{ t('customers.ruleN', { n: i + 1 }) }}</strong>
          <span class="spacer" />
          <button type="button" class="link" :disabled="i === 0" :title="t('customers.ruleUp')" @click="moveRule(i, -1)">↑</button>
          <button type="button" class="link" :disabled="i === ruleRows.length - 1" :title="t('customers.ruleDown')" @click="moveRule(i, 1)">↓</button>
          <button type="button" class="link danger" @click="ruleRows.splice(i, 1)">{{ t('common.delete') }}</button>
        </div>
        <label class="field">{{ t('customers.ruleDomain') }}<textarea v-model="r.domain" rows="2" spellcheck="false" :placeholder="t('customers.ruleDomainPlaceholder')" /></label>
        <div class="two">
          <label class="field">{{ t('customers.ruleIp') }}<input v-model="r.ip" spellcheck="false" :placeholder="t('customers.ruleIpPlaceholder')" /></label>
          <label class="field">{{ t('customers.rulePort') }}<input v-model="r.port" spellcheck="false" :placeholder="t('customers.rulePortPlaceholder')" /></label>
        </div>
        <div class="two">
          <label class="field">{{ t('customers.ruleNetwork') }}<Select v-model="r.network" :options="networkOptions" /></label>
          <label class="field">{{ t('customers.ruleTo') }}<Select v-model="r.to" :options="ruleTargets" /></label>
        </div>
      </div>
      <div class="row rule-add">
        <button v-if="ruleRows.length < 20" type="button" class="link" @click="addRule()">{{ t('customers.ruleAdd') }}</button>
        <span v-if="ruleRows.length < 20" class="muted small">{{ t('customers.rulePresets') }}</span>
        <template v-if="ruleRows.length < 20">
          <button v-for="p in RULE_PRESETS" :key="p.key" type="button" class="link" @click="addRule(p.row)">{{ t(`customers.rulePreset_${p.key}`) }}</button>
        </template>
      </div>
      <p class="small">{{ t('customers.rulesRest', { exit: baseExit(rulesFor) }) }}</p>
      <p class="muted small hint">{{ t('customers.rulesHint') }}</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="rulesFor = null">{{ t('common.cancel') }}</button>
      <button class="primary" form="rules-form" :disabled="savingRules">{{ savingRules ? t('customers.rulesSaving') : t('customers.rulesSave') }}</button>
    </template>
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
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  margin-bottom: 12px;
}
.filters .search {
  flex: 1 1 220px;
  max-width: 340px;
}
.filters :deep(button.select) {
  max-width: 220px;
}
.sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dir {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  font-weight: 400;
  white-space: nowrap;
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
.upstream-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-soft);
}
.upstream-field input {
  font-size: 14px;
  font-weight: 400;
}
.upstream-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 12em) auto;
  gap: 8px;
  align-items: center;
}
.add-upstream {
  align-self: flex-start;
}
.names {
  cursor: help;
}
.rule-card {
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rule-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rule-add {
  flex-wrap: wrap;
  gap: 6px 12px;
}
.hops {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hop {
  overflow-wrap: anywhere;
}
.upstream-err {
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
.line.dim {
  opacity: 0.5;
}
.line.dim:hover,
.line.dim:focus-within {
  opacity: 1;
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
.form.plain {
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.batch-tools {
  gap: 8px 12px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.batch-tools input {
  flex: 1 1 200px;
}
.batch-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--rule);
  border-radius: 8px;
}
.batch-list li {
  padding: 6px 10px;
  border-top: 1px solid var(--rule-soft);
}
.batch-list li:first-child {
  border-top: none;
}
/* 一位客户一行:客户 | 出口 | 结果 */
.b-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 360px) minmax(80px, 130px);
  gap: 6px 12px;
  align-items: center;
}
.b-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--sheet);
}
.b-row.picked {
  background: color-mix(in srgb, var(--accent-soft) 45%, transparent);
}
.b-who {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  cursor: pointer;
  min-width: 0;
}
.b-exit {
  min-width: 0;
}
@media (max-width: 640px) {
  .b-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .b-head {
    display: none;
  }
}
.b-exit :deep(button.select) {
  width: 100%;
  font-size: 13px;
  padding: 4px 8px;
}
.b-name {
  font-weight: 500;
}
.b-res {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
}
.b-res.ok {
  color: var(--ok);
}
.b-res.err {
  color: var(--fault);
}
.b-res.doing {
  color: var(--accent-strong);
}
.reset-day {
  gap: 6px;
  align-items: center;
}
.reset-day input {
  width: 72px;
}
.ratio {
  color: var(--caution);
}
.ratio-hint {
  margin-top: -8px;
}
</style>
