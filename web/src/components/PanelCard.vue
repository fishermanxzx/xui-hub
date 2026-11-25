<script setup lang="ts">
// 一块面板一张卡片:头部是名称、地址、连接状态和操作;展开后现取入站和 client,可在卡片里创建客户端、看链接、删 client。
import { t } from '../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { dueClass, dueLevel, fmtAgo, fmtBytes, fmtCost, fmtDate, fmtDue, hostOf } from '../format';
import { toast, toastError } from '../toast';
import type { ClientProtocol, CreatedClient, Customer, Panel, PanelClient, PanelDetail, PanelInbound, PanelVersions } from '../types';
import ClientLinks from './ClientLinks.vue';
import Modal from './Modal.vue';
import Select, { type SelectOption } from './Select.vue';
import ActionMenu, { type MenuItem } from './ActionMenu.vue';
import AssetRenew from './AssetRenew.vue';

const props = defineProps<{ panel: Panel; open: boolean; /** 面板页正按这些标签筛 */ pickedTags?: string[] }>();
/** 地址是域名时,检查时解析出的 IP;地址本身就是 IP 就不重复显示 */
const resolvedIp = computed(() => {
  const ip = props.panel.ip;
  if (!ip) return '';
  try {
    return new URL(props.panel.base_url).hostname.replace(/^\[|\]$/g, '') === ip ? '' : ip;
  } catch {
    return ip;
  }
});
const emit = defineEmits<{ toggle: []; edit: []; remove: []; changed: []; tag: [tag: string] }>();

// ---------- 一键改名:这块面板上的线路都用面板的节点名 ----------
const renaming = ref(false);
async function applyLineNames() {
  if (!confirm(t('card.lineNamesConfirm', { panel: props.panel.name, n: props.panel.line_count, name: props.panel.node_name }))) return;
  renaming.value = true;
  try {
    const r = await api.panelLineNames(props.panel.id);
    toast(t('card.lineNamesDone', { n: props.panel.line_count, name: props.panel.node_name, changed: r.changed }));
    emit('changed');
  } catch (e) {
    toastError(e);
  } finally {
    renaming.value = false;
  }
}

// ---------- 续费:顺延到期日,付了钱在账本记一笔支出 ----------
const renewing = ref(false);
const renewSaving = ref(false);
function onRenewed() {
  renewing.value = false;
  emit('changed');
}

/** 「⋯」里的操作:检查、内核、重启、打开后台、续费、统一节点名、卸载 */
const menuItems = computed<MenuItem[]>(() => [
  { label: checking.value ? t('card.checking') : t('card.check'), run: check, disabled: checking.value },
  { label: t('card.xray'), run: openXray, disabled: !!props.panel.check_error },
  { label: restarting.value ? t('card.restarting') : t('card.restart'), run: restart, disabled: restarting.value, title: t('card.restartHint') },
  { label: t('card.openPanel'), run: () => window.open(props.panel.base_url, '_blank', 'noopener,noreferrer'), title: t('card.openPanelHint') },
  { label: t('card.renew'), run: () => (renewing.value = true), title: t('card.renewHint'), divide: true },
  ...(props.panel.node_name && props.panel.line_count ? [{ label: t('card.lineNames'), run: applyLineNames, disabled: renaming.value, title: t('card.lineNamesHint'), divide: true }] : []),
  { label: t('card.uninstallPanel'), run: () => emit('remove'), danger: true, divide: true },
]);

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
    toast(p.check_error ? t('card.down', { error: p.check_error }) : t('card.ok'), p.check_error ? 'err' : 'ok');
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
const xrayOptions = computed<SelectOption<string>[]>(() => (versions.value?.xray.available ?? []).map((v) => ({ value: v, label: v + (v.replace(/^v/, '') === versions.value!.xray.current ? t('card.currentMark') : '') })));
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
  if (!confirm(t('card.confirmXray', { name: props.panel.name, v }))) return;
  switching.value = true;
  try {
    await api.installXray(props.panel.id, v);
    toast(t('card.xraySwitched', { v }));
    showXray.value = false;
    versions.value = null;
    emit('changed');
  } catch (e) {
    toastError(e);
  } finally {
    switching.value = false;
  }
}

