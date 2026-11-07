<script setup lang="ts">
// 面板详情:现取这台面板的入站、每个入站的去向和挂在上面的 client(只读);配置快照和按快照恢复。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import PanelSnapshots from '../components/PanelSnapshots.vue';
import { dueLevel, fmtAgo, fmtBytes, fmtDue } from '../format';
import type { PanelClient, PanelDetail, PanelInbound, RouteKind } from '../types';
import CustomerDetail from './CustomerDetail.vue';

const props = defineProps<{ id: number; name: string; url: string }>();
const emit = defineEmits<{ close: [] }>();

const detail = ref<PanelDetail | null>(null);
const loading = ref(false);
const error = ref('');
const q = ref('');
const openCustomer = ref<number | null>(null);
/** 面板读不到时(比如重装了)也自动显示,方便恢复 */
const showSnapshots = ref(false);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    detail.value = await api.panelInbounds(props.id);
    if (!detail.value.inbounds.length) showSnapshots.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const PROTOCOL: Record<string, string> = { hysteria: 'hysteria2', mixed: 'socks' };

function routeText(kind: RouteKind, label: string): string {
  return kind === 'panel' ? `转到 ${label}` : label;
}

const summary = computed(() => {
  const d = detail.value;
  if (!d) return null;
  const all = [...d.inbounds.flatMap((i) => i.clients), ...d.unattached];
  const emails = new Set(all.map((c) => c.email));
  const unbound = new Set(all.filter((c) => !c.customer).map((c) => c.email));
  return { inbounds: d.inbounds.length, off: d.inbounds.filter((i) => !i.enable).length, clients: emails.size, unbound: unbound.size };
});

function matches(c: PanelClient, word: string): boolean {
  return c.email.toLowerCase().includes(word) || (c.customer?.name.toLowerCase().includes(word) ?? false);
}

/** 搜索:入站名或去向匹配时整组显示,否则只显示匹配的 client */
const groups = computed(() => {
  const d = detail.value;
  if (!d) return [];
  const word = q.value.trim().toLowerCase();
  const all: { key: string; inbound: PanelInbound | null; clients: PanelClient[] }[] = [
    ...d.inbounds.map((i) => ({ key: `ib-${i.id}`, inbound: i, clients: i.clients })),
    ...(d.unattached.length ? [{ key: 'unattached', inbound: null, clients: d.unattached }] : []),
  ];
  if (!word) return all;
  return all
    .map((g) => {
      const hit = g.inbound && (g.inbound.remark.toLowerCase().includes(word) || g.inbound.route.label.toLowerCase().includes(word));
      return { ...g, clients: hit ? g.clients : g.clients.filter((c) => matches(c, word)) };
    })
    .filter((g) => g.clients.length || (g.inbound && (g.inbound.remark.toLowerCase().includes(word) || g.inbound.route.label.toLowerCase().includes(word))));
});
</script>

