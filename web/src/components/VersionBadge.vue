<script setup lang="ts">
// 顶栏里的版本号:显示当前版本,发现新版本时变成醒目的提示;点开看详情、在后台里直接更新(一键脚本装的)或看要执行的命令(Docker)。
import { t } from '../i18n';
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
    if (info.value.error) toast(t('version.checkFailed', { error: info.value.error }), 'err');
    else toast(info.value.update_available ? t('version.found', { v: info.value.latest }) : t('version.upToDate'));
  } catch (e) {
    toastError(e);
  } finally {
    checking.value = false;
  }
}

/** 从源码直接跑的没有版本号,不写成「vdev」 */
const label = (v: string) => (/^\d/.test(v) ? `v${v}` : t('version.dev'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function update() {
  const i = info.value;
  if (!i?.latest) return;
  if (!confirm(t('version.confirm', { from: label(i.current), to: i.latest }))) return;
  const from = i.current;
  waiting.value = true;
  waitNote.value = t('version.started');
  try {
    await api.systemUpdate();
    // 更新中服务会重启:请求失败是正常的,一直问到版本变了、报失败,或者等太久
    for (let n = 0; n < 100 && !stopped; n++) {
      await sleep(3000);
      const now = await api.systemVersion().catch(() => null);
      if (!now) {
        waitNote.value = t('version.restarting');
        continue;
      }
      info.value = now;
      if (now.current !== from) {
        toast(t('version.done', { v: now.current }));
        await sleep(1200);
        location.reload();
        return;
      }
      if (now.state === 'failed') {
        waitNote.value = '';
        toast(t('version.failed'), 'err');
        return;
      }
    }
    toast(t('version.timeout'), 'err');
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
  <button v-if="info" class="version" :class="{ fresh: info.update_available }" :title="info.update_available ? t('version.badgeNew', { v: info.latest }) : t('version.badgeCurrent')" @click="open = true">
    {{ label(info.current) }}<span v-if="info.update_available" class="new">{{ t('version.newVersion', { v: info.latest }) }}</span>
  </button>

  <Modal v-if="open && info" :title="t('version.title')" @close="open = false">
    <dl class="facts">
      <dt>{{ t('version.current') }}</dt>
      <dd>{{ label(info.current) }}</dd>
      <dt>{{ t('version.latest') }}</dt>
      <dd>
        <template v-if="info.latest">v{{ info.latest }}<span v-if="!info.update_available" class="muted">{{ t('version.isLatest') }}</span></template>
        <span v-else class="muted">{{ t('version.unknown') }}</span>
      </dd>
      <dt>{{ t('version.lastCheck') }}</dt>
      <dd class="muted">{{ info.checked_at ? fmtAgo(info.checked_at) : '—' }}<template v-if="info.error">{{ t('version.lastCheckFailed', { error: info.error }) }}</template></dd>
    </dl>

    <template v-if="info.update_available">
      <p v-if="info.method === 'auto'" class="small">{{ t('version.autoHint') }}</p>
      <template v-else>
        <p class="small">{{ info.method === 'docker' ? t('version.dockerHint') : t('version.manualHint') }}</p>
        <p class="cmd"><code>{{ info.command }}</code><button class="link" @click="copyText(info.command, t('version.command'))">{{ t('common.copy') }}</button></p>
      </template>
    </template>
    <p v-if="waitNote" class="small note">{{ waitNote }}</p>
    <template v-if="info.state === 'failed' && !waiting">
      <p class="small text-err">{{ t('version.lastFailed') }}</p>
      <pre class="log">{{ info.log }}</pre>
    </template>

    <template #footer>
      <a class="link small" :href="info.release_url" target="_blank" rel="noopener noreferrer">{{ t('version.releases') }}</a>
      <span class="spacer" />
      <button :disabled="checking || busy" @click="recheck">{{ checking ? t('version.checking') : t('version.check') }}</button>
      <button v-if="info.update_available && info.method === 'auto'" class="primary" :disabled="busy" @click="update">{{ busy ? t('version.updating') : t('version.update') }}</button>
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
