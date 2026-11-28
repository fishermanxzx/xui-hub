<script setup lang="ts">
// SOCKS 页:登记购买的 SOCKS5 代理,测连通性(出口 IP / 地区 / 延迟),给客户页的中转当出口用。
// 默认「机房」:一个 SOCKS 一间房,房里坐着线路用到它的客户(点哪位到客户页看他);切到「表格」是原来的列表。
// 右上角「地球」展开 3D 地球,按出口 IP 看各 SOCKS 分布在哪些地区。
import { t } from '../i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import AssetRenew from '../components/AssetRenew.vue';
import GlobeBlock from '../components/GlobeBlock.vue';
import RoomList from '../components/RoomList.vue';
import { socksRooms } from '../rooms';
import { parseCoords, type GlobePoint } from '../geoRegions';
import Modal from '../components/Modal.vue';
import { costSummary, dateInputToMs, dueClass, fmtAgo, fmtCost, fmtDate, fmtDue, msToDateInput, region } from '../format';
import { toast, toastError } from '../toast';
import type { Customer, Socks, SocksInput } from '../types';

const list = ref<Socks[]>([]);
const summary = computed(() => costSummary(list.value));
const checkingAll = ref(false);
const checking = ref(new Set<number>());

// ---------- 机房 / 表格:选的哪种记在浏览器里 ----------
type SocksView = 'rooms' | 'table';
const VIEW_KEY = 'xui-hub.socksView';
const view = ref<SocksView>('rooms');
try {
  if (localStorage.getItem(VIEW_KEY) === 'table') view.value = 'table';
} catch {
  /* 读不了就用机房 */
}
function setView(v: SocksView) {
  view.value = v;
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* 存不了就算了 */
  }
  if (v === 'rooms') void loadRoomData();
}
const customers = ref<Customer[]>([]);
/** 用量条变黄的百分比,跟设置里的提醒一致 */
const warnPct = ref(80);
let settingsRead = false;
async function loadRoomData() {
  try {
    customers.value = await api.customers();
  } catch (e) {
    toastError(e);
  }
  if (settingsRead) return;
  settingsRead = true;
  try {
    const n = (await api.settings()).notify.quota_warn_pct;
    if (n) warnPct.value = n;
  } catch {
    /* 取不到就按 80 */
  }
}
const rooms = computed(() => socksRooms(customers.value, list.value));
/** 点房里的人:到客户页弹出他 */
const openCustomer = (id: number) => (location.hash = `#customers/${id}`);
if (view.value === 'rooms') void loadRoomData();

async function load() {
  try {
    list.value = await api.socks();
  } catch (e) {
    toastError(e);
  }
}

