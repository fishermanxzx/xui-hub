<script setup lang="ts">
// 设置页:通知渠道(Telegram / Webhook)和提醒项、数据备份与恢复。
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { toast, toastError } from '../toast';
import type { Settings } from '../types';

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
      </div>
      <div class="row actions">
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        <button :disabled="saving || testing" @click="test">{{ testing ? '发送中…' : '保存并发一条测试通知' }}</button>
      </div>
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
