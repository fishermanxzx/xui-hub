<script setup lang="ts">
// 设置页:通知渠道(Telegram / Webhook)和提醒项、数据备份与恢复。
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { toast, toastError } from '../toast';
import { copyText } from '../clipboard';
import { fmtAgo } from '../format';
import type { ApiToken, Settings } from '../types';

const s = ref<Settings | null>(null);
const saving = ref(false);
const testing = ref(false);

async function load() {
  try {
    s.value = await api.settings();
  } catch (e) {
    toastError(e);
  }
}
onMounted(load);

// ---------- API 令牌 ----------
const tokens = ref<ApiToken[]>([]);
const tokenName = ref('');
/** 刚建好的令牌(明文只有这一次) */
const fresh = ref<ApiToken | null>(null);
const origin = window.location.origin;

async function loadTokens() {
  try {
    tokens.value = await api.tokens();
  } catch (e) {
    toastError(e);
  }
}
onMounted(loadTokens);

async function addToken() {
  try {
    fresh.value = await api.createToken(tokenName.value);
    tokenName.value = '';
    await loadTokens();
  } catch (e) {
    toastError(e);
  }
}

async function removeToken(t: ApiToken) {
  if (!confirm(`删除令牌「${t.name}」?用它的程序会立刻调不通。`)) return;
  try {
    await api.deleteToken(t.id);
    if (fresh.value?.id === t.id) fresh.value = null;
    await loadTokens();
  } catch (e) {
    toastError(e);
  }
}

async function save(): Promise<boolean> {
  if (!s.value) return false;
  saving.value = true;
  try {
    s.value = await api.updateSettings(s.value);
    toast('已保存');
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    saving.value = false;
  }
}

/** 先保存再用保存好的渠道发测试消息 */
async function test() {
  if (!(await save())) return;
  testing.value = true;
  try {
    const { results } = await api.testNotify();
    const bad = results.filter((r) => !r.ok);
    toast(bad.length ? `发送失败:${bad.map((r) => `${r.channel}(${r.error})`).join('、')}` : `已发送到 ${results.map((r) => r.channel).join('、')},去看看收到没有`, bad.length ? 'err' : 'ok');
  } catch (e) {
    toastError(e);
  } finally {
    testing.value = false;
  }
}

// ---------- 恢复 ----------
const fileInput = ref<HTMLInputElement | null>(null);
const restoring = ref(false);
const restored = ref<{ panels: number; customers: number; lines: number } | null>(null);

