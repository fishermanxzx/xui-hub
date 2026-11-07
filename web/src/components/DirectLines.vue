<script setup lang="ts">
// 落地机开直连:列出出口经过这台落地的客户,勾选后在落地上直接给他们开线路(客户端直连落地,不走中转)。
// 协议可选 vless / hy2;落地上已有这个协议、直出的入站就复用,没有就新建一个。已有别的协议 client 的客户挂过去,不另建。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { STATE_LABEL } from '../format';
import type { DirectPlan, DirectProtocol, DirectResult } from '../types';
import Modal from './Modal.vue';

const props = defineProps<{ panelId: number }>();
const emit = defineEmits<{ close: []; done: [] }>();

const PROTOCOLS: { key: DirectProtocol; label: string }[] = [
  { key: 'vless', label: 'vless' },
  { key: 'hysteria', label: 'hy2' },
];
const protocol = ref<DirectProtocol>('vless');
const protoLabel = computed(() => PROTOCOLS.find((p) => p.key === protocol.value)!.label);
const plan = ref<DirectPlan | null>(null);
const error = ref('');
const picked = ref<number[]>([]);
const busy = ref(false);
const result = ref<{ created: string | null; results: DirectResult[] } | null>(null);

async function load() {
  error.value = '';
  plan.value = null;
  try {
    plan.value = await api.directPlan(props.panelId, protocol.value);
    // 默认勾上还没有这台落地线路、状态正常的客户
    picked.value = plan.value.customers.filter((c) => !c.existing && c.state === 'active').map((c) => c.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

function switchProtocol(p: DirectProtocol) {
  if (p === protocol.value || busy.value) return;
  protocol.value = p;
  load();
}

const canOpen = computed(() => plan.value && !plan.value.error && (plan.value.inbound || plan.value.create));
const count = computed(() => picked.value.length);
const failed = computed(() => result.value?.results.filter((r) => !r.ok) ?? []);

function toggle(id: number) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id];
}

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    result.value = await api.openDirect(props.panelId, picked.value, protocol.value);
    emit('done');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="plan ? `开通直连：${plan.panel.name}（${plan.panel.ip}）` : '开通直连'" wide @close="emit('close')">
    <div v-if="error" class="notice">
      {{ error }}
      <button v-if="!plan" class="link" @click="load">重新读取</button>
    </div>
    <div v-if="!plan && !error" class="empty">正在读取这台落地…</div>

    <template v-if="result">
      <p :class="failed.length ? 'text-err' : 'text-ok'">
        已开通 {{ result.results.filter((r) => r.ok).length }} 条 {{ protoLabel }} 直连<template v-if="result.created">，新建了入站 {{ result.created }}</template>。客户刷新订阅就能看到。
      </p>
      <ul class="small steps">
        <li v-for="r in result.results" :key="r.customer" :class="{ 'text-err': !r.ok }">
          {{ r.ok ? '✓' : '✗' }} {{ r.customer }}<template v-if="r.email">（{{ r.email }}{{ r.attached ? '，挂到现有 client' : '' }}）</template><template v-if="r.error">：{{ r.error }}</template>
        </li>
      </ul>
    </template>

    <template v-else>
      <div class="proto" role="radiogroup" aria-label="协议">
        <button
          v-for="p in PROTOCOLS"
          :key="p.key"
          role="radio"
          :aria-checked="protocol === p.key"
          :class="{ on: protocol === p.key }"
          @click="switchProtocol(p.key)"
        >
          {{ p.label }}
        </button>
      </div>
    </template>

    <template v-if="!result && plan">
      <p class="hint muted small">
        给出口经过这台落地的客户，在落地上直接开一条 {{ protoLabel }} 线路：客户端直连落地，不走中转。新线路不设到期和流量上限，用量照常算进客户额度；客户不是正常状态时先停用。已在这台落地上有别的协议线路的客户，把他现有的 client 挂到新入站上，不另建。
      </p>
      <div v-if="plan.error" class="notice small">{{ plan.error }}</div>
      <p v-else-if="plan.inbound" class="small">
        复用入站 <b>{{ plan.inbound.remark || `${protoLabel} ${plan.inbound.port}` }}</b>
        <span class="muted">（{{ protoLabel }} {{ plan.inbound.port }}，已有 {{ plan.inbound.clients }} 个 client）</span>
      </p>
      <p v-else-if="plan.create" class="small">
        这台落地上还没有直出的 {{ protoLabel }} 入站，会新建 <b>{{ plan.create.remark }}</b>
        <span class="muted"
          >（照 {{ plan.create.template }}{{ protocol === 'vless' ? ' 的 reality 伪装设置，新端口、新密钥' : '，新端口，证书用这台面板自己的，混淆密码重新生成' }}{{
            plan.create.restart ? '；要加一条直连规则并重启 Xray，这台落地上所有客户断流几秒' : '；不用重启 Xray'
          }}）</span
        >。改之前先存一份配置快照。
      </p>

      <div v-if="!plan.customers.length" class="empty">没有客户的线路出口经过这台落地。</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="check"></th>
              <th>客户</th>
              <th class="num">经过它的线路</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in plan.customers" :key="c.id" :class="{ off: !!c.existing }">
              <td class="check">
                <input v-if="!c.existing && canOpen" type="checkbox" :checked="picked.includes(c.id)" :aria-label="`给${c.name}开直连`" @change="toggle(c.id)" />
              </td>
              <td>
                {{ c.name }}
                <span v-if="c.state !== 'active'" class="badge inline" :class="c.state">{{ STATE_LABEL[c.state] }}</span>
              </td>
              <td class="num">{{ c.lines }}</td>
              <td class="small">
                <span v-if="c.existing" class="muted">已有 {{ protoLabel }} 线路 {{ c.existing }}</span>
                <span v-else-if="picked.includes(c.id) && c.attach">将把现有 client {{ c.attach }} 挂上</span>
                <span v-else-if="picked.includes(c.id)">将开通</span>
                <span v-else class="muted">不开</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template #footer>
      <span class="spacer" />
      <template v-if="result">
        <button class="primary" @click="emit('close')">关闭</button>
      </template>
      <template v-else>
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="busy || !canOpen || !count" @click="submit">{{ busy ? '开通中…' : `开通 ${count} 条 ${protoLabel} 直连` }}</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.proto {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  margin-bottom: 12px;
  border-radius: 9px;
  background: var(--rule-soft);
}
.proto button {
  border: none;
  box-shadow: none;
  background: none;
  padding: 3px 14px;
  border-radius: 7px;
  color: var(--ink-soft);
}
.proto button:hover:not(:disabled) {
  background: none;
  color: var(--ink);
}
.proto button.on {
  background: var(--sheet);
  color: var(--ink);
  box-shadow: var(--shadow);
}
.hint {
  margin: 0 0 12px;
  max-width: 80ch;
}
.notice {
  margin-bottom: 12px;
}
.check {
  width: 36px;
  padding-right: 0;
}
tr.off td {
  color: var(--ink-soft);
}
.steps {
  margin: 8px 0;
  padding-left: 0;
  list-style: none;
  line-height: 1.8;
}
</style>
