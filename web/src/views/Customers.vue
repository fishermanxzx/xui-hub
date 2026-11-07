<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { copyText } from '../clipboard';
import Modal from '../components/Modal.vue';
import DailyTraffic from '../components/DailyTraffic.vue';
import DirectLines from '../components/DirectLines.vue';
import UsageBar from '../components/UsageBar.vue';
import { dateInputToMs, daysUntil, dueLevel, fmtAgo, fmtBytes, fmtDate, fmtDue, fmtPrice, gbToBytes, shortUa, STATE_LABEL } from '../format';
import { toast, toastError } from '../toast';
import type { Customer, CustomerState, OverallDaily, Panel } from '../types';
import CustomerDetail from './CustomerDetail.vue';

// 二维码库只在点开二维码时才加载
const SubQr = defineAsyncComponent(() => import('../components/SubQr.vue'));

const customers = ref<Customer[]>([]);
const loading = ref(false);
const query = ref('');
const stateFilter = ref<CustomerState | ''>('');
const openId = ref<number | null>(null);
/** 正在看二维码的客户 */
const qrFor = ref<Customer | null>(null);

async function load() {
  loading.value = true;
  try {
    customers.value = await api.customers();
  } catch (e) {
    toastError(e);
  } finally {
    loading.value = false;
  }
}

// ---------- 总览:每日流量、成本 ----------
const daily = ref<OverallDaily | null>(null);
/** 面板列表:算成本,也给每日流量的「按面板」视图取名称 */
const panelList = ref<Panel[]>([]);
const costs = ref<{ panels: number; socks: number } | null>(null);

// 流量统计里排除的面板(在每日流量卡片里勾选):「近 30 天流量」和每日流量都不算它们。只记在这台浏览器上
const EXCLUDE_KEY = 'xui.dailyExcludedPanels';
function readExcluded(): number[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(EXCLUDE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((n): n is number => Number.isSafeInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}
const excluded = ref<number[]>(readExcluded());
function setExcluded(ids: number[]) {
  excluded.value = [...new Set(ids)].sort((a, b) => a - b);
  try {
    localStorage.setItem(EXCLUDE_KEY, JSON.stringify(excluded.value));
  } catch {
    // 存不了(隐私模式等)就只在这次打开的页面里生效
  }
  void loadOverview();
}

async function loadOverview() {
  const exclude = excluded.value;
  try {
    const [d, panels, socks] = await Promise.all([api.statsDaily(30, exclude), api.panels(), api.socks()]);
    // 读取期间又改了排除的面板:这次的结果作废,以新的一次为准
    if (exclude !== excluded.value) return;
    const sum = (xs: { monthly_cost: number | null }[]) => xs.reduce((a, x) => a + Math.round((x.monthly_cost ?? 0) * 100), 0) / 100;
    daily.value = d;
    costs.value = { panels: sum(panels), socks: sum(socks) };
    panelList.value = panels;
    // 已删除的面板不再排除(列表里勾不掉它)
    const alive = exclude.filter((id) => panels.some((p) => p.id === id));
    if (alive.length !== exclude.length) setExcluded(alive);
  } catch (e) {
    toastError(e);
  }
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return customers.value.filter((c) => {
    if (stateFilter.value && c.state !== stateFilter.value) return false;
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      c.remark.toLowerCase().includes(q) ||
      c.lines.some(
        (l) => l.email.toLowerCase().includes(q) || l.panel_name.toLowerCase().includes(q) || (l.exits ?? []).some((e) => e.ip.includes(q)),
      )
    );
  });
});

// 列表视图:按客户(默认)/ 按落地 IP;状态筛选和搜索两种视图都生效
const LIST_VIEWS = [
  { key: 'customers', label: '按客户' },
  { key: 'exits', label: '按落地 IP' },
] as const;
const listView = ref<(typeof LIST_VIEWS)[number]['key']>('customers');