async function restore() {
  const file = fileInput.value?.files?.[0];
  if (!file) return;
  if (!confirm(`用「${file.name}」整个替换当前数据库?现在的面板、客户、线路、设置都会变成备份里的内容(旧库会在数据目录里留一份)。恢复后服务会重启,需要重新登录。`)) return;
  restoring.value = true;
  try {
    const info = await api.restore(file);
    restored.value = info;
    toast(info.restarting ? '备份已上传,服务正在重启…' : '备份已放好,重启服务后生效');
  } catch (e) {
    toastError(e);
  } finally {
    restoring.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>设置</h2>
      <p class="muted small">通知和备份。后台密码、端口、HTTPS 这些在服务器上改(一键脚本用 <code>xui-hub</code> 命令,Docker 改 <code>.env</code>)。</p>
    </div>
  </div>

  <template v-if="s">
    <section class="sheet block">
      <h3>通知渠道</h3>
      <p class="muted small">面板掉线、客户被停用、快到期这些事发到这里。两种渠道都可以不填,只在后台和日志里看。</p>
      <div class="grid">
        <label class="field">
          Telegram Bot token
          <input v-model="s.telegram.token" placeholder="在 @BotFather 创建机器人得到,形如 123456:ABC-DEF…" autocomplete="off" />
        </label>
        <label class="field">
          Telegram Chat ID
          <input v-model="s.telegram.chat_id" placeholder="给机器人发条消息后,从 @userinfobot 之类的工具拿到;群组是负数" autocomplete="off" />
        </label>
      </div>
      <label class="field">
        Webhook 地址
        <input v-model="s.webhook.url" placeholder="https://… 每条通知 POST 一份 JSON:{ event, title, text, at }" autocomplete="off" />
      </label>
      <p class="muted small">服务器要能访问 api.telegram.org。</p>
    </section>

    <section class="sheet block">
      <h3>提醒哪些事</h3>
      <div class="checks">
        <label class="row small"><input v-model="s.notify.panel_down" type="checkbox" />面板连不上 / 恢复</label>
        <label class="row small"><input v-model="s.notify.customer_disabled" type="checkbox" />客户超额 / 到期被停用,以及恢复</label>
        <label class="row small"><input v-model="s.notify.expiring" type="checkbox" />客户快到期:提前 <input v-model.number="s.notify.expiring_days" type="number" min="1" max="30" class="num" /> 天提醒一次</label>
        <label class="row small"><input v-model="s.notify.quota_warn" type="checkbox" />客户流量用到额度的 <input v-model.number="s.notify.quota_warn_pct" type="number" min="50" max="99" class="num" /> % 时提醒一次</label>
        <label class="row small"><input v-model="s.notify.monthly_reset" type="checkbox" />按月清零完成</label>
        <label class="row small"><input v-model="s.notify.sub_share" type="checkbox" />订阅疑似被分享:24 小时内从 <input v-model.number="s.notify.sub_share_ips" type="number" min="2" max="50" class="num" /> 个以上不同 IP 拉取(每位客户每天最多提醒一次,客户卡片上也会标出来)</label>
      </div>
      <div class="row actions">
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        <button :disabled="saving || testing" @click="test">{{ testing ? '发送中…' : '保存并发一条测试通知' }}</button>
      </div>
    </section>

    <section class="sheet block">
      <h3>开放 API</h3>
      <p class="muted small">给发卡站、机器人这类程序用:请求头带 <code>Authorization: Bearer 令牌</code> 就能调后台的接口(建客户、续期、开线路、取订阅链接)。令牌改不了这页的设置,也碰不了备份恢复。接口说明见仓库的 <code>docs/api.md</code>。</p>
      <form class="row actions" @submit.prevent="addToken">
        <input v-model="tokenName" required maxlength="64" placeholder="令牌用在哪儿,如:发卡站" class="grow" />
        <button class="primary">生成令牌</button>
      </form>
      <div v-if="fresh" class="fresh">
        <p class="small"><strong>「{{ fresh.name }}」的令牌,只显示这一次,现在就复制保存:</strong></p>
        <div class="row">
          <input readonly :value="fresh.token" class="grow mono" @focus="($event.target as HTMLInputElement).select()" />
          <button type="button" @click="copyText(fresh.token ?? '', '令牌已复制')">复制</button>
        </div>
        <p class="muted small">试一下:<code>curl -H "Authorization: Bearer {{ fresh.token }}" {{ origin }}/api/customers</code></p>
      </div>
      <table v-if="tokens.length" class="tokens">
        <thead><tr><th>名称</th><th>令牌</th><th>创建</th><th>上次使用</th><th></th></tr></thead>
        <tbody>
          <tr v-for="t in tokens" :key="t.id">
            <td>{{ t.name }}</td>
            <td class="mono muted">xh_…{{ t.hint }}</td>
            <td class="muted small">{{ fmtAgo(t.created_at) }}</td>
            <td class="muted small">{{ t.last_used_at ? fmtAgo(t.last_used_at) : '还没用过' }}</td>
            <td><button type="button" class="link danger" @click="removeToken(t)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="sheet block">
      <h3>备份与恢复</h3>
      <p class="muted small">整个后台的数据(面板、客户、线路、订阅链接、设置)都在一个数据库文件里;面板上的客户端不在里面,它们本来就在面板上。</p>
      <div class="row actions">
        <a class="btn" :href="api.backupUrl" download>下载备份</a>
        <label class="row small"><input v-model="s.backup.daily" type="checkbox" @change="save" />每天把备份发到上面的 Telegram</label>
      </div>
      <div class="restore">
        <span class="label">恢复</span>
        <div class="row">
          <input ref="fileInput" type="file" accept=".db,application/octet-stream" :disabled="restoring" @change="restore" />
          <span class="muted small">选一个之前下载的 .db 文件,会整个替换当前数据,然后服务自动重启。</span>
        </div>
        <p v-if="restored" class="small text-ok">备份里有 {{ restored.panels }} 块面板、{{ restored.customers }} 位客户、{{ restored.lines }} 条线路。等几秒刷新页面重新登录。</p>
      </div>
    </section>
  </template>
</template>

<style scoped>
.toolbar {
  margin-bottom: 16px;
}
h2 {
  font-size: 18px;
}
h3 {
  font-size: 15px;
  margin: 0 0 4px;
}
.toolbar p {
  margin: 4px 0 0;
  max-width: 64ch;
}
code {
  font-size: 12px;
  background: var(--hover);
  padding: 1px 5px;
  border-radius: 4px;
}
.block {
  padding: 16px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.block p {
  margin: 0;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.num {
  width: 64px;
  padding: 2px 6px;
  margin: 0 4px;
}
.actions {
  gap: 16px;
  flex-wrap: wrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  padding: 7px 14px;
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--sheet);
  color: var(--ink);
  text-decoration: none;
  font-weight: 500;
}
.btn:hover {
  background: var(--hover);
}
.grow {
  flex: 1;
  min-width: 0;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.fresh {
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fresh .row {
  gap: 8px;
}
.fresh code {
  word-break: break-all;
}
.tokens {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tokens th,
.tokens td {
  text-align: left;
  padding: 6px 8px;
  border-top: 1px solid var(--rule);
}
.tokens th {
  font-weight: 500;
  font-size: 12px;
  color: var(--ink-soft);
  border-top: 0;
}
.restore .label {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-bottom: 6px;
}
.restore .row {
  gap: 12px;
  flex-wrap: wrap;
}
@media (max-width: 640px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
