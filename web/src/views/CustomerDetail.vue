<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { api } from '../api';
import { copyText } from '../clipboard';
import Modal from '../components/Modal.vue';
import OpenLines from '../components/OpenLines.vue';
import RenewDialog from '../components/RenewDialog.vue';
import SubFetches from '../components/SubFetches.vue';
import UsageBar from '../components/UsageBar.vue';
import {
  bytesToGb,
  dateInputToMs,
  dueLevel,
  fmtAgo,
  fmtBytes,
  fmtDate,
  fmtDateTime,
  fmtDue,
  gbToBytes,
  msToDateInput,
  nextMonthlyReset,
  shortUa,
  STATE_LABEL,
} from '../format';
import { toast, toastError } from '../toast';
import type { ClientRow, Customer, CustomerInput, CustomerStatus, DailyUsage, Line, LineAction, LineOpResult, OpenLineResult, SubPreviewLine } from '../types';

// 二维码库只在点开二维码时才加载
const SubQr = defineAsyncComponent(() => import('../components/SubQr.vue'));

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const customer = ref<Customer | null>(null);
const daily = ref<DailyUsage | null>(null);
const form = ref({ name: '', remark: '', price: '', quotaGb: '', expire: '', status: 'active' as CustomerStatus, monthlyReset: false });
/** 打开时的表单值:保存时只提交改过的字段 */
const loaded = ref({ ...form.value });

function fillForm(c: Customer) {
  form.value = {
    name: c.name,
    remark: c.remark,
    price: c.monthly_price == null ? '' : String(c.monthly_price),
    quotaGb: c.quota_bytes ? String(bytesToGb(c.quota_bytes)) : '',
    expire: msToDateInput(c.expire_at),
    status: c.status,
    monthlyReset: c.monthly_reset_at > 0,
  };
  loaded.value = { ...form.value };
}

/**
 * 表单里改过的字段。没动的不提交:到期日在表单里只精确到天、额度按 GB 取两位小数,
 * 原样提交会把它们改写(如到期时间被推到当天 23:59,已到期的客户就"恢复正常"了)。
 */
function changedFields(): CustomerInput {
  const f = form.value;
  const o = loaded.value;
  const body: CustomerInput = {};
  if (f.name !== o.name) body.name = f.name;
  if (f.remark !== o.remark) body.remark = f.remark;
  if (f.price !== o.price) body.monthly_price = f.price === '' ? null : Number(f.price);
  if (f.quotaGb !== o.quotaGb) body.quota_bytes = f.quotaGb === '' ? 0 : gbToBytes(Number(f.quotaGb));
  if (f.expire !== o.expire) body.expire_at = dateInputToMs(f.expire);
  if (f.status !== o.status) body.status = f.status;
  if (f.monthlyReset !== o.monthlyReset) body.monthly_reset = f.monthlyReset;
  return body;
}

async function load() {
  try {
    const res = await api.customer(props.id);
    customer.value = res.customer;
    daily.value = res.daily;
    fillForm(res.customer);
  } catch (e) {
    toastError(e);
    emit('close');
  }
}

// ---------- 订阅 ----------
const preview = ref<SubPreviewLine[] | null>(null);
const showQr = ref(false);
const showFetches = ref(false);
const previewing = ref(false);

async function loadPreview() {
  previewing.value = true;
  try {
    preview.value = await api.subPreview(props.id);
  } catch (e) {
    toastError(e);
  } finally {
    previewing.value = false;
  }
}

const previewCount = computed(() => (preview.value ?? []).reduce((n, l) => n + l.nodes.length, 0));

function applied(c: Customer, message: string) {
  customer.value = c;
  fillForm(c);
  toast(message);
  emit('changed');
}

/** 面板上实际做了什么,如"启用 2 条、去掉面板限制 1 条" */
function panelSummary(lines: LineOpResult[]): string {
  const actions: LineAction[] = ['流量清零', '启用', '停用', '去掉面板限制'];
  const parts = actions.map((a) => [a, lines.filter((l) => l.actions.includes(a)).length] as const).filter(([, n]) => n > 0);
  return parts.length ? `面板上${parts.map(([a, n]) => `${a} ${n} 条`).join('、')}` : '面板上已一致';
}

