<script setup lang="ts">
// 中转批量开线路:勾选客户,按每位客户在用的落地(落地机 / SOCKS)在这台中转上各开一条线路。
// 中转上没有通往某个落地的入站就新建(一次建好,只重启一次 Xray)。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { STATE_LABEL } from '../format';
import type { Panel, RelayExitPlan, RelayLineResult, RelayLinesPlan } from '../types';
import Modal from './Modal.vue';

const props = defineProps<{ panel: Panel }>();
const emit = defineEmits<{ close: []; done: [] }>();

const plan = ref<RelayLinesPlan | null>(null);
const error = ref('');
const picked = ref<number[]>([]);
const busy = ref(false);
const result = ref<{ created: string[]; results: RelayLineResult[] } | null>(null);

const openable = (e: RelayExitPlan) => e.status === 'reuse' || e.status === 'create';

async function load() {
  error.value = '';
  try {
    plan.value = await api.relayPlan(props.panel.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

const selectable = computed(() => plan.value?.customers.filter((c) => c.exits.some(openable)) ?? []);
const allPicked = computed(() => selectable.value.length > 0 && selectable.value.every((c) => picked.value.includes(c.id)));
const chosen = computed(() => plan.value?.customers.filter((c) => picked.value.includes(c.id)) ?? []);
const lineCount = computed(() => chosen.value.reduce((n, c) => n + c.exits.filter(openable).length, 0));
/** 勾选的客户里要新建的入站(按落地去重) */
const creating = computed(() => [...new Set(chosen.value.flatMap((c) => c.exits.filter((e) => e.status === 'create').map((e) => e.inbound ?? e.label)))]);
const failed = computed(() => result.value?.results.filter((r) => !r.ok) ?? []);

function toggle(id: number) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id];
}
function toggleAll() {
  picked.value = allPicked.value ? [] : selectable.value.map((c) => c.id);
}

const STATUS: Record<RelayExitPlan['status'], string> = { reuse: '复用', create: '新建', existing: '已有', unsupported: '开不了' };
const title = (e: RelayExitPlan) =>
  e.status === 'unsupported' ? e.reason ?? '' : e.status === 'existing' ? `已有线路 ${e.inbound}` : `${STATUS[e.status]}入站 ${e.inbound}`;

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    result.value = await api.openRelayLines(props.panel.id, picked.value);
    emit('done');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="`在「${panel.name}」上给客户开线路`" wide @close="emit('close')">
    <div v-if="error" class="notice">
      {{ error }}
      <button v-if="!plan" class="link" @click="load">重新读取</button>
    </div>
    <div v-if="!plan && !error" class="empty">正在读取各台中转和客户的线路…</div>

    <template v-if="result">
      <p :class="failed.length ? 'text-err' : 'text-ok'">
        已开通 {{ result.results.filter((r) => r.ok).length }} 条线路<template v-if="result.created.length">，新建了入站 {{ result.created.join('、') }}</template
        >。客户刷新订阅就能看到。
      </p>
      <ul class="small steps">
        <li v-for="(r, i) in result.results" :key="i" :class="{ 'text-err': !r.ok }">
          {{ r.ok ? '✓' : '✗' }} {{ r.customer }} → {{ r.exit }}（{{ r.inbound }}<template v-if="r.email">，{{ r.email }}</template>）<template v-if="r.error">：{{ r.error }}</template>
        </li>
      </ul>
    </template>

    <template v-else-if="plan">
      <p class="hint muted small">
        勾选客户，按他现在在用的落地（落地机或 SOCKS，从他在其他中转、落地上的线路推算），在这台中转上各开一条通往同一落地的线路。中转本机直出的线路不复制；已经在这台中转上有的跳过。新线路不设到期和流量上限，客户不是正常状态时先停用。
      </p>
      <div v-if="plan.errors.length" class="notice small">这些中转读取失败，没算进来：{{ plan.errors.map((e) => e.panel).join('、') }}</div>
      <div v-if="!plan.customers.length" class="empty">没有客户在用可以复制到这台中转的落地。</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="check"><input type="checkbox" :checked="allPicked" :disabled="!selectable.length" aria-label="全选" @change="toggleAll" /></th>
              <th>客户</th>
              <th>在用的落地 → 这台中转上</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in plan.customers" :key="c.id" :class="{ off: !c.exits.some(openable) }">
              <td class="check">
                <input v-if="c.exits.some(openable)" type="checkbox" :checked="picked.includes(c.id)" :aria-label="`给${c.name}开线路`" @change="toggle(c.id)" />
              </td>
              <td class="cust">
                {{ c.name }}
                <span v-if="c.state !== 'active'" class="badge inline" :class="c.state">{{ STATE_LABEL[c.state] }}</span>
              </td>
              <td>
                <div class="chips">
                  <span v-for="e in c.exits" :key="e.key" class="chip" :class="{ off: !openable(e) }" :title="title(e)">
                    {{ e.label }}<span class="muted">{{ STATUS[e.status] }}</span>
                  </span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="creating.length" class="notice small restart">
        这台中转上还没有通往其中 {{ creating.length }} 个落地的入站，会新建 {{ creating.join('、') }}（照 {{ plan.template }}{{
          plan.template?.includes(' 的 ') ? '，换新密钥' : ''
        }}），补上出站和路由规则，只重启一次 Xray（这台中转上所有客户断流几秒）。改之前先存一份配置快照。
      </div>
    </template>

    <template #footer>
      <span class="spacer" />
      <template v-if="result">
        <button class="primary" @click="emit('close')">关闭</button>
      </template>
      <template v-else>
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="busy || !lineCount" @click="submit">
          {{ busy ? '开通中…' : `给 ${chosen.length} 位客户开 ${lineCount} 条线路` }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.hint {
  margin: 0 0 12px;
  max-width: 80ch;
}
.notice {
  margin-bottom: 12px;
}
.restart {
  margin-top: 12px;
}
.check {
  width: 36px;
  padding-right: 0;
}
.cust {
  white-space: nowrap;
}
tr.off td {
  color: var(--ink-soft);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip .muted {
  margin-left: 6px;
}
.steps {
  margin: 8px 0;
  padding-left: 0;
  list-style: none;
  line-height: 1.8;
}
</style>
