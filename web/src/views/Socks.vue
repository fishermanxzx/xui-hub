<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import UninstallSocks from '../components/UninstallSocks.vue';
import { fmtAgo, fmtDateTime, fmtPrice } from '../format';
import { toast, toastError } from '../toast';
import type { Socks, SocksInput, SocksUsage, UnregisteredSocks } from '../types';

const list = ref<Socks[]>([]);
const usage = ref<SocksUsage | null>(null);
const scanning = ref(false);
const checkingAll = ref(false);
const checking = ref(new Set<number>());

async function load() {
  try {
    list.value = await api.socks();
  } catch (e) {
    toastError(e);
  }
}

/** 扫描各面板的 Xray 配置(要连每个面板,几秒钟) */
async function scan() {
  scanning.value = true;
  try {
    usage.value = await api.socksUsage();
  } catch (e) {
    toastError(e);
  } finally {
    scanning.value = false;
  }
}

async function checkOne(s: Socks) {
  checking.value.add(s.id);
  try {
    const updated = await api.checkSocks(s.id);
    Object.assign(s, updated);
    if (updated.check?.ok) toast(`「${s.name}」可用，延迟 ${updated.check.ms} ms，出口 ${updated.check.ip ?? '未知'}`);
    else toast(`「${s.name}」${updated.check?.error ?? '测试失败'}`, 'err');
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
    const bad = list.value.filter((s) => !s.check?.ok).length;
    toast(`测试完成：${list.value.length - bad} 个可用，${bad} 个失败`, bad ? 'err' : 'ok');
  } catch (e) {
    toastError(e);
  } finally {
    checkingAll.value = false;
  }
}

const costSummary = computed(() => {
  const unset = list.value.filter((s) => s.monthly_cost == null).length;
  const total = list.value.reduce((sum, s) => sum + Math.round((s.monthly_cost ?? 0) * 100), 0) / 100;
  return { total, unset };
});

/** 出口地区:常见的给中文名,其余原样显示代码(不用国旗 emoji,部分系统地区设置下会显示成方框) */
const REGION: Record<string, string> = {
  US: '美国', TW: '台湾', HK: '香港', JP: '日本', SG: '新加坡', KR: '韩国', DE: '德国', GB: '英国',
  NL: '荷兰', FR: '法国', CA: '加拿大', AU: '澳大利亚', MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾', IN: '印度', RU: '俄罗斯',
};
function region(loc: string | null): string {
  return loc ? (REGION[loc] ?? loc) : '';
}

// ---------- 新增 / 编辑 ----------
const editing = ref<Socks | null>(null);
const showForm = ref(false);
const form = ref({ name: '', address: '', monthly_cost: '', remark: '' });

function openForm(s: Socks | null) {
  editing.value = s;
  form.value = { name: s?.name ?? '', address: '', monthly_cost: s?.monthly_cost == null ? '' : String(s.monthly_cost), remark: s?.remark ?? '' };
  showForm.value = true;
}

async function submit() {
  const body: SocksInput = {
    name: form.value.name,
    monthly_cost: form.value.monthly_cost === '' ? null : Number(form.value.monthly_cost),
    remark: form.value.remark,
  };
  if (form.value.address.trim()) body.address = form.value.address.trim();
  try {
    if (editing.value) await api.updateSocks(editing.value.id, body);
    else await api.createSocks(body);
    showForm.value = false;
    toast('已保存');
    await load();
  } catch (e) {
    toastError(e);
  }
}

/** 表格内直接改月成本:回车或离开输入框即保存,清空 = 未填 */
async function saveCost(s: Socks, event: Event) {
  const input = event.target as HTMLInputElement;
  const text = input.value.trim();
  const cost = text === '' ? null : Number(text);
  if (cost === s.monthly_cost) return;
  try {
    const updated = await api.updateSocks(s.id, { monthly_cost: cost });
    s.monthly_cost = updated.monthly_cost;
    input.value = updated.monthly_cost == null ? '' : String(updated.monthly_cost);
    toast(`${s.name} 月成本已保存`);
  } catch (e) {
    input.value = s.monthly_cost == null ? '' : String(s.monthly_cost);
    toastError(e);
  }
}

async function remove(s: Socks) {
  const n = usage.value?.uses[s.id]?.length ?? 0;
  const inUse = n
    ? `\n\n面板上还有 ${n} 个出站在用它,删除只是从本系统移除,不会动面板。要连面板上的出站、路由和入站一起删,用「卸载」。`
    : '\n\n只从本系统移除,不会动面板。';
  if (!confirm(`删除 SOCKS「${s.name}」?${inUse}`)) return;
  try {
    await api.deleteSocks(s.id);
    toast('已删除');
    await load();
  } catch (e) {
    toastError(e);
  }
}