/** 有问题的线路逐条弹出来,避免错过 */
function alertProblems(lines: LineOpResult[], head: string) {
  const label = (l: LineOpResult) => `${l.panel} 上的 ${l.email}`;
  const problems = lines.filter((l) => l.error).map((l) => `${label(l)}:${l.error}`);
  if (problems.length) alert(`${head},但以下线路需要处理:\n\n${problems.join('\n')}`);
}

const saving = ref(false);

async function resetLink() {
  if (!confirm('重置后客户手里的订阅链接立即失效，需要把新链接发给客户。继续？')) return;
  try {
    applied(await api.resetSubToken(props.id), '订阅链接已重置');
  } catch (e) {
    toastError(e);
  }
}

async function save() {
  const disabling = customer.value?.status === 'active' && form.value.status === 'disabled';
  if (disabling && !confirm('停用后会立即停用这个客户在各面板上的全部线路。继续?')) return;
  saving.value = true;
  try {
    const c = await api.updateCustomer(props.id, changedFields());
    const notActive = c.status === 'active' && c.state !== 'active' ? `(客户${STATE_LABEL[c.state]},线路保持停用)` : '';
    applied(c, c.panel_ops ? `已保存;${panelSummary(c.panel_ops)}${notActive}` : `已保存${notActive}`);
    if (c.panel_ops) alertProblems(c.panel_ops, '已保存');
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

const resetting = ref(false);

async function resetUsage() {
  if (!confirm('把本周期已用清零?\n\n会同时把各面板上这个客户线路的流量清零,并重新启用停用的线路(客户已停用或已到期时不启用)。不可撤销。')) return;
  resetting.value = true;
  try {
    const { customer: c, lines } = await api.resetUsage(props.id);
    applied(c, lines.length ? `已清零;${panelSummary(lines)}` : '已清零(没有绑定线路)');
    alertProblems(lines, '本地已清零');
  } catch (e) {
    toastError(e);
  } finally {
    resetting.value = false;
  }
}

// ---------- 续费 / 按出口开通线路 ----------
const renewing = ref(false);
const opening = ref(false);

function renewed(c: Customer, lines: LineOpResult[]) {
  renewing.value = false;
  applied(c, `已续费到 ${fmtDate(c.expire_at)}` + (lines.length ? `;${panelSummary(lines)}` : ''));
  alertProblems(lines, '已续费');
}

function opened(c: Customer, results: OpenLineResult[]) {
  opening.value = false;
  const fresh = results.filter((r) => r.ok && r.created).length;
  applied(
    c,
    results.length ? `已开通 ${results.filter((r) => r.ok).length} 条线路${fresh ? `(其中 ${fresh} 台中转新建了入站)` : ''}` : '没有需要开通的线路',
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) alert(`以下线路没有开通:\n\n${failed.map((r) => `${r.panel} 的 ${r.inbound}:${r.error}`).join('\n')}`);
}

async function remove() {
  if (
    !customer.value ||
    !confirm(
      `删除客户「${customer.value.name}」?\n\n会先删掉他在各面板上的全部 client(线路),再删除客户和他的订阅链接(链接立即失效)。` +
        '流量历史保留。不可撤销。',
    )
  )
    return;
  try {
    const { lines } = await api.deleteCustomer(props.id);
    const removed = lines.filter((l) => !l.missing).length;
    toast(removed ? `已删除面板上的 ${removed} 个 client 和客户` : '已删除客户');
    emit('changed');
    emit('close');
  } catch (e) {
    toastError(e);
  }
}

async function unbind(line: Line) {
  if (!confirm(`解绑 ${line.panel_name} 上的 ${line.email}?之后这条线路的流量不再计入这位客户。`)) return;
  try {
    applied(await api.removeBinding(props.id, line.binding_id), '已解绑');
  } catch (e) {
    toastError(e);
  }
}

// ---------- 添加线路 ----------
const picking = ref(false);
const candidates = ref<ClientRow[]>([]);
const pickQuery = ref('');
const includeUsage = ref(false);

async function openPicker() {
  picking.value = true;
  pickQuery.value = '';
  includeUsage.value = false;
  try {
    candidates.value = await api.clients(true);
  } catch (e) {
    toastError(e);
  }
}

const filteredCandidates = computed(() => {
  const q = pickQuery.value.trim().toLowerCase();
  const list = candidates.value.filter((c) => !c.missing);
  if (!q) return list.slice(0, 200);
  return list.filter((c) => c.email.toLowerCase().includes(q) || c.panel_name.toLowerCase().includes(q) || c.comment.toLowerCase().includes(q)).slice(0, 200);
});

async function bind(row: ClientRow) {
  try {
    const c = await api.addBinding(props.id, { panel_id: row.panel_id, email: row.email, include_current_usage: includeUsage.value });
    picking.value = false;
    applied(c, `已添加线路：${row.panel_name} 上的 ${row.email}`);
  } catch (e) {
    toastError(e);
  }
}

function lineHints(line: Line): string[] {
  const hints: string[] = [];
  if (line.missing) hints.push('面板上已找不到该 client');
  // 到期和额度由本系统管,面板上应当不设;设了的话面板会按它自己停用线路
  if (line.panel_total_bytes) hints.push(`面板上还设了额度 ${fmtBytes(line.panel_total_bytes)}`);
  if (line.panel_expiry_ms) hints.push(`面板上还设了到期 ${fmtDate(line.panel_expiry_ms)}`);
  return hints;
}

onMounted(load);
</script>

<template>
  <Modal :title="customer ? customer.name : '客户详情'" wide @close="emit('close')">
    <template v-if="customer">
      <section class="head">
        <div class="head-usage">
          <UsageBar :used="customer.used" :quota="customer.quota_bytes" />
        </div>
        <dl class="facts">
          <div v-if="customer.state !== 'active'">
            <dt>状态</dt>
            <dd><span class="badge" :class="customer.state">{{ STATE_LABEL[customer.state] }}</span></dd>
          </div>
          <div>
            <dt>到期</dt>
            <dd :class="{ 'text-warn': dueLevel(customer.expire_at) === 'warn', 'text-err': dueLevel(customer.expire_at) === 'err' }">
              {{ fmtDue(customer.expire_at) }}<span v-if="customer.expire_at" class="muted small">{{ fmtDate(customer.expire_at) }}</span>
            </dd>
          </div>
          <div>
            <dt>上行 / 下行</dt>
            <dd>{{ fmtBytes(customer.used_up) }} / {{ fmtBytes(customer.used_down) }}</dd>
          </div>
          <div v-if="customer.remaining != null">
            <dt>剩余</dt>
            <dd>{{ fmtBytes(customer.remaining) }}</dd>
          </div>
          <div>
            <dt>统计起点</dt>
            <dd>{{ fmtDateTime(customer.usage_reset_at) }}</dd>
          </div>
          <div v-if="customer.monthly_reset_at && customer.expire_at">
            <dt>下次重置</dt>
            <dd>{{ fmtDate(nextMonthlyReset(customer.expire_at)) }}<span class="muted small">每月到期日自动清零</span></dd>
          </div>
        </dl>
      </section>

      <form class="grid" @submit.prevent="save">
        <label class="field">名称<input v-model="form.name" required /></label>
        <label class="field">备注<input v-model="form.remark" /></label>
        <label class="field">月费(元)<input v-model="form.price" type="number" min="0" step="0.01" /></label>
        <label class="field">总额度(GB,空 = 不限)<input v-model="form.quotaGb" type="number" min="0" step="1" /></label>
        <label class="field">到期日(空 = 不限期)<input v-model="form.expire" type="date" /></label>
        <label class="field">
          状态
          <select v-model="form.status">
            <option value="active">启用</option>
            <option value="disabled">停用</option>
          </select>
        </label>
        <label class="row small monthly" :title="form.expire ? '' : '不限期的客户没有到期日，无法按到期日重置'">
          <input v-model="form.monthlyReset" type="checkbox" :disabled="!form.expire && !form.monthlyReset" />
          每月按到期日重置流量{{ form.expire ? `（每月 ${Number(form.expire.slice(8, 10))} 号 0 点自动清零已用${Number(form.expire.slice(8, 10)) > 28 ? '，没有这天的月份取当月最后一天' : ''}）` : '' }}
        </label>
        <div class="actions row">
          <button class="primary" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
          <span class="muted small">到期、超额或停用时，各面板上的线路会自动停用；恢复正常时重新启用。面板上不设到期和额度。</span>
        </div>
      </form>

      <section class="sub">
        <div class="section-title">
          <h3>订阅</h3>
          <span class="muted small" :title="customer.sub_fetched_ua ?? undefined">
            上次被拉取在 {{ fmtAgo(customer.sub_fetched_at) }}<template v-if="customer.sub_fetched_ua">，用 {{ shortUa(customer.sub_fetched_ua) }}</template>
          </span>
          <span class="spacer" />
          <button @click="showFetches = !showFetches">{{ showFetches ? '收起拉取记录' : '拉取记录' }}</button>
          <button :disabled="previewing" @click="loadPreview">{{ previewing ? '读取中…' : '预览节点' }}</button>
        </div>
        <div v-if="customer.sub_url" class="sub-row">
          <input class="grow" readonly :value="customer.sub_url" aria-label="订阅链接" @focus="($event.target as HTMLInputElement).select()" />
          <button class="primary" @click="copyText(customer.sub_url!, '订阅链接已复制')">复制链接</button>
          <button :aria-expanded="showQr" @click="showQr = !showQr">{{ showQr ? '收起二维码' : '二维码' }}</button>
          <button class="danger" @click="resetLink">重置链接</button>
        </div>
        <p v-else class="notice small">还没有配置订阅域名（SUB_BASE_URL），生成不了订阅链接。</p>
        <p class="muted small hint">
          包含全部 {{ customer.lines.length }} 条线路，带全局的已用、额度和到期。格式按客户端自动给：Clash、Mihomo、Stash、Shadowrocket 拿 Clash 配置，sing-box、Hiddify 拿 sing-box 配置，v2rayN 等拿节点链接。
        </p>
        <SubQr v-if="showQr && customer.sub_url" class="qr-block" :url="customer.sub_url" :name="customer.name" />
        <div v-if="preview" class="preview">
          <div class="small"><span class="figure">{{ previewCount }}</span> 个节点</div>
          <div v-for="l in preview" :key="l.panel_id + l.email" class="preview-line small">
            <span class="line-panel">{{ l.panel_name }}</span>
            <span class="muted">{{ l.email }}</span>
            <span v-if="l.error" class="badge err" :title="l.error">获取失败</span>
            <span v-for="n in l.nodes" :key="n.name + n.protocol" class="chip"><span class="muted">{{ n.protocol }}</span>{{ n.name || '(无名称)' }}</span>
            <span v-if="!l.nodes.length && !l.error" class="muted">没有节点</span>
          </div>
        </div>
        <SubFetches v-if="showFetches" :customer-id="customer.id" />
      </section>

      <section>
        <div class="section-title">
          <h3>线路({{ customer.lines.length }})</h3>
          <span class="spacer" />
          <button class="primary" @click="opening = true">开通线路</button>
          <button @click="openPicker">绑定已有 client</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>面板</th>
                <th>email</th>
                <th class="num">面板计数</th>
                <th>最后在线</th>
                <th>面板侧设置</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in customer.lines" :key="l.binding_id">
                <td>
                  <div class="line-panel">{{ l.panel_name }}</div>
                  <div class="muted small">{{ l.panel_role === 'relay' ? '中转' : '落地' }}</div>
                </td>
                <td>
                  {{ l.email }}
                  <span v-if="l.missing" class="badge">面板上找不到</span>
                  <span v-else-if="!l.enable" class="badge err">已停用</span>
                  <div v-if="l.comment" class="muted small">{{ l.comment }}</div>
                </td>
                <td class="num small">{{ fmtBytes(l.up + l.down) }}</td>
                <td class="small">{{ fmtAgo(l.last_online) }}</td>
                <td class="small muted">
                  <div v-for="h in lineHints(l)" :key="h">{{ h }}</div>
                  <span v-if="!lineHints(l).length">不设限制</span>
                </td>
                <td class="num"><button class="link danger" @click="unbind(l)">解绑</button></td>
              </tr>
            </tbody>
          </table>
          <div v-if="!customer.lines.length" class="empty">还没有线路。点「开通线路」选一个出口，自动在各台中转上开好；或「绑定已有 client」从面板上已有的里选。</div>
        </div>
      </section>

      <section v-if="daily">
        <div class="section-title">
          <h3>近 {{ daily.days.length }} 天用量</h3>
        </div>
        <div class="table-wrap">
          <table class="daily">
            <thead>
              <tr>
                <th>日期</th>
                <th class="num">合计</th>
                <th v-for="l in daily.lines" :key="l.panel_name + l.email" class="num">{{ l.panel_name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(day, i) in daily.days.slice().reverse()" :key="day">
                <td class="small">{{ day }}</td>
                <td class="num small">{{ fmtBytes(daily.totals[daily.days.length - 1 - i]) }}</td>
                <td v-for="l in daily.lines" :key="l.panel_name + l.email" class="num small muted">
                  {{ fmtBytes(l.values[daily.days.length - 1 - i]) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <template #footer>
      <button class="danger" @click="remove">删除客户</button>
      <button :disabled="!customer?.expire_at" :title="customer?.expire_at ? '' : '不限期的客户不用续费'" @click="renewing = true">续费</button>
      <button :disabled="resetting" @click="resetUsage">{{ resetting ? '清零中…' : '已用清零' }}</button>
      <span class="spacer" />
      <button @click="emit('close')">关闭</button>
    </template>
  </Modal>

  <RenewDialog v-if="renewing && customer" :customer="customer" @close="renewing = false" @done="renewed" />
  <OpenLines
    v-if="opening && customer"
    :customer-id="customer.id"
    :customer-name="customer.name"
    :active="customer.state === 'active'"
    @close="opening = false"
    @done="opened"
  />

  <Modal v-if="picking" title="绑定已有 client" wide @close="picking = false">
    <div class="row picker-bar">
      <input v-model="pickQuery" type="search" placeholder="搜索 email、面板、备注" autofocus class="grow" aria-label="搜索 client" />
      <label class="row small"><input v-model="includeUsage" type="checkbox" />计入该线路当前已用</label>
    </div>
    <div class="table-wrap picker">
      <table>
        <tbody>
          <tr v-for="c in filteredCandidates" :key="c.panel_id + ':' + c.email" class="clickable" @click="bind(c)">
            <td>{{ c.panel_name }}</td>
            <td>{{ c.email }}</td>
            <td class="small muted">{{ c.comment }}</td>
            <td class="num small">{{ fmtBytes(c.up + c.down) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!filteredCandidates.length" class="empty">没有可添加的 client。这里只列出还没绑定到任何客户的。</div>
    </div>
  </Modal>
</template>

<style scoped>
.head {
  display: grid;
  grid-template-columns: minmax(220px, 300px) 1fr;
  gap: 16px 28px;
  align-items: start;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--rule-soft);
}
.head-usage :deep(.nums) {
  font-size: 15px;
}
.head-usage :deep(.bar) {
  height: 6px;
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
.facts dd .small {
  margin-left: 6px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.actions {
  grid-column: 1 / -1;
}
.monthly {
  grid-column: 1 / -1;
}
.sub-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.hint {
  margin: 0 0 10px;
  max-width: 80ch;
}
.qr-block {
  margin-bottom: 12px;
}
.preview {
  border: 1px solid var(--rule-soft);
  border-radius: 4px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.line-panel {
  font-weight: 500;
}
section {
  margin-bottom: 24px;
}
.section-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 12px;
  margin-bottom: 8px;
}
.section-title .spacer {
  flex: 1;
}
h3 {
  font-size: 15px;
}
.daily th,
.daily td {
  padding: 6px 10px;
}
.picker-bar {
  margin-bottom: 12px;
}
.picker-bar .grow {
  min-width: 200px;
}
.picker {
  max-height: 60vh;
  overflow-y: auto;
}
@media (max-width: 640px) {
  .head {
    grid-template-columns: 1fr;
  }
}
</style>