// ---------- 重启面板和内核 ----------
const restarting = ref(false);
async function restart() {
  if (!confirm(t('card.confirmRestart', { name: props.panel.name }))) return;
  restarting.value = true;
  try {
    await api.restartPanel(props.panel.id);
    toast(t('card.restarted'));
    emit('changed');
  } catch (e) {
    toastError(e);
    emit('changed');
  } finally {
    restarting.value = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function upgradePanel() {
  const latest = versions.value?.panel.latest;
  if (!confirm(latest ? t('card.confirmUpgradeTo', { name: props.panel.name, v: latest }) : t('card.confirmUpgrade', { name: props.panel.name }))) return;
  upgrading.value = true;
  upgradeNote.value = t('card.upgradeNotified');
  try {
    const { run_id } = await api.upgradePanel(props.panel.id);
    // 面板在后台跑升级脚本,这里每 5 秒问一次结果,最多等 5 分钟
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      let st;
      try {
        st = await api.updateStatus(props.panel.id);
      } catch {
        upgradeNote.value = t('card.upgradeRestarting');
        continue;
      }
      if (st.runId === run_id && st.state === 'success') {
        toast(t('card.upgradeDone'));
        upgradeNote.value = '';
        versions.value = null;
        emit('changed');
        return;
      }
      if (st.runId === run_id && st.state === 'failed') throw new Error(t('card.upgradeFailed', { code: st.exitCode }));
      upgradeNote.value = t('card.upgradeProgress', { n: (i + 1) * 5 });
    }
    throw new Error(t('card.upgradeTimeout'));
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
    toast(created.value.inbound.created ? t('card.createdWithInbound', { remark: created.value.inbound.remark, port: created.value.inbound.port }) : t('card.created'));
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
const assignOptions = computed<SelectOption<number | 'new'>[]>(() => [...customers.value.map((x) => ({ value: x.id, label: x.name + (x.remark ? ` · ${x.remark}` : '') })), { value: 'new', label: t('card.newCustomer') }]);
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
    toast(t('card.assigned', { name: r.customer.name }));
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
  if (!confirm(t('card.confirmDeleteClient', { email: c.email }))) return;
  try {
    const { line_removed } = await api.deleteClient(props.panel.id, c.email);
    toast(line_removed ? t('card.deletedWithLine') : t('card.deleted'));
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
        <svg class="caret" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span class="title-text">
          <span class="name">{{ panel.name }}</span>
          <span class="small addr"><span class="muted host">{{ hostOf(panel.base_url) }}</span><span v-if="resolvedIp" class="ip mono" :title="t('card.ipHint')">{{ resolvedIp }}</span></span>
        </span>
      </button>
      <div class="state">
        <span v-if="panel.check_error" class="text-err status" :title="panel.check_error"><i class="dot" />{{ t('card.down', { error: panel.check_error.slice(0, 36) }) }}</span>
        <template v-else-if="panel.check_ok_at">
          <span class="status"><i class="dot ok" />{{ t('card.statusOk') }}</span>
          <span class="small muted">{{ t('card.summary', { inbounds: panel.inbound_count ?? 0, clients: panel.client_count ?? 0, ago: fmtAgo(panel.check_ok_at) }) }}</span>
        </template>
        <span v-else class="muted status"><i class="dot" />{{ t('card.notChecked') }}</span>
      </div>
      <div class="versions small">
        <span v-if="panel.panel_version" class="muted">{{ t('card.panelVersion', { v: panel.panel_version }) }}</span>
        <span v-if="panel.xray_version" :class="panel.xray_state === 'running' ? 'muted' : 'text-err'" :title="panel.xray_state ?? ''">
          {{ t('card.xrayVersion', { v: panel.xray_version }) }}<template v-if="panel.xray_state && panel.xray_state !== 'running'">({{ panel.xray_state }})</template>
        </span>
      </div>
      <div class="labels small">
        <span v-if="panel.node_name" class="node-name" :title="t('card.nodeNameHint')">{{ t('card.nodeName', { name: panel.node_name }) }}</span>
        <span v-if="panel.tags?.length || panel.traffic_ratio !== 1" class="tags">
          <button v-for="tag in panel.tags ?? []" :key="tag" type="button" class="tag" :class="{ on: pickedTags?.includes(tag) }" :title="t('card.tagHint')" @click="emit('tag', tag)">{{ tag }}</button>
          <span v-if="panel.traffic_ratio !== 1" class="ratio" :title="t('card.ratioHint')">{{ t('card.ratio', { v: panel.traffic_ratio }) }}</span>
        </span>
      </div>
      <div class="cost small">
        <span v-if="panel.monthly_cost != null">{{ t('cost.value', { v: fmtCost(panel.monthly_cost) }) }}</span>
        <span v-if="panel.expire_at" :class="dueClass(panel.expire_at, 'muted')">{{ t('cost.expireOn', { date: fmtDate(panel.expire_at) }) }} · {{ fmtDue(panel.expire_at) }}</span>
        <span v-if="panel.monthly_cost == null && !panel.expire_at" class="muted">—</span>
      </div>
      <div class="ops">
        <button class="primary small-btn" @click="openCreate">{{ t('card.createClient') }}</button>
        <button class="small-btn" @click="emit('edit')">{{ t('common.edit') }}</button>
        <ActionMenu :items="menuItems" :aria-label="t('card.moreFor', { name: panel.name })" />
      </div>
    </header>

    <div v-if="open" class="body">
      <div v-if="error" class="notice small">
        {{ t('card.loadFailed', { error }) }}
        <button class="link" :disabled="loading" @click="load">{{ t('card.retry') }}</button>
      </div>
      <p v-else-if="!detail" class="muted small loading">{{ t('card.loadingDetail') }}</p>
      <template v-else>
        <div class="meta small">
          <span class="muted">{{ t('card.fetchedAt', { ago: fmtAgo(detail.fetched_at) }) }}</span>
          <button class="link" :disabled="loading" @click="load">{{ loading ? t('common.loading') : t('common.refresh') }}</button>
          <span class="spacer" />
          <template v-if="versions">
            <span class="muted">{{ t('card.panelVersion', { v: versions.panel.current }) }}</span>
            <template v-if="versions.panel.update_available">
              <span class="text-warn">{{ t('card.canUpgrade', { v: versions.panel.latest }) }}</span>
              <button class="link" :disabled="upgrading" @click="upgradePanel">{{ upgrading ? t('card.upgrading') : t('card.upgrade') }}</button>
            </template>
            <span v-else-if="versions.panel.latest" class="muted">{{ t('card.isLatest') }}</span>
            <span v-else class="muted">{{ t('card.latestUnknown') }}</span>
            <span v-if="upgradeNote" class="muted">{{ upgradeNote }}</span>
          </template>
          <button v-else class="link" :disabled="loadingVersions" @click="loadVersions">{{ loadingVersions ? t('card.querying') : t('card.checkPanelUpdate') }}</button>
        </div>
        <section v-for="g in groups" :key="g.key" class="inbound" :class="{ off: g.inbound && !g.inbound.enable }">
          <header class="ib-head">
            <template v-if="g.inbound">
              <strong>{{ g.inbound.remark || t('card.unnamed') }}</strong>
              <span class="chip">{{ PROTOCOL[g.inbound.protocol] ?? g.inbound.protocol }} {{ g.inbound.port }}</span>
              <span v-if="g.inbound.transport" class="muted small">{{ g.inbound.transport }}</span>
              <span v-if="!g.inbound.enable" class="badge warn">{{ t('card.inboundOff') }}</span>
            </template>
            <strong v-else>{{ t('card.unattached') }}</strong>
            <span class="spacer" />
            <span class="muted small">{{ t('card.clientCount', { n: g.clients.length }, g.clients.length) }}</span>
          </header>
          <ul v-if="g.clients.length" class="clients">
            <li v-for="c in g.clients" :key="c.email" class="client">
              <span class="email">{{ c.email }}<span v-if="!c.enable" class="badge err">{{ t('card.clientOff') }}</span><a v-if="c.customer" class="chip owner" :href="`#customers/${c.customer.id}`" :title="t('card.ownerHint', { name: c.customer.name })">{{ c.customer.name }}</a></span>
              <span class="stats small">
                <span class="muted">{{ t('card.used', { used: fmtBytes(c.up + c.down) }) }}<template v-if="c.total_bytes"> / {{ fmtBytes(c.total_bytes) }}</template></span>
                <span :class="{ 'text-warn': dueLevel(c.expiry_ms) === 'warn', 'text-err': dueLevel(c.expiry_ms) === 'err', muted: !c.expiry_ms }">{{ fmtDue(c.expiry_ms) }}</span>
                <span class="muted">{{ t('card.online', { ago: fmtAgo(c.last_online, '—') }) }}</span>
              </span>
              <span class="c-ops">
                <button class="link" :disabled="loadingLinks === c.email" @click="showLinks(c)">{{ loadingLinks === c.email ? t('common.loading') : t('card.links') }}</button>
                <button v-if="!c.customer && g.inbound?.accepts_clients" class="link" :title="t('card.assignHint')" @click="openAssign(c)">{{ t('card.assign') }}</button>
                <button class="link danger" @click="removeClient(c)">{{ t('common.delete') }}</button>
              </span>
            </li>
          </ul>
          <p v-else class="muted small none">{{ t('card.noClients') }}</p>
        </section>
        <p v-if="!groups.length" class="empty small">{{ t('card.noInbounds') }}</p>
      </template>
    </div>
  </article>

  <Modal v-if="showCreate" :title="created ? t('card.createdTitle', { email: created.email }) : t('card.createTitle', { name: panel.name })" @close="showCreate = false">
    <form v-if="!created" id="client-form" class="form" @submit.prevent="create">
      <label class="field">{{ t('card.name') }}<input v-model="form.name" required :placeholder="t('card.namePlaceholder')" /></label>
      <div class="protocol-field">
        <span class="label">{{ t('card.protocol') }}</span>
        <div class="protocols">
          <label class="row small"><input v-model="form.protocol" type="radio" value="vless" />{{ t('card.protoVless') }}</label>
          <label class="row small"><input v-model="form.protocol" type="radio" value="hy2" />{{ t('card.protoHy2') }}</label>
        </div>
      </div>
      <p class="muted small hint">{{ t('card.createHint') }}</p>
    </form>
    <template v-else>
      <p class="muted small">
        {{ t(created.inbound.created ? 'card.createdOnNew' : 'card.createdOn', { inbound: created.inbound.remark || created.inbound.port, port: created.inbound.port }) }}
      </p>
      <ClientLinks :links="created.links" :name="created.email" />
    </template>
    <template #footer>
      <span class="spacer" />
      <template v-if="!created">
        <button @click="showCreate = false">{{ t('common.cancel') }}</button>
        <button class="primary" form="client-form" :disabled="creating">{{ creating ? t('card.creating') : t('card.create') }}</button>
      </template>
      <template v-else>
        <button @click="created = null">{{ t('card.another') }}</button>
        <button class="primary" @click="showCreate = false">{{ t('card.done') }}</button>
      </template>
    </template>
  </Modal>

  <Modal v-if="showXray" :title="t('card.xrayTitle', { name: panel.name })" @close="showXray = false">
    <p v-if="!versions" class="muted small">{{ loadingVersions ? t('card.readingVersions') : t('card.readFailed') }}</p>
    <template v-else>
      <p class="small">
        {{ t('card.current') }} <strong>{{ versions.xray.current || t('card.unknown') }}</strong>
        <span :class="versions.xray.state === 'running' ? 'text-ok' : 'text-err'">{{ versions.xray.state === 'running' ? t('card.running') : versions.xray.state || t('card.stateUnknown') }}</span>
        <span v-if="versions.xray.error" class="text-err">{{ versions.xray.error }}</span>
      </p>
      <label class="field">
        {{ t('card.switchTo') }}
        <Select v-model="xrayPick" :options="xrayOptions" />
      </label>
      <p class="muted small hint">{{ t('card.xrayHint') }}</p>
    </template>
    <template #footer>
      <span class="spacer" />
      <button @click="showXray = false">{{ t('common.cancel') }}</button>
      <button class="primary" :disabled="!versions || switching || !xrayPick || xrayPick.replace(/^v/, '') === versions.xray.current" @click="switchXray">{{ switching ? t('card.switching') : t('card.switch') }}</button>
    </template>
  </Modal>

  <Modal v-if="assignFor" :title="t('card.assignTitle', { email: assignFor.email })" @close="assignFor = null">
    <form id="assign-form" class="form" @submit.prevent="assign">
      <p class="muted small">{{ t('card.assignIntro') }}</p>
      <label class="field">
        {{ t('card.customer') }}
        <Select v-model="assignTo" :options="assignOptions" />
      </label>
      <label v-if="assignTo === 'new'" class="field">{{ t('card.newCustomerName') }}<input v-model="newName" required /></label>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="assignFor = null">{{ t('common.cancel') }}</button>
      <button class="primary" form="assign-form" :disabled="assigning">{{ assigning ? t('card.working') : t('card.assignDo') }}</button>
    </template>
  </Modal>

  <Modal v-if="linksFor" :title="t('card.linksTitle', { email: linksFor.email })" @close="linksFor = null">
    <ClientLinks :links="linksFor.links" :name="linksFor.email" />
  </Modal>

  <Modal v-if="renewing" :title="t('assetRenew.titlePanel', { name: panel.name })" @close="renewing = false">
    <AssetRenew kind="panel" :item="panel" @saved="onRenewed" @saving="(b) => (renewSaving = b)" />
    <template #footer>
      <span class="spacer" />
      <button @click="renewing = false">{{ t('common.cancel') }}</button>
      <button class="primary" form="asset-renew-form" :disabled="renewSaving">{{ renewSaving ? t('common.saving') : t('assetRenew.button') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.card {
  overflow: hidden;
}
.card.bad {
  border-color: color-mix(in srgb, var(--fault) 40%, var(--rule));
}
/* 一块面板一行:名称地址 / 状态 / 版本 / 节点名和标签 / 成本 / 操作,各列在面板之间对齐 */
.head {
  display: grid;
  grid-template-columns: minmax(12em, 1.25fr) minmax(10em, 1fr) minmax(8em, 0.7fr) minmax(9em, 0.95fr) minmax(9em, 0.9fr) auto;
  gap: 8px 22px;
  padding: 13px 16px;
  align-items: start;
}
.title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.title:hover:not(:disabled) {
  background: none;
}
.caret {
  flex: none;
  margin-top: 4px;
  color: var(--ink-soft);
  transition: transform 0.15s;
}
.card.open .caret {
  transform: rotate(90deg);
}
.title-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name {
  font-weight: 600;
  font-size: 16px;
  line-height: 22px;
}
.addr {
  display: flex;
  flex-wrap: wrap;
  gap: 0 8px;
  font-weight: 400;
  min-width: 0;
}
.host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ip {
  flex-shrink: 0;
  color: var(--ink);
  font-size: 11.5px;
  user-select: all;
}
.state,
.versions,
.labels,
.cost {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding-top: 2px;
  font-variant-numeric: tabular-nums;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 500;
}
.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.dot.ok {
  background: var(--ok);
}
.node-name {
  font-weight: 500;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ratio {
  color: var(--caution);
  font-weight: 500;
}
.tag {
  padding: 0 7px;
  border: 1px solid var(--rule);
  border-radius: 5px;
  background: none;
  color: var(--ink-soft);
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
}
.tag:hover:not(:disabled) {
  border-color: var(--accent);
  background: none;
}
.tag.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-strong);
}
.ops {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-self: end;
}
@media (max-width: 1100px) {
  .head {
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr);
  }
  .ops {
    grid-column: 1 / -1;
    justify-self: start;
  }
}
@media (max-width: 600px) {
  .head {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .title {
    grid-column: 1 / -1;
  }
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
  text-decoration: none;
}
/* 点了去客户页,看这位客户的线路、续费、编辑等 */
.chip.owner:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--rule));
  text-decoration: underline;
}
.chip.owner:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
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