// ---------- 卸载:删各面板上指向它的出站、路由和入站,再从系统移除 ----------
const uninstalling = ref<Socks | null>(null);

async function afterUninstall() {
  await load();
  if (usage.value) await scan();
}

// ---------- 登记面板上未登记的 SOCKS ----------
const adopting = ref<UnregisteredSocks | null>(null);
const adoptForm = ref({ name: '', monthly_cost: '' });

function openAdopt(u: UnregisteredSocks) {
  adopting.value = u;
  adoptForm.value = { name: u.outbound_tag, monthly_cost: '' };
}

async function adopt() {
  const u = adopting.value;
  if (!u) return;
  try {
    await api.adoptSocks({
      panel_id: u.panel_id,
      outbound_tag: u.outbound_tag,
      name: adoptForm.value.name,
      monthly_cost: adoptForm.value.monthly_cost === '' ? null : Number(adoptForm.value.monthly_cost),
    });
    adopting.value = null;
    toast('已登记');
    await load();
    await scan();
  } catch (e) {
    toastError(e);
  }
}

onMounted(() => {
  void load();
  void scan();
});
</script>

<template>
  <section class="sheet">
    <div class="toolbar">
      <div class="title">
        <h2>SOCKS</h2>
        <p class="muted small">
          {{ list.length }} 个，月成本合计 <span class="figure">{{ fmtPrice(costSummary.total) }}</span><template v-if="costSummary.unset">，{{ costSummary.unset }} 个没填</template>。
        </p>
      </div>
      <div class="row">
        <button :disabled="scanning" @click="scan">{{ scanning ? '扫描面板中…' : '刷新使用情况' }}</button>
        <button :disabled="checkingAll || !list.length" @click="checkAll">{{ checkingAll ? '测试中…' : '全部测试' }}</button>
        <button class="primary" @click="openForm(null)">添加 SOCKS</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>地址</th>
            <th class="num">月成本(元)</th>
            <th>出口</th>
            <th>测试</th>
            <th>面板使用</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in list" :key="s.id">
            <td>
              <div class="name">{{ s.name }}</div>
              <div v-if="s.remark" class="muted small">{{ s.remark }}</div>
            </td>
            <td>
              <div>{{ s.host }}:{{ s.port }}</div>
              <div class="muted small">{{ s.username ? `用户 ${s.username}` : '无认证' }}</div>
            </td>
            <td class="num">
              <input
                class="cost"
                type="number"
                min="0"
                step="0.01"
                placeholder="未填"
                :value="s.monthly_cost ?? ''"
                :aria-label="s.name + ' 月成本'"
                @change="saveCost(s, $event)"
                @keyup.enter="($event.target as HTMLInputElement).blur()"
              />
            </td>
            <td>
              <template v-if="s.check?.ip">
                <div>{{ s.check.ip }}</div>
                <div class="muted small">{{ region(s.check.loc) }}</div>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td class="small test">
              <template v-if="s.check">
                <div v-if="s.check.ok">{{ s.check.ms }} ms</div>
                <div v-else class="text-err">{{ s.check.error }}</div>
                <div class="muted" :title="fmtDateTime(s.check.at)">{{ fmtAgo(s.check.at) }}测试</div>
              </template>
              <span v-else class="muted">还没测试</span>
            </td>
            <td class="small uses">
              <span v-if="!usage" class="muted">{{ scanning ? '扫描中…' : '—' }}</span>
              <template v-else>
                <div v-for="u in usage.uses[s.id] ?? []" :key="u.panel + u.outbound_tag" class="use">
                  <span class="use-panel">{{ u.panel }}</span>
                  <span class="muted">出站 {{ u.outbound_tag }}</span>
                  <span v-if="u.inbound_tags.length" class="muted">入站 {{ u.inbound_tags.join('、') }}</span>
                  <span v-else class="muted">没有路由</span>
                </div>
                <div v-for="u in usage.mismatched[s.id] ?? []" :key="'m' + u.panel + u.outbound_tag" class="use text-warn">
                  <span class="use-panel">{{ u.panel }}</span>
                  <span>出站 {{ u.outbound_tag }} 的账号与这里不一致</span>
                </div>
                <span v-if="!(usage.uses[s.id] ?? []).length && !(usage.mismatched[s.id] ?? []).length" class="muted">没有面板在用</span>
              </template>
            </td>
            <td class="num">
              <div class="ops">
                <button class="link" :disabled="checking.has(s.id)" @click="checkOne(s)">{{ checking.has(s.id) ? '测试中…' : '测试' }}</button>
                <button class="link" @click="openForm(s)">编辑</button>
                <button class="link danger" @click="uninstalling = s">卸载</button>
                <button class="link danger" @click="remove(s)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!list.length" class="empty">
        还没有 SOCKS。点「添加 SOCKS」登记购买的代理，或从下方「面板上在用但未登记的」一键登记。
      </div>
    </div>
    <p class="muted small note">测试从管理服务器发起，经代理访问 Cloudflare 拿到出口 IP。代理商若按来源 IP 放行，中转机上的结果可能不同。</p>
  </section>

  <section v-if="usage && (usage.unregistered.length || usage.errors.length)" class="sheet">
    <div class="toolbar">
      <div class="title">
        <h2>面板上没登记的外部 SOCKS</h2>
        <p class="muted small">面板在用、这里还没登记的。指向自己面板机器的 socks 出站(中转到落地)不算在内。</p>
      </div>
    </div>
    <div v-if="usage.unregistered.length" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>面板</th>
            <th>出站</th>
            <th>地址</th>
            <th>入站</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in usage.unregistered" :key="u.panel + u.outbound_tag">
            <td class="name">{{ u.panel }}</td>
            <td>{{ u.outbound_tag }}</td>
            <td>
              <div>{{ u.host }}:{{ u.port }}</div>
              <div class="muted small">{{ u.has_auth ? '有认证' : '无认证' }}</div>
            </td>
            <td class="small">
              <span v-if="u.inbound_tags.length">{{ u.inbound_tags.join('、') }}</span>
              <span v-else class="muted">没有路由</span>
            </td>
            <td class="num"><button class="link" @click="openAdopt(u)">登记</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-for="e in usage.errors" :key="e.panel" class="text-err small note">读取面板「{{ e.panel }}」失败：{{ e.error }}</p>
  </section>

  <Modal v-if="showForm" :title="editing ? `编辑 SOCKS「${editing.name}」` : '添加 SOCKS'" @close="showForm = false">
    <form id="socks-form" class="form" @submit.prevent="submit">
      <label class="field">名称<input v-model="form.name" required /></label>
      <label class="field">
        地址{{ editing ? `(现在是 ${editing.host}:${editing.port}${editing.username ? `,用户 ${editing.username}` : ''};不改就留空)` : '' }}
        <input
          v-model="form.address"
          autocomplete="off"
          :required="!editing"
          placeholder="socks5://用户:密码@主机:端口 或 主机:端口:用户:密码"
        />
      </label>
      <div class="grid">
        <label class="field">月成本(元)<input v-model="form.monthly_cost" type="number" min="0" step="0.01" /></label>
        <label class="field">备注<input v-model="form.remark" /></label>
      </div>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">取消</button>
      <button class="primary" form="socks-form">保存</button>
    </template>
  </Modal>

  <UninstallSocks v-if="uninstalling" :socks="uninstalling" @close="uninstalling = null" @done="afterUninstall" />

  <Modal v-if="adopting" :title="`登记 ${adopting.host}:${adopting.port}`" @close="adopting = null">
    <form id="adopt-form" class="form" @submit.prevent="adopt">
      <p class="muted small">地址和账号密码从面板「{{ adopting.panel }}」的出站 {{ adopting.outbound_tag }} 读取，不用手填。</p>
      <div class="grid">
        <label class="field">名称<input v-model="adoptForm.name" required /></label>
        <label class="field">月成本(元)<input v-model="adoptForm.monthly_cost" type="number" min="0" step="0.01" /></label>
      </div>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="adopting = null">取消</button>
      <button class="primary" form="adopt-form">登记</button>
    </template>
  </Modal>
</template>

<style scoped>
.sheet + .sheet {
  margin-top: 20px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--rule);
}
h2 {
  font-size: 16px;
}
.title p {
  margin: 4px 0 0;
  max-width: 72ch;
}
.name {
  font-weight: 500;
}
.cost {
  width: 84px;
  text-align: right;
  padding: 3px 8px;
  font-variant-numeric: tabular-nums;
}
.test {
  max-width: 220px;
}
.use {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}
.use + .use {
  margin-top: 4px;
}
.use-panel {
  font-weight: 500;
}
.ops {
  display: flex;
  justify-content: flex-end;
  gap: 14px;
}
.note {
  margin: 0;
  padding: 10px 16px 12px;
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
code {
  font-size: 12px;
}
</style>