<template>
  <Modal :title="detail?.panel.name ?? name" wide @close="emit('close')">
    <div v-if="error" class="notice">
      读取面板失败：{{ error }}
      <button class="link" :disabled="loading" @click="load">重试</button>
    </div>
    <div v-else-if="!detail" class="empty">正在读取面板…</div>
    <div v-if="error && !detail" class="after-error">
      <PanelSnapshots :panel-id="id" :panel-name="name" @restored="load" />
    </div>

    <template v-if="detail && summary">
      <section class="head">
        <dl class="facts">
          <div>
            <dt>角色</dt>
            <dd>{{ detail.panel.role === 'relay' ? '中转' : '落地' }}</dd>
          </div>
          <div v-if="detail.panel.ip">
            <dt>IP</dt>
            <dd>{{ detail.panel.ip }}</dd>
          </div>
          <div>
            <dt>入站</dt>
            <dd>
              <span class="figure">{{ summary.inbounds }}</span> 个<span v-if="summary.off" class="muted small">，{{ summary.off }} 个已停用</span>
            </dd>
          </div>
          <div>
            <dt>client</dt>
            <dd>
              <span class="figure">{{ summary.clients }}</span> 个<span v-if="summary.unbound" class="muted small">，{{ summary.unbound }} 个没绑定客户</span>
            </dd>
          </div>
          <div>
            <dt>读取于</dt>
            <dd>
              {{ fmtAgo(detail.fetched_at) }}
              <button class="link refresh" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
            </dd>
          </div>
          <div>
            <dt>配置快照</dt>
            <dd>
              <button class="link" :aria-expanded="showSnapshots" @click="showSnapshots = !showSnapshots">
                {{ showSnapshots ? '收起' : '查看 / 恢复' }}
              </button>
            </dd>
          </div>
          <div>
            <dt>面板网页</dt>
            <dd><a class="link" :href="url" target="_blank" rel="noopener noreferrer" title="需要用面板的账号密码登录">打开面板</a></dd>
          </div>
        </dl>
        <input v-model="q" class="search" type="search" placeholder="搜 client、客户或入站" aria-label="搜 client、客户或入站" />
      </section>

      <PanelSnapshots v-if="showSnapshots" :panel-id="id" :panel-name="detail.panel.name" @restored="load" />

      <section v-for="g in groups" :key="g.key" class="inbound" :class="{ off: g.inbound && !g.inbound.enable }">
        <header class="ib-head">
          <template v-if="g.inbound">
            <div class="ib-title">
              <h3>{{ g.inbound.remark || '(无名称)' }}</h3>
              <span class="chip">{{ PROTOCOL[g.inbound.protocol] ?? g.inbound.protocol }} {{ g.inbound.port }}</span>
              <span v-if="g.inbound.transport" class="muted small">{{ g.inbound.transport }}</span>
              <span v-if="!g.inbound.enable" class="badge warn">入站已停用</span>
            </div>
            <div class="ib-route small">
              <span class="muted">去向</span>
              <span :class="{ 'text-err': g.inbound.route.kind === 'block' || g.inbound.route.label.startsWith('找不到') }">
                {{ routeText(g.inbound.route.kind, g.inbound.route.label) }}
              </span>
              <span v-if="g.inbound.extra_rules" class="muted">另有 {{ g.inbound.extra_rules }} 条只管部分流量的规则</span>
            </div>
          </template>
          <div v-else class="ib-title">
            <h3>没挂在任何入站上</h3>
          </div>
          <span class="ib-count muted small">{{ g.clients.length }} 个 client</span>
        </header>

        <div v-if="g.clients.length" class="table-wrap">
          <table class="clients">
            <colgroup>
              <col class="c-email" />
              <col class="c-customer" />
              <col class="c-used" />
              <col class="c-due" />
              <col class="c-online" />
            </colgroup>
            <thead>
              <tr>
                <th>client</th>
                <th>客户</th>
                <th class="num">已用</th>
                <th>到期</th>
                <th>最近在线</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in g.clients" :key="c.email">
                <td>
                  {{ c.email }}
                  <span v-if="!c.enable" class="badge err">停用</span>
                </td>
                <td>
                  <button v-if="c.customer" class="link" @click="openCustomer = c.customer.id">{{ c.customer.name }}</button>
                  <span v-else class="muted">未绑定</span>
                </td>
                <td class="num">
                  {{ fmtBytes(c.up + c.down) }}<span v-if="c.total_bytes" class="muted"> / {{ fmtBytes(c.total_bytes) }}</span>
                </td>
                <td :class="{ 'text-warn': dueLevel(c.expiry_ms) === 'warn', 'text-err': dueLevel(c.expiry_ms) === 'err', muted: !c.expiry_ms }">
                  <span v-if="dueLevel(c.expiry_ms) !== 'err'" class="m-label">到期 </span>{{ fmtDue(c.expiry_ms) }}
                </td>
                <td class="muted"><span class="m-label">在线 </span>{{ fmtAgo(c.last_online, '—') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="none muted small">没有 client</p>
      </section>

      <div v-if="!groups.length" class="empty">
        {{ q.trim() ? '没有匹配的入站或 client' : '面板上还没有入站。重装过的话，可以按上面的配置快照恢复。' }}
      </div>
    </template>
  </Modal>
  <CustomerDetail v-if="openCustomer != null" :id="openCustomer" @close="openCustomer = null" />
</template>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 24px;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--rule-soft);
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 28px;
  margin: 0;
}
.facts dt {
  font-size: 12px;
  color: var(--ink-soft);
}
.facts dd {
  margin: 2px 0 0;
  font-variant-numeric: tabular-nums;
}
.after-error {
  margin-top: 16px;
}
.refresh {
  margin-left: 6px;
  font-size: 12px;
}
.search {
  width: 220px;
  max-width: 100%;
}
.inbound {
  border: 1px solid var(--rule);
  border-radius: 10px;
  margin-bottom: 12px;
  overflow: hidden;
}
.inbound.off {
  border-style: dashed;
}
.ib-head {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 12px;
  padding: 10px 14px;
  background: var(--hover);
  border-bottom: 1px solid var(--rule-soft);
}
.ib-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
h3 {
  font-size: 14px;
  font-weight: 600;
}
.ib-route {
  grid-column: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.ib-count {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
}
.inbound table th {
  background: none;
}
/* 各入站的表格列宽一致,上下对齐 */
.clients {
  table-layout: fixed;
  min-width: 620px;
}
.c-email {
  width: 28%;
}
.c-customer {
  width: 18%;
}
.c-used {
  width: 20%;
}
.c-due {
  width: 16%;
}
.c-online {
  width: 18%;
}
.clients td:first-child {
  overflow-wrap: anywhere;
}
.inbound th,
.inbound td {
  padding: 8px 14px;
}
.none {
  margin: 0;
  padding: 10px 14px;
}
.m-label {
  display: none;
}
@media (max-width: 640px) {
  .search {
    width: 100%;
  }
  /* 手机上每个 client 一行两列的小卡片,不横向滚动 */
  .clients {
    min-width: 0;
    table-layout: auto;
  }
  .clients colgroup,
  .clients thead {
    display: none;
  }
  .clients tbody {
    display: block;
  }
  .clients tr {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 12px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .clients tr:last-child {
    border-bottom: none;
  }
  .clients td {
    padding: 0;
    border: none;
    text-align: left;
  }
  .clients td:nth-child(2),
  .clients td:nth-child(4) {
    text-align: right;
  }
  .clients td:nth-child(n + 3) {
    font-size: 12px;
  }
  .m-label {
    display: inline;
  }
}
</style>
