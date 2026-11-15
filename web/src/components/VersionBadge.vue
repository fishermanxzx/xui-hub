<script setup lang="ts">
// 顶栏里的版本号:显示当前版本,发现新版本时变成醒目的提示;点开看详情、在后台里直接更新(一键脚本装的)或看要执行的命令(Docker)。
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { copyText } from '../clipboard';
import { fmtAgo } from '../format';
import { toast, toastError } from '../toast';
import type { UpdateInfo } from '../types';
import Modal from './Modal.vue';

const info = ref<UpdateInfo | null>(null);
const open = ref(false);
const checking = ref(false);
/** 点了更新之后:等服务换成新版本 */
const waiting = ref(false);
const waitNote = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;

async function load(refresh = false) {
  try {
    info.value = await api.systemVersion(refresh);
  } catch {
    // 查不到版本不影响用后台,不打扰
  }
}
async function recheck() {
  checking.value = true;
  try {
    info.value = await api.systemVersion(true);
    if (info.value.error) toast(`检查更新失败:${info.value.error}`, 'err');
    else toast(info.value.update_available ? `发现新版本 v${info.value.latest}` : '已经是最新版本');
  } catch (e) {
    toastError(e);
  } finally {
    checking.value = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function update() {
  const i = info.value;
  if (!i?.latest) return;
  if (!confirm(`把 xui-hub 从 v${i.current} 更新到 v${i.latest}?更新时后台会重启,大约一分钟打不开;客户的节点不受影响,订阅链接在重启的几秒里拉不到。`)) return;
  const from = i.current;
  waiting.value = true;
  waitNote.value = '已开始更新,正在下载新版本…';
  try {
    await api.systemUpdate();
    // 更新中服务会重启:请求失败是正常的,一直问到版本变了、报失败,或者等太久
    for (let n = 0; n < 100 && !stopped; n++) {
      await sleep(3000);
      const now = await api.systemVersion().catch(() => null);
      if (!now) {
        waitNote.value = '服务正在重启…';
        continue;
      }
      info.value = now;
      if (now.current !== from) {
        toast(`已更新到 v${now.current},页面即将刷新`);
        await sleep(1200);
        location.reload();
        return;
      }
      if (now.state === 'failed') {
        waitNote.value = '';
        toast('更新没有成功,原来的版本还在运行', 'err');
        return;
      }
    }
    toast('等了 5 分钟版本还没变,去服务器上看一下:xui-hub status', 'err');
  } catch (e) {
    toastError(e);
  } finally {
    waiting.value = false;
  }
}

const busy = computed(() => waiting.value || info.value?.state === 'running');

onMounted(() => {
  void load();
  // 开着页面不动也每 6 小时看一次
  timer = setInterval(() => void load(), 6 * 3_600_000);
});
onUnmounted(() => {
  stopped = true;
  clearInterval(timer);
});
</script>

<template>
  <button v-if="info" class="version" :class="{ fresh: info.update_available }" :title="info.update_available ? `有新版本 v${info.latest},点开更新` : '当前版本,点开检查更新'" @click="open = true">
    v{{ info.current }}<span v-if="info.update_available" class="new">有新版本 v{{ info.latest }}</span>
  </button>

  <Modal v-if="open && info" title="xui-hub 版本" @close="open = false">
    <dl class="facts">
      <dt>当前版本</dt>
      <dd>v{{ info.current }}</dd>
      <dt>最新版本</dt>
      <dd>
        <template v-if="info.latest">v{{ info.latest }}<span v-if="!info.update_available" class="muted">(已是最新)</span></template>
        <span v-else class="muted">还没查到</span>
      </dd>
      <dt>上次检查</dt>
      <dd class="muted">{{ info.checked_at ? fmtAgo(info.checked_at) : '—' }}<template v-if="info.error">,失败:{{ info.error }}</template></dd>
    </dl>

    <template v-if="info.update_available">
      <p v-if="info.method === 'auto'" class="small">点「立即更新」会在这台服务器上执行一次 <code>xui-hub update</code>:下载新版本、换掉程序、重启服务。新版本起不来会自动退回现在的版本。数据不动。</p>
      <template v-else>
        <p class="small">{{ info.method === 'docker' ? 'Docker 部署换不了自己的镜像,在服务器的 xui-hub 目录里执行:' : '这台机器上还没有装后台更新用的服务,在服务器上执行一次(之后就能在这里直接点更新):' }}</p>
        <p class="cmd"><code>{{ info.command }}</code><button class="link" @click="copyText(info.command, '命令')">复制</button></p>
      </template>
    </template>
    <p v-if="waitNote" class="small note">{{ waitNote }}</p>
    <template v-if="info.state === 'failed' && !waiting">
      <p class="small text-err">上次在后台里更新没有成功,脚本最后的输出:</p>
      <pre class="log">{{ info.log }}</pre>
    </template>

    <template #footer>
      <a class="link small" :href="info.release_url" target="_blank" rel="noopener noreferrer">更新记录</a>
      <span class="spacer" />
      <button :disabled="checking || busy" @click="recheck">{{ checking ? '检查中…' : '检查更新' }}</button>
      <button v-if="info.update_available && info.method === 'auto'" class="primary" :disabled="busy" @click="update">{{ busy ? '更新中…' : '立即更新' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.version {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: none;
  box-shadow: none;
  color: var(--ink-soft);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.version:hover {
  border-color: var(--rule);
}
.version.fresh {
  border-color: var(--accent);
  color: var(--ink);
}
.new {
  color: var(--accent-strong);
  font-weight: 600;
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px 20px;
  margin: 0 0 14px;
}
.facts dt {
  color: var(--ink-soft);
}
.facts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.facts dd .muted {
  margin-left: 6px;
}
.cmd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--hover);
  overflow-x: auto;
}
.cmd code {
  flex: 1;
  white-space: nowrap;
}
.note {
  color: var(--accent-strong);
}
.log {
  max-height: 220px;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--hover);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
@media (max-width: 640px) {
  .new {
    display: none;
  }
  .version.fresh::after {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
}
</style>