// ---------- 地球:展开时按出口 IP 查还没定位的,点一个点跳到那一行 ----------
const GLOBE_KEY = 'xui-hub.socksGlobe';
const showGlobe = ref(false);
try {
  showGlobe.value = localStorage.getItem(GLOBE_KEY) === '1';
} catch {
  /* 读不了就默认收起 */
}
const locating = ref(false);
async function locate() {
  locating.value = true;
  try {
    list.value = await api.socksGeo();
  } catch (e) {
    toastError(e);
  } finally {
    locating.value = false;
  }
}
function toggleGlobe() {
  showGlobe.value = !showGlobe.value;
  try {
    localStorage.setItem(GLOBE_KEY, showGlobe.value ? '1' : '0');
  } catch {
    /* 存不了就算了 */
  }
  if (showGlobe.value) void locate();
}
const globePoints = computed<GlobePoint[]>(() =>
  list.value
    .filter((s) => s.geo_lat != null && s.geo_lng != null)
    .map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.geo_lat!,
      lng: s.geo_lng!,
      city: s.geo_city,
      // 手动填的坐标没有国家代码,用测试时测出的地区
      country: s.geo_country || s.check?.loc || '',
      down: s.check?.ok === false,
      meta: [s.check?.ip, s.check ? (s.check.ok ? `${s.check.ms} ms` : t('globe.socksDown')) : '', s.seen_by ? t('globe.customers', { n: s.customers }) : ''].filter(Boolean).join(' · '),
    })),
);
const unlocated = computed(() => list.value.filter((s) => s.geo_lat == null).map((s) => ({ id: s.id, name: s.name, reason: s.geo_error })));
const focused = ref<number | null>(null);
let focusTimer: number | undefined;
function focusRow(id: number) {
  document.getElementById(view.value === 'rooms' ? `room-s${id}` : `socks-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  focused.value = id;
  clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => (focused.value = null), 2000);
}
/** 测过之后出口 IP 可能变了:地球开着就顺手重新定位 */
const relocate = () => (showGlobe.value ? locate() : undefined);

onMounted(() => void (showGlobe.value ? locate() : load()));

// 「N 位客户」点开:列出是哪几位,点名字跳到客户页
const usersFor = ref<Socks | null>(null);

// 续费:顺延到期日,付了钱在账本记一笔支出
const renewFor = ref<Socks | null>(null);
const renewSaving = ref(false);
async function onRenewed() {
  renewFor.value = null;
  await load();
}

async function checkOne(s: Socks) {
  checking.value.add(s.id);
  try {
    const updated = await api.checkSocks(s.id);
    Object.assign(s, updated);
    void relocate();
    if (updated.check?.ok) toast(t('socks.okToast', { name: s.name, ms: updated.check.ms, ip: updated.check.ip ?? t('socks.unknown'), region: region(updated.check.loc) }));
    else toast(t('socks.failToast', { name: s.name, error: updated.check?.error ?? t('socks.testFailed') }), 'err');
  } catch (e) {
    toastError(e);
  } finally {
    checking.value.delete(s.id);
  }
}

async function checkAll() {
  checkingAll.value = true;
  try {
    list.value = await api.checkAllSocks();
    void relocate();
    const bad = list.value.filter((s) => !s.check?.ok).length;
    toast(t('socks.allDone', { ok: list.value.length - bad, bad }), bad ? 'err' : 'ok');
  } catch (e) {
    toastError(e);
  } finally {
    checkingAll.value = false;
  }
}

// ---------- 新增 / 编辑 ----------
const editing = ref<Socks | null>(null);
const showForm = ref(false);
const saving = ref(false);
const form = ref({ name: '', address: '', remark: '', cost: '', expire: '', loc: '', locCity: '' });

function openForm(s: Socks | null) {
  editing.value = s;
  form.value = { name: s?.name ?? '', address: '', remark: s?.remark ?? '', cost: s?.monthly_cost == null ? '' : String(s.monthly_cost), expire: msToDateInput(s?.expire_at ?? 0), loc: s?.geo_manual ? `${s.geo_lat}, ${s.geo_lng}` : '', locCity: s?.geo_manual ? s.geo_city : '' };
  showForm.value = true;
}

async function submit() {
  // 到期日没动就原样发回(表单里只有日期,重算会把到期时刻改成当天 23:59)
  const was = editing.value;
  const expireAt = was && form.value.expire === msToDateInput(was.expire_at) ? was.expire_at : dateInputToMs(form.value.expire);
  const body: SocksInput = { name: form.value.name, remark: form.value.remark, monthly_cost: form.value.cost === '' ? null : Number(form.value.cost), expire_at: expireAt };
  if (form.value.address.trim()) body.address = form.value.address.trim();
  // 位置:填了坐标 = 手动;清空了(原来是手动的)= 改回按出口 IP 自动
  const loc = form.value.loc.trim();
  if (loc) {
    const at = parseCoords(loc);
    if (!at) return toastError(new Error(t('loc.bad')));
    body.location = { ...at, city: form.value.locCity.trim() };
  } else if (was?.geo_manual) body.location = null;
  const used = editing.value?.used_by ?? 0;
  if (body.address && used && !confirm(t('socks.confirmAddress', { n: used }))) return;
  saving.value = true;
  try {
    const saved = editing.value ? await api.updateSocks(editing.value.id, body) : await api.createSocks(body);
    showForm.value = false;
    toast(t('socks.saved'));
    await (showGlobe.value ? locate() : load());
    // 新登记的顺手测一下
    if (!editing.value) {
      const row = list.value.find((s) => s.id === saved.id);
      if (row) void checkOne(row);
    }
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(s: Socks) {
  if (s.used_by) return toast(t('socks.inUse', { n: s.used_by, name: s.name }), 'err');
  if (!confirm(t('socks.confirmDelete', { name: s.name }))) return;
  try {
    await api.deleteSocks(s.id);
    toast(t('socks.deleted'));
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <header class="page-head">
    <div class="ph-main">
      <h1>{{ t('socks.title') }}</h1>
      <p v-if="list.length" class="ph-sum">
        <span>{{ t('cost.total', { total: fmtCost(summary.total) }) }}</span>
        <span v-if="summary.unset">{{ t('cost.unset', { n: summary.unset }) }}</span>
        <span v-if="summary.soon" class="text-warn">{{ t('cost.soon', { n: summary.soon }) }}</span>
        <span v-if="summary.overdue" class="text-err">{{ t('cost.overdue', { n: summary.overdue }) }}</span>
      </p>
      <details class="about">
        <summary>{{ t('common.about') }}</summary>
        <p>{{ t('socks.intro') }}</p>
      </details>
    </div>
    <div class="ph-actions">
      <span class="seg" role="group" :aria-label="t('rooms.view')">
        <button type="button" :class="{ on: view === 'rooms' }" :aria-pressed="view === 'rooms'" @click="setView('rooms')">{{ t('rooms.viewRooms') }}</button>
        <button type="button" :class="{ on: view === 'table' }" :aria-pressed="view === 'table'" @click="setView('table')">{{ t('rooms.viewTable') }}</button>
      </span>
      <button :aria-pressed="showGlobe" :disabled="!list.length" @click="toggleGlobe">{{ showGlobe ? t('globe.hide') : t('globe.show') }}</button>
      <button :disabled="checkingAll || !list.length" @click="checkAll">{{ checkingAll ? t('socks.testing') : t('socks.testAll') }}</button>
      <button class="primary" @click="openForm(null)">{{ t('socks.add') }}</button>
    </div>
  </header>

  <GlobeBlock v-if="showGlobe && list.length" :points="globePoints" :unlocated="unlocated" :locating="locating" summary-key="globe.summarySocks" source-key="globe.sourceSocks" label-key="globe.ariaSocks" @pick="focusRow" />

  <template v-if="view === 'rooms' && list.length">
    <p class="muted small rooms-hint">{{ t('rooms.hintSocks') }}</p>
    <RoomList :rooms="rooms" :warn-pct="warnPct" @open="openCustomer" />
  </template>
  <section v-else class="sheet">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('socks.colName') }}</th>
            <th>{{ t('socks.colCheck') }}</th>
            <th>{{ t('socks.colExit') }}</th>
            <th>{{ t('socks.colUsed') }}</th>
            <th>{{ t('cost.col') }}</th>
            <th>{{ t('cost.colExpire') }}</th>
            <th>{{ t('socks.colRemark') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in list" :id="`socks-${s.id}`" :key="s.id" :class="{ focused: focused === s.id }">
            <td class="name" :title="`${s.host}:${s.port}`">{{ s.name }}</td>
            <td class="small">
              <template v-if="checking.has(s.id)"><span class="muted">{{ t('socks.testing') }}</span></template>
              <template v-else-if="!s.check"><span class="muted">{{ t('socks.neverTested') }}</span></template>
              <template v-else-if="s.check.ok"><span class="text-ok">{{ t('socks.ok') }}</span> <span class="muted">{{ s.check.ms }} ms · {{ fmtAgo(s.check.at) }}</span></template>
              <template v-else><span class="text-err" :title="s.check.error ?? ''">{{ t('socks.failed') }}</span> <span class="muted">{{ (s.check.error ?? '').slice(0, 40) }} · {{ fmtAgo(s.check.at) }}</span></template>
            </td>
            <td class="small nowrap">
              <template v-if="s.check?.ok">{{ s.check.ip }} <span class="muted">{{ region(s.check.loc) }}</span></template>
              <span v-else class="muted">—</span>
            </td>
            <td class="small nowrap">
              <button v-if="s.seen_by" class="link" :title="t('socks.usedLines', { n: s.seen_by }, s.seen_by)" @click="usersFor = s">{{ t('socks.usedBy', { n: s.customers }, s.customers) }}</button>
              <span v-else class="muted">—</span>
            </td>
            <td class="small mono"><template v-if="s.monthly_cost != null">{{ fmtCost(s.monthly_cost) }}</template><span v-else class="muted">—</span></td>
            <td class="small nowrap">
              <template v-if="s.expire_at">{{ fmtDate(s.expire_at) }} <span :class="dueClass(s.expire_at, 'muted')">{{ fmtDue(s.expire_at) }}</span></template>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted small">{{ s.remark || '' }}</td>
            <td class="num">
              <div class="ops">
                <button class="link" :disabled="checking.has(s.id)" @click="checkOne(s)">{{ t('socks.test') }}</button>
                <button class="link" @click="renewFor = s">{{ t('assetRenew.button') }}</button>
                <button class="link" @click="openForm(s)">{{ t('common.edit') }}</button>
                <button class="link danger" @click="remove(s)">{{ t('common.delete') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!list.length" class="empty">{{ t('socks.empty') }}</div>
    </div>
  </section>

  <Modal v-if="showForm" :title="editing ? t('socks.editTitle', { name: editing.name }) : t('socks.add')" @close="showForm = false">
    <form id="socks-form" class="form" @submit.prevent="submit">
      <label class="field">{{ t('socks.name') }}<input v-model="form.name" required :placeholder="t('socks.namePlaceholder')" /></label>
      <label class="field">
        {{ t('socks.address') }}{{ editing ? t('socks.keepBlankCurrent', { addr: `${editing.host}:${editing.port}` }) : '' }}
        <input v-model="form.address" :required="!editing" :placeholder="t('socks.addressPlaceholder')" autocomplete="off" />
      </label>
      <div class="two">
        <label class="field">{{ t('cost.field') }}<input v-model="form.cost" type="number" min="0" step="0.01" /></label>
        <label class="field">{{ t('cost.expireField') }}<input v-model="form.expire" type="date" /></label>
      </div>
      <label class="field">{{ t('socks.remark') }}<input v-model="form.remark" :placeholder="t('socks.remarkPlaceholder')" /></label>
      <div class="two">
        <label class="field">{{ t('loc.field') }}<input v-model="form.loc" :placeholder="t('loc.placeholder')" inputmode="decimal" /></label>
        <label class="field">{{ t('loc.city') }}<input v-model="form.locCity" maxlength="40" :placeholder="t('loc.cityPlaceholder')" /></label>
      </div>
      <p class="muted small hint">
        {{ t('loc.hint') }}
        <template v-if="editing && !editing.geo_manual && editing.geo_lat != null"><br />{{ t('loc.now', { place: `${editing.geo_city || editing.geo_country || ''} (${editing.geo_lat}, ${editing.geo_lng})`.trim() }) }}</template>
      </p>
      <p class="muted small hint">{{ t('socks.hint') }} {{ t('cost.hint') }}</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="primary" form="socks-form" :disabled="saving">{{ saving ? t('common.saving') : t('common.save') }}</button>
    </template>
  </Modal>

  <Modal v-if="usersFor" :title="t('socks.usersTitle', { name: usersFor.name })" @close="usersFor = null">
    <p class="muted small hint">{{ t('socks.usersHint') }}</p>
    <ul class="users">
      <li v-for="u in usersFor.users" :key="u.id">
        <a class="link" :href="`#customers/${u.id}`" @click="usersFor = null">{{ u.name }}</a>
        <span class="muted small">{{ t('socks.userLines', { n: u.lines }, u.lines) }}</span>
      </li>
    </ul>
  </Modal>

  <Modal v-if="renewFor" :title="t('assetRenew.titleSocks', { name: renewFor.name })" @close="renewFor = null">
    <AssetRenew kind="socks" :item="renewFor" @saved="onRenewed" @saving="(b) => (renewSaving = b)" />
    <template #footer>
      <span class="spacer" />
      <button @click="renewFor = null">{{ t('common.cancel') }}</button>
      <button class="primary" form="asset-renew-form" :disabled="renewSaving">{{ renewSaving ? t('common.saving') : t('assetRenew.button') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.rooms-hint {
  margin: 0 0 10px;
  max-width: 80ch;
}
tr.focused td {
  background: var(--accent-soft);
  transition: background 0.3s;
}
.name {
  font-weight: 500;
  white-space: nowrap;
}
.mono {
  font-variant-numeric: tabular-nums;
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
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.nowrap {
  white-space: nowrap;
}
.users {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}
.users li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--rule-soft);
}
.users li:first-child {
  border-top: 0;
}
</style>