/** 按落地 IP 分组:每个 IP 有哪些客户、共几条线路、怎么到的;客户多的在前,算不出落地的放最后 */
const exitGroups = computed(() => {
  const groups = new Map<string, { ip: string; via: Set<string>; customers: Map<number, Customer>; lines: number }>();
  const unknown: Customer[] = [];
  for (const c of sorted.value) {
    let found = false;
    for (const l of c.lines) {
      for (const e of l.exits ?? []) {
        found = true;
        const g = groups.get(e.ip) ?? { ip: e.ip, via: new Set<string>(), customers: new Map(), lines: 0 };
        g.via.add(e.via);
        g.customers.set(c.id, c);
        g.lines++;
        groups.set(e.ip, g);
      }
    }
    if (!found) unknown.push(c);
  }
  const list = [...groups.values()]
    .map((g) => ({ key: g.ip, ip: g.ip, via: [...g.via].join('、'), customers: [...g.customers.values()], lines: g.lines }))
    .sort((a, b) => b.customers.length - a.customers.length || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  if (unknown.length) list.push({ key: '', ip: '', via: '没有线路或还算不出', customers: unknown, lines: 0 });
  return list;
});

/** 落地 IP → 落地面板(开直连只用于落地机,中转和 SOCKS 的 IP 不算) */
const landingByIp = computed(() => new Map(panelList.value.filter((p) => p.role !== 'relay' && p.ip).map((p) => [p.ip!, p])));
const directPanel = ref<number | null>(null);

/** 每位客户各线路的落地 IP,去重;悬停看是哪几条线路、怎么到的 */
const exitsById = computed(() => {
  const out = new Map<number, { ip: string; title: string }[]>();
  for (const c of customers.value) {
    const byIp = new Map<string, { lines: string[]; via: Set<string> }>();
    for (const l of c.lines) {
      for (const e of l.exits ?? []) {
        const item = byIp.get(e.ip) ?? { lines: [], via: new Set<string>() };
        item.lines.push(l.panel_name);
        item.via.add(e.via);
        byIp.set(e.ip, item);
      }
    }
    out.set(
      c.id,
      [...byIp].map(([ip, x]) => ({ ip, title: `${x.lines.join('、')}(${[...x.via].join('、')})` })),
    );
  }
  return out;
});

// 排序:默认按到期时间,最近到期的在前,不限的在后;点表头切换,再点反向
type SortKey = 'name' | 'used' | 'expire' | 'fetched' | 'clients' | 'price';
const sortKey = ref<SortKey>('expire');
const sortAsc = ref(true);

function sortBy(key: SortKey) {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value;
  else {
    sortKey.value = key;
    // 已用、客户端数、月费默认从大到小;最后拉取默认最久没拉的(含从没拉过的)在前
    sortAsc.value = key === 'name' || key === 'expire' || key === 'fetched';
  }
}

function arrow(key: SortKey): string {
  return sortKey.value === key ? (sortAsc.value ? ' ↑' : ' ↓') : '';
}

function sortValue(c: Customer): number {
  switch (sortKey.value) {
    case 'expire':
      return c.expire_at || Infinity;
    case 'used':
      return c.quota_bytes > 0 ? c.used / c.quota_bytes : -1;
    case 'fetched':
      return c.sub_fetched_at ?? 0;
    case 'clients':
      return c.sub_clients ?? 0;
    case 'price':
      return c.monthly_price ?? -1;
    default:
      return 0;
  }
}

const sorted = computed(() => {
  const byName = (a: Customer, b: Customer) => a.name.localeCompare(b.name, 'zh-CN');
  const dir = sortAsc.value ? 1 : -1;
  return [...filtered.value].sort((a, b) => {
    if (sortKey.value === 'name') return dir * byName(a, b);
    const va = sortValue(a);
    const vb = sortValue(b);
    return va === vb ? byName(a, b) : dir * (va < vb ? -1 : 1);
  });
});

const summary = computed(() => {
  const counts: Record<CustomerState, number> = { active: 0, over_quota: 0, expired: 0, disabled: 0 };
  let revenue = 0;
  for (const c of customers.value) {
    counts[c.state]++;
    if (c.state !== 'disabled') revenue += c.monthly_price ?? 0;
  }
  return { counts, revenue, total: customers.value.length };
});

const kpi = computed(() => {
  const cost = costs.value ? Math.round((costs.value.panels + costs.value.socks) * 100) / 100 : null;
  const traffic = daily.value ? daily.value.bytes.reduce((a, b) => a + b, 0) : null;
  const relay = daily.value ? daily.value.relay.reduce((a, b) => a + b, 0) : null;
  const days = daily.value?.days.length ?? 0;
  return {
    cost,
    profit: cost == null ? null : Math.round((summary.value.revenue - cost) * 100) / 100,
    traffic,
    perDay: traffic == null || !days ? null : traffic / days,
    relay,
    relayPerDay: relay == null || !days ? null : relay / days,
    /** 经中转占全部流量的百分比 */
    relayShare: relay == null || !traffic ? null : Math.round((relay / traffic) * 100),
  };
});

/** 近期到期:30 天内(含已过期),停用的不算 */
const upcoming = computed(() =>
  customers.value
    .filter((c) => c.status !== 'disabled' && c.expire_at && daysUntil(c.expire_at) <= 30)
    .sort((a, b) => a.expire_at - b.expire_at),
);
const UPCOMING_SHOWN = 7;

/** 表格上方的筛选:全部 + 有人的异常状态 */
const filters = computed(() => [
  { state: '' as const, label: '全部', n: summary.value.total },
  ...(['expired', 'over_quota', 'disabled'] as CustomerState[])
    .filter((st) => summary.value.counts[st] > 0)
    .map((st) => ({ state: st, label: STATE_LABEL[st], n: summary.value.counts[st] })),
]);

// ---------- 新建 ----------
const creating = ref(false);
const form = ref({ name: '', remark: '', price: '', quotaGb: '', expire: '' });
async function create() {
  try {
    const c = await api.createCustomer({
      name: form.value.name,
      remark: form.value.remark,
      monthly_price: form.value.price === '' ? null : Number(form.value.price),
      quota_bytes: form.value.quotaGb === '' ? 0 : gbToBytes(Number(form.value.quotaGb)),
      expire_at: dateInputToMs(form.value.expire),
    });
    creating.value = false;
    form.value = { name: '', remark: '', price: '', quotaGb: '', expire: '' };
    toast(`已创建客户「${c.name}」`);
    await load();
    openId.value = c.id;
  } catch (e) {
    toastError(e);
  }
}

// 同步每分钟一次,列表和总览随之刷新
let timer: number | undefined;
onMounted(() => {
  void load();
  void loadOverview();
  timer = window.setInterval(() => {
    void load();
    void loadOverview();
  }, 60_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section class="kpis" aria-label="关键数字">
    <div class="kpi sheet">
      <div class="kpi-label">活跃客户</div>
      <div class="kpi-value">{{ summary.counts.active }}</div>
      <div class="kpi-sub">共 {{ summary.total }} 位</div>
    </div>
    <div class="kpi sheet">
      <div class="kpi-label">月收入</div>
      <div class="kpi-value">{{ fmtPrice(summary.revenue) }}</div>
      <div class="kpi-sub">不含已停用的客户</div>
    </div>
    <div class="kpi sheet">
      <div class="kpi-label">月成本</div>
      <div class="kpi-value">{{ kpi.cost == null ? '—' : fmtPrice(kpi.cost) }}</div>
      <div class="kpi-sub" v-if="costs">面板 {{ fmtPrice(costs.panels) }}，SOCKS {{ fmtPrice(costs.socks) }}</div>
    </div>
    <div class="kpi sheet">
      <div class="kpi-label">月利润</div>
      <div class="kpi-value" :class="{ 'text-ok': (kpi.profit ?? 0) > 0, 'text-err': (kpi.profit ?? 0) < 0 }">
        {{ kpi.profit == null ? '—' : fmtPrice(kpi.profit) }}
      </div>
      <div class="kpi-sub">收入减成本</div>
    </div>
    <div class="kpi sheet">
      <div class="kpi-label">近 30 天流量</div>
      <div class="kpi-value">{{ kpi.traffic == null ? '—' : fmtBytes(kpi.traffic) }}</div>
      <div class="kpi-sub" v-if="kpi.perDay != null">
        日均 {{ fmtBytes(kpi.perDay) }}<template v-if="excluded.length">，已排除 {{ excluded.length }} 台服务器</template>
      </div>
    </div>
    <div class="kpi sheet" title="客户经中转机用掉的流量；中转机收一份转一份，机器自己进出约为它的 2 倍">
      <div class="kpi-label">近 30 天中转流量</div>
      <div class="kpi-value">{{ kpi.relay == null ? '—' : fmtBytes(kpi.relay) }}</div>
      <div class="kpi-sub" v-if="kpi.relayPerDay != null">
        <template v-if="kpi.relayShare != null">占 {{ kpi.relayShare }}%，</template>日均 {{ fmtBytes(kpi.relayPerDay) }}
      </div>
    </div>
  </section>

  <section class="overview">
    <DailyTraffic :customers="customers" :panels="panelList" :overall="daily" :excluded="excluded" @update:excluded="setExcluded" />
    <div class="sheet panel">
      <header class="panel-head">
        <h2>近期到期</h2>
        <span class="muted small">30 天内 {{ upcoming.length }} 位</span>
      </header>
      <ul v-if="upcoming.length" class="due-list">
        <li v-for="c in upcoming.slice(0, UPCOMING_SHOWN)" :key="c.id">
          <button class="due-row" @click="openId = c.id">
            <span class="due-name">{{ c.name }}</span>
            <span class="due-when" :class="{ 'text-warn': dueLevel(c.expire_at) === 'warn', 'text-err': dueLevel(c.expire_at) === 'err' }">
              {{ fmtDue(c.expire_at) }}
            </span>
            <span class="due-date muted">{{ fmtDate(c.expire_at).slice(5) }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="due-empty muted small">30 天内没有要到期的客户。</p>
      <p v-if="upcoming.length > UPCOMING_SHOWN" class="due-more muted small">
        还有 {{ upcoming.length - UPCOMING_SHOWN }} 位，下面的列表按到期排好了。
      </p>
    </div>
  </section>

  <section class="sheet">
    <div class="toolbar row">
      <h2 class="table-title">客户</h2>
      <div class="filters" role="radiogroup" aria-label="列表视图">
        <button
          v-for="v in LIST_VIEWS"
          :key="v.key"
          class="filter"
          role="radio"
          :class="{ on: listView === v.key }"
          :aria-checked="listView === v.key"
          @click="listView = v.key"
        >
          {{ v.label }}
        </button>
      </div>
      <div class="filters" role="group" aria-label="按状态筛选">
        <button
          v-for="f in filters"
          :key="f.state"
          class="filter"
          :class="{ on: stateFilter === f.state }"
          :aria-pressed="stateFilter === f.state"
          @click="stateFilter = f.state"
        >
          {{ f.label }}<span class="count">{{ f.n }}</span>
        </button>
      </div>
      <input v-model="query" type="search" placeholder="搜索客户、备注、email、面板、落地 IP" class="search" aria-label="搜索" />
      <span class="spacer" />
      <button :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      <button class="primary" @click="creating = true">新建客户</button>
    </div>
    <div class="table-wrap">
      <table v-if="listView === 'exits'" class="exits">
        <thead>
          <tr>
            <th>落地 IP</th>
            <th class="num">客户</th>
            <th class="num">线路</th>
            <th>客户名单</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in exitGroups" :key="g.key">
            <td class="e-ip">
              <div :class="{ muted: !g.ip }">{{ g.ip || '未知' }}</div>
              <div class="muted small">{{ g.via }}</div>
              <button v-if="landingByIp.get(g.ip)" class="link small" :title="`给出口经过 ${landingByIp.get(g.ip)!.name} 的客户在落地上直接开 vless 线路`" @click="directPanel = landingByIp.get(g.ip)!.id">
                开通直连
              </button>
            </td>
            <td class="e-count num"><span class="m-label">客户 </span>{{ g.customers.length }}</td>
            <td class="e-lines num muted"><span class="m-label">线路 </span>{{ g.lines || '—' }}</td>
            <td class="e-names">
              <div class="row lines">
                <button
                  v-for="c in g.customers"
                  :key="c.id"
                  class="chip name-chip"
                  :class="{ off: c.state !== 'active' }"
                  :title="c.state === 'active' ? '打开客户' : STATE_LABEL[c.state]"
                  @click="openId = c.id"
                >
                  {{ c.name }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <table v-else class="cust">
        <thead>
          <tr>
            <th class="sortable" @click="sortBy('name')">客户{{ arrow('name') }}</th>
            <th>线路</th>
            <th>落地 IP</th>
            <th class="sortable" @click="sortBy('used')">已用 / 额度{{ arrow('used') }}</th>
            <th class="sortable" @click="sortBy('expire')">到期{{ arrow('expire') }}</th>
            <th class="sortable" @click="sortBy('fetched')">最后拉取{{ arrow('fetched') }}</th>
            <th class="num sortable" title="拉取记录保留期内（默认近 7 天）拉订阅用过几个客户端，按 UA 区分：同版本同型号的两台设备算一个，升级了版本会多算一个" @click="sortBy('clients')">
              客户端{{ arrow('clients') }}
            </th>
            <th class="num sortable" @click="sortBy('price')">月费{{ arrow('price') }}</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in sorted" :key="c.id" class="clickable" @click="openId = c.id">
            <td class="c-name">
              <div class="name">
                {{ c.name }}
                <span v-if="c.state !== 'active'" class="badge inline" :class="c.state">{{ STATE_LABEL[c.state] }}</span>
              </div>
              <div v-if="c.remark" class="muted small">{{ c.remark }}</div>
            </td>
            <td class="c-lines">
              <div class="row lines">
                <span
                  v-for="l in c.lines"
                  :key="l.binding_id"
                  class="chip"
                  :class="{ off: !l.enable && !l.missing, missing: l.missing }"
                  :title="l.missing ? `${l.email}:面板上已找不到` : l.enable ? l.email : `${l.email}:已停用`"
                >
                  {{ l.panel_name }}
                </span>
                <span v-if="!c.lines.length" class="muted small">还没有线路</span>
              </div>
            </td>
            <td class="c-exits small">
              <div v-for="e in exitsById.get(c.id)" :key="e.ip" :title="e.title">{{ e.ip }}</div>
              <span v-if="!exitsById.get(c.id)?.length" class="muted">—</span>
            </td>
            <td class="c-usage"><UsageBar :used="c.used" :quota="c.quota_bytes" /></td>
            <td class="c-due">
              <div :class="{ 'text-warn': dueLevel(c.expire_at) === 'warn', 'text-err': dueLevel(c.expire_at) === 'err', muted: !c.expire_at }">
                {{ fmtDue(c.expire_at) }}
              </div>
              <div v-if="c.expire_at" class="muted small">{{ fmtDate(c.expire_at) }}</div>
            </td>
            <td class="c-fetch">
              <div :class="{ muted: !c.sub_fetched_at }"><span class="m-label">拉取订阅 </span>{{ fmtAgo(c.sub_fetched_at) }}</div>
              <div v-if="c.sub_fetched_ua" class="muted small" :title="c.sub_fetched_ua">{{ shortUa(c.sub_fetched_ua) }}</div>
            </td>
            <td class="c-clients num" :title="c.sub_clients ? `${c.sub_clients} 个客户端，来自 ${c.sub_ips} 个 IP；点开客户看拉取记录` : '最近没有拉过订阅'">
              <div :class="{ muted: !c.sub_clients }"><span class="m-label">客户端 </span>{{ c.sub_clients || '—' }}</div>
              <div v-if="c.sub_clients" class="muted small">{{ c.sub_ips }} 个 IP</div>
            </td>
            <td class="c-price num">{{ fmtPrice(c.monthly_price) }}</td>
            <td class="c-state">
              <span v-if="c.state !== 'active'" class="badge" :class="c.state">{{ STATE_LABEL[c.state] }}</span>
            </td>
            <td class="c-act num">
              <div v-if="c.sub_url" class="acts">
                <button class="link small" @click.stop="copyText(c.sub_url, `已复制「${c.name}」的订阅链接`)">复制订阅</button>
                <button class="link small" @click.stop="qrFor = c">二维码</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!filtered.length" class="empty">
        <template v-if="customers.length">没有符合条件的客户。<button class="link" @click="(query = ''), (stateFilter = '')">清除搜索和筛选</button></template>
        <template v-else>还没有客户。点「新建客户」创建,再在详情里添加线路。</template>
      </div>
    </div>
  </section>

  <DirectLines v-if="directPanel" :panel-id="directPanel" @close="directPanel = null" @done="load" />

  <Modal v-if="creating" title="新建客户" @close="creating = false">
    <form id="create-form" class="form" @submit.prevent="create">
      <label class="field">名称<input v-model="form.name" required /></label>
      <label class="field">备注<input v-model="form.remark" /></label>
      <div class="grid">
        <label class="field">月费(元)<input v-model="form.price" type="number" min="0" step="0.01" /></label>
        <label class="field">总额度(GB,空 = 不限)<input v-model="form.quotaGb" type="number" min="0" step="1" /></label>
        <label class="field">到期日(空 = 不限期)<input v-model="form.expire" type="date" /></label>
      </div>
      <p class="muted small">创建后在详情里添加线路。</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="creating = false">取消</button>
      <button class="primary" form="create-form">创建客户</button>
    </template>
  </Modal>

  <Modal v-if="qrFor?.sub_url" :title="`「${qrFor.name}」的订阅二维码`" @close="qrFor = null">
    <SubQr :url="qrFor.sub_url" :name="qrFor.name" />
  </Modal>

  <CustomerDetail v-if="openId != null" :id="openId" @close="openId = null" @changed="load" />
</template>

<style scoped>
.kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.kpi {
  padding: 16px 18px;
  min-width: 0;
}
.kpi-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.kpi-value {
  margin-top: 6px;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.kpi-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.overview {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 18px 0;
}
.panel-head h2,
.table-title {
  font-size: 15px;
}
.due-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0 8px 8px;
}
.due-row {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto 44px;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  box-shadow: none;
  text-align: left;
  font-weight: 400;
}
.due-row:hover:not(:disabled) {
  background: var(--hover);
}
.due-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.due-when {
  font-size: 13px;
  white-space: nowrap;
}
.due-date {
  font-size: 12px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.due-empty,
.due-more {
  margin: 0;
  padding: 10px 18px 14px;
}
.due-empty {
  padding-top: 24px;
}
.toolbar {
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
  gap: 10px 12px;
}
.filters {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--rule-soft);
}
.filter {
  border: none;
  box-shadow: none;
  background: none;
  padding: 3px 10px;
  border-radius: 7px;
  color: var(--ink-soft);
}
.filter:hover:not(:disabled) {
  background: none;
  color: var(--ink);
}
.filter.on {
  background: var(--sheet);
  color: var(--ink);
  box-shadow: var(--shadow);
}
.count {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}
th.sortable {
  cursor: pointer;
  user-select: none;
}
th.sortable:hover {
  color: var(--ink);
}
.search {
  width: 240px;
  max-width: 100%;
}
.name {
  font-weight: 500;
}
.badge.inline {
  display: none;
  margin-left: 4px;
}
.lines {
  gap: 4px;
  max-width: 340px;
}
.acts {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
.c-due,
.c-fetch,
.c-clients,
.c-exits {
  white-space: nowrap;
}
.c-exits {
  font-variant-numeric: tabular-nums;
}
.e-ip {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.e-names {
  width: 60%;
}
.name-chip {
  cursor: pointer;
}
.m-label {
  display: none;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
@media (max-width: 1080px) {
  .kpis {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .overview {
    grid-template-columns: 1fr;
  }
}
/* 手机上每位客户一块,不横向滚动 */
@media (max-width: 720px) {
  .kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .kpi-value {
    font-size: 22px;
  }
  .cust thead {
    display: none;
  }
  .cust,
  .cust tbody,
  .cust td {
    display: block;
  }
  .cust tr {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas:
      'name due'
      'usage usage'
      'lines lines'
      'exits exits'
      'fetch clients'
      'price act';
    gap: 6px 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .cust td {
    border: none;
    padding: 0;
  }
  .c-name {
    grid-area: name;
  }
  .c-due {
    grid-area: due;
    text-align: right;
  }
  .c-usage {
    grid-area: usage;
  }
  .c-lines {
    grid-area: lines;
  }
  .c-exits {
    grid-area: exits;
    display: flex !important;
    flex-wrap: wrap;
    gap: 2px 10px;
  }
  .c-exits::before {
    content: '落地';
    color: var(--ink-soft);
  }
  .c-fetch {
    grid-area: fetch;
    font-size: 12px;
  }
  .c-fetch div {
    display: inline;
    margin-right: 8px;
  }
  .c-clients {
    grid-area: clients;
    font-size: 12px;
  }
  .c-clients div {
    display: inline;
    margin-left: 8px;
  }
  .m-label {
    display: inline;
  }
  .c-price {
    grid-area: price;
    text-align: left;
  }
  .c-act {
    grid-area: act;
  }
  .c-state {
    display: none !important;
  }
  .exits thead {
    display: none;
  }
  .exits,
  .exits tbody,
  .exits td {
    display: block;
  }
  .exits tr {
    display: grid;
    grid-template-columns: 1fr auto auto;
    grid-template-areas:
      'ip count lines'
      'names names names';
    gap: 6px 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .exits td {
    border: none;
    padding: 0;
  }
  .e-ip {
    grid-area: ip;
  }
  .e-count {
    grid-area: count;
  }
  .e-lines {
    grid-area: lines;
  }
  .e-names {
    grid-area: names;
    width: auto;
  }
  .badge.inline {
    display: inline-block;
  }
}
</style>
