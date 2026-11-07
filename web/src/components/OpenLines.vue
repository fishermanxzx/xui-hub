<script setup lang="ts">
// 按出口开通线路:选一个出口,在各台中转上通往它的入站里给客户新建 client 并绑定。
// 已有通往这个出口的线路的中转跳过;没有通往它的入站的中转,照同类入站新建一个(会重启那台中转的 Xray)。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import type { Customer, ExitOption, LinePlan, OpenLineResult, RelayPlan } from '../types';
import Modal from './Modal.vue';

const props = defineProps<{ customerId: number; customerName: string; active: boolean }>();
const emit = defineEmits<{ close: []; done: [customer: Customer, results: OpenLineResult[]] }>();

const PROTOCOL: Record<string, string> = { hysteria: 'hysteria2' };

const plan = ref<LinePlan | null>(null);
const error = ref('');
const exitKey = ref('');
const picked = ref<number[]>([]);
const busy = ref(false);

const creatable = (r: RelayPlan) => (r.inbound != null || r.create != null) && r.existing == null;
const needsInbound = (r: RelayPlan) => r.inbound == null && r.create != null && r.existing == null;
const openable = (e: ExitOption) => e.relays.filter(creatable).length;
const exit = computed(() => plan.value?.exits.find((e) => e.key === exitKey.value) ?? null);
const chosen = computed(() => exit.value?.relays.filter((r) => creatable(r) && picked.value.includes(r.panel_id)) ?? []);
const count = computed(() => chosen.value.length);
const restarting = computed(() => chosen.value.filter(needsInbound));

function exitNote(e: ExitOption): string {
  const n = openable(e);
  const fresh = e.relays.filter(needsInbound).length;
  if (!n) return '没有可开的中转';
  return fresh ? `${n} 台中转可开，其中 ${fresh} 台要新建入站` : `${n} 台中转可开`;
}

// 默认只勾已有入站的中转;要新建入站的会重启那台中转的 Xray,由人自己勾
function pick(key: string) {
  exitKey.value = key;
  picked.value = exit.value?.relays.filter((r) => creatable(r) && !needsInbound(r)).map((r) => r.panel_id) ?? [];
}

async function load() {
  error.value = '';
  try {
    plan.value = await api.linePlan(props.customerId);
    // 默认选客户现有线路最多的出口;都没有就选第一个
    const owned = (e: ExitOption) => e.relays.filter((r) => r.existing).length;
    const best = [...plan.value.exits].sort((a, b) => owned(b) - owned(a))[0];
    if (best) pick(best.key);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

function toggle(id: number) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id];
}

async function submit() {
  if (!exit.value) return;
  busy.value = true;
  try {
    const ids = exit.value.relays.filter((r) => creatable(r) && picked.value.includes(r.panel_id)).map((r) => r.panel_id);
    const { customer, results } = await api.openLines(props.customerId, exit.value.key, ids);
    emit('done', customer, results);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="`给${customerName}开通线路`" wide @close="emit('close')">
    <div v-if="error" class="notice">
      {{ error }}
      <button class="link" @click="load">重新读取</button>
    </div>
    <div v-if="!plan && !error" class="empty">正在读取各台中转…</div>

    <template v-if="plan">
      <p class="hint muted small">
        选一个出口，会在每台中转上通往它的入站里给客户新建 client 并绑定；已经有线路的中转自动跳过；还没有通往它的入站的中转，勾选后先新建入站。新建的 client 不设到期和流量上限，{{
          active ? '客户正常，线路直接启用' : '客户现在不是正常状态，线路先停用，恢复正常时自动启用'
        }}。
      </p>
      <div v-if="plan.errors.length" class="notice small">
        这些中转读取失败，没算进来：{{ plan.errors.map((e) => `${e.panel}（${e.error}）`).join('、') }}
      </div>
      <div v-if="!plan.exits.length" class="empty">中转上没有可以开 client 的入站。</div>

      <template v-else>
        <label class="field exit">
          出口
          <select :value="exitKey" @change="pick(($event.target as HTMLSelectElement).value)">
            <option v-for="e in plan.exits" :key="e.key" :value="e.key">
              {{ e.label }}（{{ exitNote(e) }}）
            </option>
          </select>
        </label>

        <div v-if="exit" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="check"></th>
                <th>中转</th>
                <th>入站</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in exit.relays" :key="r.panel_id" :class="{ off: !creatable(r) }">
                <td class="check">
                  <input
                    v-if="creatable(r)"
                    type="checkbox"
                    :checked="picked.includes(r.panel_id)"
                    :aria-label="`在${r.panel_name}上开通`"
                    @change="toggle(r.panel_id)"
                  />
                </td>
                <td>{{ r.panel_name }}</td>
                <td>
                  <template v-if="r.inbound">
                    {{ r.inbound.remark }}
                    <span class="muted small">{{ PROTOCOL[r.inbound.protocol] ?? r.inbound.protocol }} {{ r.inbound.port }}</span>
                  </template>
                  <template v-else-if="r.create">
                    {{ r.create.remark }}
                    <span class="muted small">新建，照 {{ r.create.template }}（{{ PROTOCOL[r.create.protocol] ?? r.create.protocol }}）</span>
                  </template>
                  <span v-else class="muted">—</span>
                </td>
                <td class="small">
                  <span v-if="r.existing" class="muted">已有线路 {{ r.existing.email }}</span>
                  <span v-else-if="!r.inbound && !r.create" class="muted">没有通往这个出口的入站，也没有可以照着建的</span>
                  <span v-else-if="picked.includes(r.panel_id) && needsInbound(r)">将新建入站和线路</span>
                  <span v-else-if="picked.includes(r.panel_id)">将新建</span>
                  <span v-else-if="needsInbound(r)" class="muted">不开（勾选后新建入站）</span>
                  <span v-else class="muted">不开</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="restarting.length" class="notice small restart">
          {{ restarting.map((r) => r.panel_name).join('、') }} 上还没有通往这个出口的入站：会照同类入站新建一个（新端口），补上出站和路由规则，重启
          Xray（这{{ restarting.length > 1 ? '几' : '' }}台中转上所有客户断流几秒），再开 client。改之前先存一份配置快照。
        </div>
      </template>
    </template>

    <template #footer>
      <span class="spacer" />
      <button @click="emit('close')">取消</button>
      <button class="primary" :disabled="busy || !count" @click="submit">{{ busy ? '开通中…' : `开通 ${count} 条` }}</button>
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
.exit {
  max-width: 420px;
  margin-bottom: 12px;
}
.check {
  width: 36px;
  padding-right: 0;
}
tr.off td {
  color: var(--ink-soft);
}
.restart {
  margin-top: 12px;
}
</style>
