<script setup lang="ts">
// 订阅拉取记录:每次拉订阅的时间、客户端 UA、来源 IP、给的格式、结果。来源 IP 多、客户端杂可能是链接被分享了。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { fmtAgo, fmtDateTime } from '../format';
import type { SubFetch } from '../types';

const props = defineProps<{ customerId: number }>();

const TARGET: Record<string, string> = {
  clash: 'Clash',
  singbox: 'sing-box',
  base64: '节点链接',
  surge: 'Surge',
  quanx: 'Quantumult X',
  loon: 'Loon',
  mixed: '节点链接',
};

const rows = ref<SubFetch[] | null>(null);
const days = ref(7);
const error = ref('');

async function load() {
  error.value = '';
  try {
    const res = await api.subFetches(props.customerId);
    rows.value = res.rows;
    days.value = res.days;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);

const summary = computed(() => {
  const list = rows.value ?? [];
  return { count: list.length, ips: new Set(list.map((r) => r.ip)).size, uas: new Set(list.map((r) => r.ua)).size };
});

/** 按客户端(UA)汇总:拉了几次、最近一次、来自几个 IP;最近拉过的在前 */
const clients = computed(() => {
  const by = new Map<string, { ua: string; count: number; last: number; ips: Set<string> }>();
  for (const r of rows.value ?? []) {
    const c = by.get(r.ua) ?? { ua: r.ua, count: 0, last: 0, ips: new Set<string>() };
    c.count++;
    c.last = Math.max(c.last, r.at);
    c.ips.add(r.ip);
    by.set(r.ua, c);
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
});
const showAll = ref(false);
</script>

<template>
  <div class="fetches">
    <div v-if="error" class="notice small">
      读取拉取记录失败：{{ error }}
      <button class="link" @click="load">重试</button>
    </div>
    <template v-else-if="rows">
      <p class="small muted head">
        近 {{ days }} 天拉取 <span class="figure">{{ summary.count }}</span> 次<template v-if="summary.count">，来自 {{ summary.ips }} 个 IP、{{ summary.uas }} 个客户端</template>。
        <button class="link" @click="load">刷新</button>
      </p>
      <template v-if="rows.length">
        <ul class="clients small">
          <li v-for="c in clients" :key="c.ua">
            <span class="ua" :title="c.ua">{{ c.ua || '(没有 UA)' }}</span>
            <span class="muted">{{ c.count }} 次 · {{ c.ips.size }} 个 IP · 最近 {{ fmtAgo(c.last) }}</span>
          </li>
        </ul>
        <p class="small muted head">
          按 UA 区分：同版本同型号的两台设备算一个，升级了版本会多算一个。
          <button class="link" @click="showAll = !showAll">{{ showAll ? '收起每次的记录' : '看每次的记录' }}</button>
        </p>
        <div v-if="showAll" class="table-wrap">
          <table class="small">
            <colgroup>
              <col class="c-at" />
              <col />
              <col class="c-target" />
              <col class="c-ip" />
              <col class="c-status" />
            </colgroup>
            <thead>
              <tr>
                <th>时间</th>
                <th>客户端</th>
                <th>格式</th>
                <th>IP</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in rows" :key="i">
                <td :title="fmtAgo(r.at)">{{ fmtDateTime(r.at) }}</td>
                <td class="ua" :title="r.ua">{{ r.ua || '(没有 UA)' }}</td>
                <td>{{ TARGET[r.target] ?? (r.target || '—') }}</td>
                <td class="ip">{{ r.ip || '—' }}</td>
                <td>
                  <span v-if="r.status >= 400" class="badge err">{{ r.status }}</span>
                  <span v-else class="muted">成功</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
    <p v-else class="small muted">读取中…</p>
  </div>
</template>

<style scoped>
.fetches {
  margin-top: 12px;
}
.head {
  margin: 0 0 6px;
}
table {
  table-layout: fixed;
  min-width: 620px;
}
th,
td {
  padding: 6px 10px;
}
.c-at {
  width: 136px;
}
.c-target {
  width: 96px;
}
.c-ip {
  width: 190px;
}
.c-status {
  width: 64px;
}
.clients {
  list-style: none;
  margin: 0 0 6px;
  padding: 0;
}
.clients li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  border-bottom: 1px solid var(--rule-soft);
}
.clients .muted {
  flex: none;
  white-space: nowrap;
}
/* IPv6 最长 39 个字符,放不下就折行,不压到旁边的列 */
.ip {
  overflow-wrap: anywhere;
}
.ua {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
