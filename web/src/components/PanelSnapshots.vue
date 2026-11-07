<script setup lang="ts">
// 面板配置快照:每小时自动存一份(配置有变化才存)。面板重装或配置被误删后,按某一份把缺的入站、client 补回去,
// Xray 配置(路由、出站)可一并换回。只补缺的,不删、不改面板上现有的。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { fmtAgo, fmtDateTime } from '../format';
import { toast, toastError } from '../toast';
import type { PanelSnapshot, RestorePlan, RestoreStep } from '../types';
import Modal from './Modal.vue';

const props = defineProps<{ panelId: number; panelName: string }>();
const emit = defineEmits<{ restored: [] }>();

const PROTOCOL: Record<string, string> = { hysteria: 'hysteria2', mixed: 'socks' };

const rows = ref<PanelSnapshot[] | null>(null);
const keep = ref({ days: 7, latest: 10 });
const error = ref('');
const taking = ref(false);

async function load() {
  error.value = '';
  try {
    const res = await api.panelSnapshots(props.panelId);
    rows.value = res.rows;
    keep.value = { days: res.keep_days, latest: res.keep_latest };
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

async function takeNow() {
  taking.value = true;
  try {
    const { stored } = await api.takeSnapshot(props.panelId);
    toast(stored ? '已存一份' : '面板配置和最新一份一样，不用另存');
    if (stored) await load();
  } catch (e) {
    toastError(e);
  } finally {
    taking.value = false;
  }
}

// ---------- 恢复 ----------
const restoring = ref<PanelSnapshot | null>(null);
const plan = ref<RestorePlan | null>(null);
const planError = ref('');
const withXray = ref(true);
const running = ref(false);
const steps = ref<RestoreStep[] | null>(null);

async function openRestore(s: PanelSnapshot) {
  restoring.value = s;
  plan.value = null;
  planError.value = '';
  steps.value = null;
  try {
    plan.value = await api.restorePlan(props.panelId, s.id);
    // 快照里的入站面板上一个都没有(多半是重装了)才默认换回 Xray 配置;
    // 否则面板上的路由、出站可能是快照之后新改的,由人决定要不要换
    withXray.value = !plan.value.xray.same && plan.value.inbounds.every((i) => i.action === 'add');
  } catch (e) {
    planError.value = e instanceof Error ? e.message : String(e);
  }
}

const parts = computed(() => {
  const p = plan.value;
  if (!p) return null;
  return {
    addInbounds: p.inbounds.filter((i) => i.action === 'add'),
    hasInbounds: p.inbounds.filter((i) => i.action === 'exists').length,
    addClients: p.clients.filter((c) => c.action === 'add'),
    attach: p.clients.filter((c) => c.action === 'attach'),
    hasClients: p.clients.filter((c) => c.action === 'exists').length,
    skip: p.clients.filter((c) => c.action === 'skip'),
  };
});

const nothingToDo = computed(() => {
  const p = parts.value;
  return !!p && !p.addInbounds.length && !p.addClients.length && !p.attach.length && !(withXray.value && !plan.value!.xray.same);
});

async function runRestore() {
  if (!restoring.value) return;
  running.value = true;
  try {
    steps.value = (await api.restoreSnapshot(props.panelId, restoring.value.id, withXray.value)).steps;
    emit('restored');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    running.value = false;
  }
}

const failed = computed(() => steps.value?.filter((s) => !s.ok).length ?? 0);
</script>

<template>
  <section class="snapshots">
    <div class="title">
      <h3>配置快照</h3>
      <span class="muted small">每小时检查一次，配置有变化才存一份；保留 {{ keep.days }} 天，每台至少留最近 {{ keep.latest }} 份</span>
      <span class="spacer" />
      <button :disabled="taking" @click="takeNow">{{ taking ? '读取中…' : '立即存一份' }}</button>
    </div>
    <div v-if="error" class="notice small">
      读取快照失败：{{ error }}
      <button class="link" @click="load">重试</button>
    </div>
    <p v-else-if="rows && !rows.length" class="muted small none">还没有快照：服务启动时和之后每小时会存，面板连不上或还没有入站时不存。</p>
    <div v-else-if="rows" class="table-wrap">
      <table class="small">
        <thead>
          <tr>
            <th>存于</th>
            <th class="num">入站</th>
            <th class="num">client</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in rows" :key="s.id">
            <td>
              {{ fmtDateTime(s.taken_at) }} <span class="muted">{{ fmtAgo(s.taken_at) }}</span>
              <span v-if="i === 0" class="chip">最新</span>
            </td>
            <td class="num">{{ s.inbounds }}</td>
            <td class="num">{{ s.clients }}</td>
            <td class="num"><button class="link" @click="openRestore(s)">恢复…</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <Modal v-if="restoring" :title="`按快照恢复「${panelName}」`" @close="restoring = null">
    <p class="small muted lead">快照存于 {{ fmtDateTime(restoring.taken_at) }}（{{ fmtAgo(restoring.taken_at) }}）</p>

    <template v-if="steps">
      <p :class="failed ? 'text-err' : 'text-ok'">
        {{ failed ? `有 ${failed} 步没成功，见下面` : steps.length ? '恢复完成' : '没有要做的' }}
      </p>
      <ul class="steps small">
        <li v-for="(s, i) in steps" :key="i" :class="{ 'text-err': !s.ok }">
          {{ s.ok ? '✓' : '✗' }} {{ s.what }}<template v-if="s.error">：{{ s.error }}</template>
        </li>
      </ul>
      <p class="small muted">client 的流量从 0 开始计，本系统会照常累计；客户订阅现取链接，不用更新。</p>
    </template>
    <div v-else-if="planError" class="notice">
      读不到面板现状：{{ planError }}<br />
      面板重装后，先在「面板」页把它的地址和 API token 改成新的。
    </div>
    <div v-else-if="!plan || !parts" class="empty">正在读面板现状、对比快照…</div>
    <div v-else class="plan">
      <p class="small muted">只补面板上缺的，现有的入站和 client 不删、不改。恢复前会先给面板现在的配置存一份快照。</p>
      <div v-for="w in plan.warnings" :key="w" class="notice small">{{ w }}</div>

      <h4>入站</h4>
      <p v-if="parts.addInbounds.length" class="small">
        新建 <span class="figure">{{ parts.addInbounds.length }}</span> 个：
        <span v-for="i in parts.addInbounds" :key="`${i.port}/${i.protocol}`" class="chip">{{ i.remark }} · {{ PROTOCOL[i.protocol] ?? i.protocol }} {{ i.port }}</span>
      </p>
      <p v-if="parts.hasInbounds" class="small muted">{{ parts.hasInbounds }} 个面板上已有</p>

      <h4>client</h4>
      <p v-if="parts.addClients.length" class="small">
        新建 <span class="figure">{{ parts.addClients.length }}</span> 个：<span class="muted">{{ parts.addClients.map((c) => c.email).join('、') }}</span>
      </p>
      <p v-for="c in parts.attach" :key="c.email" class="small">{{ c.email }} 补挂到 {{ c.inbounds.join('、') }}</p>
      <p v-if="parts.skip.length" class="small muted">跳过 {{ parts.skip.map((c) => c.email).join('、') }}：快照里就没挂在任何入站上</p>
      <p v-if="parts.hasClients" class="small muted">{{ parts.hasClients }} 个面板上已有</p>

      <h4>Xray 配置（路由、出站）</h4>
      <p v-if="plan.xray.same" class="small muted">和快照一样，不用动</p>
      <label v-else class="row small xray">
        <input v-model="withXray" type="checkbox" />
        <span>
          换成快照里的，然后重启 Xray（现在出站 {{ plan.xray.current.outbounds }} 个、规则 {{ plan.xray.current.rules }} 条 → 快照里出站
          {{ plan.xray.snapshot.outbounds }} 个、规则 {{ plan.xray.snapshot.rules }} 条）
        </span>
      </label>
      <p v-if="!plan.xray.same" class="small muted">是整份替换：快照之后在面板上新改的路由、出站会丢掉。面板重装过才需要换。</p>
    </div>

    <template #footer>
      <span class="spacer" />
      <template v-if="steps">
        <button class="primary" @click="restoring = null">关闭</button>
      </template>
      <template v-else>
        <button @click="restoring = null">取消</button>
        <button class="primary" :disabled="!plan || nothingToDo || running" @click="runRestore">
          {{ running ? '恢复中…' : nothingToDo ? '不用恢复' : '恢复' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.snapshots {
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
}
.title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
  margin-bottom: 8px;
}
.title .spacer {
  flex: 1;
}
h3 {
  font-size: 14px;
  font-weight: 600;
}
h4 {
  font-size: 13px;
  font-weight: 600;
  margin: 14px 0 4px;
}
.none {
  margin: 0;
}
.snapshots th,
.snapshots td {
  padding: 6px 10px;
}
.lead {
  margin: 0 0 10px;
}
.plan p {
  margin: 0 0 4px;
}
.plan .chip {
  margin: 2px 4px 2px 0;
}
.plan .notice {
  margin: 8px 0;
}
.xray {
  align-items: flex-start;
  flex-wrap: nowrap;
}
.xray input {
  margin-top: 2px;
  flex: none;
}
.steps {
  margin: 8px 0;
  padding-left: 0;
  list-style: none;
  line-height: 1.8;
}
</style>
