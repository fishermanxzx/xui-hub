<script setup lang="ts">
// 卸载 SOCKS:先现读各面板列出会删的出站、路由、入站和客户线路,确认后执行。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import type { Socks, SocksUninstallPlan, SocksUninstallResult } from '../types';
import Modal from './Modal.vue';

const props = defineProps<{ socks: Socks }>();
const emit = defineEmits<{ close: []; done: [] }>();

const plan = ref<SocksUninstallPlan | null>(null);
const error = ref('');
const running = ref(false);
const result = ref<SocksUninstallResult | null>(null);

onMounted(async () => {
  try {
    plan.value = await api.socksUninstallPlan(props.socks.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});

const todo = computed(() => plan.value?.panels.filter((p) => !p.blocked) ?? []);
const blocked = computed(() => plan.value?.panels.filter((p) => p.blocked) ?? []);
const totals = computed(() => ({
  inbounds: todo.value.reduce((n, p) => n + p.inbounds.length, 0),
  clients: todo.value.reduce((n, p) => n + p.clients.length, 0),
  customers: todo.value.reduce((n, p) => n + p.clients.filter((c) => c.customer).length, 0),
}));
const fullyRemovable = computed(() => plan.value && !plan.value.errors.length && !blocked.value.length);

const waiting = ref(false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 请求断了时服务端多半还在做:每 3 秒查一次进度,最多等 3 分钟 */
async function waitForResult(): Promise<SocksUninstallResult | null> {
  waiting.value = true;
  try {
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const s = await api.socksUninstallStatus(props.socks.id).catch(() => null);
      if (s && !s.running) return s.result;
    }
    return null;
  } finally {
    waiting.value = false;
  }
}

async function run() {
  running.value = true;
  error.value = '';
  try {
    result.value = await api.uninstallSocks(props.socks.id);
    emit('done');
  } catch (e) {
    const done = await waitForResult();
    if (done) {
      result.value = done;
      emit('done');
    } else {
      error.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <Modal :title="`卸载 SOCKS「${socks.name}」`" wide @close="emit('close')">
    <div v-if="error" class="notice">{{ error }}</div>

    <template v-if="result">
      <p :class="result.removed ? 'text-ok' : 'text-err'">
        {{ result.removed ? '已卸载，并从系统移除。' : '有面板没处理好，SOCKS 先保留登记；处理好后再点一次卸载，已改好的面板会跳过。' }}
      </p>
      <section v-for="p in result.panels" :key="p.panel" class="group">
        <h4>{{ p.panel }}</h4>
        <ul class="steps small">
          <li v-for="(s, i) in p.steps" :key="i" :class="{ 'text-err': !s.ok }">
            {{ s.ok ? '✓' : '✗' }} {{ s.what }}<template v-if="s.error">：{{ s.error }}</template>
          </li>
        </ul>
      </section>
      <ul v-if="result.errors.length" class="small steps">
        <li v-for="e in result.errors" :key="e.panel" class="text-err">✗ {{ e.panel }}：{{ e.error }}</li>
      </ul>
    </template>

    <div v-else-if="!plan && !error" class="empty">正在读各面板的配置…</div>

    <template v-else-if="plan">
      <p v-if="!plan.panels.length && !plan.errors.length" class="small">没有面板在用它，卸载只会把它从系统移除。</p>
      <template v-if="todo.length">
        <p class="small">卸载会在下面 {{ todo.length }} 台面板上：</p>
        <ol class="small numbered">
          <li>先存一份配置快照（出问题可以在面板详情里按快照恢复）；</li>
          <li v-if="totals.clients">
            删除只挂在这些入站上的 {{ totals.clients }} 个 client<template v-if="totals.customers">，其中 {{ totals.customers }} 条是客户线路，会从客户那里解绑</template>；
          </li>
          <li v-if="totals.inbounds">删除整个走它的 {{ totals.inbounds }} 个入站（还挂在别的入站上的 client 不删，只是少了这个入站）；</li>
          <li>
            删除指向它的出站和路由规则（只分流部分流量的规则只删规则，入站不动），然后重启 Xray，这台面板会断流几秒。
            你自己的代理如果也走这些面板，页面会断开一下，卸载照样在服务端做完，这里会自动等结果。
          </li>
        </ol>
        <section v-for="p in todo" :key="p.panel_id" class="group">
          <h4>
            {{ p.panel }}
            <span class="muted">出站 {{ p.outbounds.join('、') }} · {{ p.rules }} 条规则</span>
          </h4>
          <div v-if="p.inbounds.length || p.clients.length" class="chips">
            <span v-for="i in p.inbounds" :key="'i' + i.id" class="chip">入站 <b>{{ i.remark || i.protocol }}</b><span class="muted">{{ i.protocol }}:{{ i.port }}</span></span>
            <span v-for="c in p.clients" :key="'c' + c.email" class="chip">
              <b>{{ c.customer?.name ?? '未绑定' }}</b><span class="muted">{{ c.email }}</span>
            </span>
          </div>
          <p v-else class="small muted">没有整个走它的入站，只删规则和出站。</p>
        </section>
      </template>

      <section v-if="blocked.length" class="group">
        <h4 class="text-err">这些面板不会自动处理，先去面板上调整</h4>
        <ul class="small steps">
          <li v-for="p in blocked" :key="p.panel_id">{{ p.panel }}：{{ p.blocked }}</li>
        </ul>
      </section>
      <section v-if="plan.errors.length" class="group">
        <h4 class="text-err">读不到配置的面板（会跳过）</h4>
        <ul class="small steps">
          <li v-for="e in plan.errors" :key="e.panel">{{ e.panel }}：{{ e.error }}</li>
        </ul>
      </section>
      <section v-if="plan.indirect.length" class="group">
        <h4>出口也经过它、这次不删的客户线路（{{ plan.indirect.length }}）</h4>
        <div class="chips">
          <span v-for="l in plan.indirect" :key="l.panel + l.email" class="chip">
            <b>{{ l.customer_name }}</b><span class="muted">{{ l.panel }} · {{ l.email }}</span>
          </span>
        </div>
      </section>
      <p v-if="!fullyRemovable" class="small muted">有面板没处理，卸载后 SOCKS 会保留登记，处理好再卸载一次。</p>
    </template>

    <template #footer>
      <span class="spacer" />
      <template v-if="result">
        <button class="primary" @click="emit('close')">关闭</button>
      </template>
      <template v-else>
        <button @click="emit('close')">取消</button>
        <button class="danger-btn" :disabled="!plan || running" @click="run">
          {{ waiting ? '连接断了，等服务端做完…' : running ? '卸载中…' : todo.length ? `改 ${todo.length} 台面板并卸载` : '卸载' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.numbered {
  margin: 4px 0 12px;
  padding-left: 20px;
  line-height: 1.7;
}
.steps {
  margin: 4px 0;
  padding-left: 0;
  list-style: none;
  line-height: 1.8;
}
.group {
  margin-top: 12px;
}
h4 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
}
h4 .muted {
  font-weight: 400;
  margin-left: 6px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip b {
  font-weight: 500;
}
.danger-btn {
  background: var(--fault);
  border-color: var(--fault);
  color: #fff;
}
.danger-btn:hover:not(:disabled) {
  background: var(--fault);
  opacity: 0.9;
}
</style>
