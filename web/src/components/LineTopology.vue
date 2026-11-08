<script setup lang="ts">
// 一位客户的网络拓扑:每条线路一行,客户端 → 入口面板(入站)→ 出口(落地面板的 socks 入站 / SOCKS 代理 / 本机直出)→ 互联网。
// 纯 SVG,颜色用页面的 CSS 变量,深浅色都跟着走。
import { computed } from 'vue';
import type { Line } from '../types';

const props = defineProps<{ lines: Line[] }>();

const PROTOCOL: Record<string, string> = { hysteria: 'hy2' };
const proto = (p: string) => PROTOCOL[p] ?? p;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// 列布局(viewBox 坐标)
const X = { client: 8, entry: 120, exit: 400, net: 648 };
const W = { client: 72, entry: 220, exit: 200, net: 64 };
const ROW = 72;
const BOX_H = 44;
const WIDTH = 720;

interface Row {
  y: number;
  kind: Line['kind'];
  protocol: string;
  entryTitle: string;
  entrySub: string;
  exit: { title: string; sub: string; kind: 'panel' | 'socks' | 'direct' };
}

const rows = computed<Row[]>(() =>
  props.lines.map((l, i) => {
    const exit =
      l.kind === 'direct'
        ? { title: '本机直出', sub: '', kind: 'direct' as const }
        : l.exit_kind === 'socks'
          ? { title: cut(l.exit_socks_name ?? 'SOCKS(已删除)', 18), sub: 'SOCKS 代理', kind: 'socks' as const }
          : { title: cut(l.exit_panel_name ?? '落地(已删除)', 18), sub: `socks 入站${l.exit_port ? ' :' + l.exit_port : ''}`, kind: 'panel' as const };
    return {
      y: 12 + i * ROW,
      kind: l.kind,
      protocol: proto(l.protocol),
      entryTitle: cut(l.panel_name, 20),
      entrySub: cut(`${l.inbound_remark || '入站 ' + l.inbound_id} · ${proto(l.protocol)} · ${l.email}`, 30),
      exit,
    };
  }),
);

const height = computed(() => 12 + props.lines.length * ROW + 4);
const mid = (y: number) => y + BOX_H / 2;
</script>

<template>
  <div class="topo">
    <svg :viewBox="`0 0 ${WIDTH} ${height}`" :style="{ aspectRatio: `${WIDTH} / ${height}` }" role="img" aria-label="线路拓扑">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="arrow-head" />
        </marker>
      </defs>
      <g v-for="(r, i) in rows" :key="i">
        <!-- 客户端 -->
        <rect :x="X.client" :y="r.y" :width="W.client" :height="BOX_H" rx="8" class="box client" />
        <text :x="X.client + W.client / 2" :y="mid(r.y) + 4" class="label" text-anchor="middle">客户端</text>

        <!-- 客户端 → 入口面板 -->
        <line :x1="X.client + W.client" :y1="mid(r.y)" :x2="X.entry - 2" :y2="mid(r.y)" class="link" marker-end="url(#arrow)" />
        <text :x="(X.client + W.client + X.entry) / 2" :y="mid(r.y) - 6" class="edge" text-anchor="middle">{{ r.protocol }}</text>

        <!-- 入口面板(直连面板 / 中转面板) -->
        <rect :x="X.entry" :y="r.y" :width="W.entry" :height="BOX_H" rx="8" class="box" :class="r.kind" />
        <text :x="X.entry + 12" :y="r.y + 18" class="title">{{ r.entryTitle }}<tspan class="tag" dx="6">{{ r.kind === 'relay' ? '中转' : '直连' }}</tspan></text>
        <text :x="X.entry + 12" :y="r.y + 34" class="sub">{{ r.entrySub }}</text>

        <template v-if="r.kind === 'relay'">
          <!-- 中转 → 出口 -->
          <line :x1="X.entry + W.entry" :y1="mid(r.y)" :x2="X.exit - 2" :y2="mid(r.y)" class="link" marker-end="url(#arrow)" />
          <text :x="(X.entry + W.entry + X.exit) / 2" :y="mid(r.y) - 6" class="edge" text-anchor="middle">socks</text>
          <rect :x="X.exit" :y="r.y" :width="W.exit" :height="BOX_H" rx="8" class="box" :class="r.exit.kind" />
          <text :x="X.exit + 12" :y="r.y + 18" class="title">{{ r.exit.title }}<tspan class="tag" dx="6">{{ r.exit.kind === 'socks' ? 'SOCKS' : '落地' }}</tspan></text>
          <text :x="X.exit + 12" :y="r.y + 34" class="sub">{{ r.exit.sub }}</text>
          <line :x1="X.exit + W.exit" :y1="mid(r.y)" :x2="X.net - 2" :y2="mid(r.y)" class="link" marker-end="url(#arrow)" />
        </template>
        <template v-else>
          <!-- 直连:面板直接出网 -->
          <line :x1="X.entry + W.entry" :y1="mid(r.y)" :x2="X.net - 2" :y2="mid(r.y)" class="link" marker-end="url(#arrow)" />
          <text :x="(X.entry + W.entry + X.net) / 2" :y="mid(r.y) - 6" class="edge" text-anchor="middle">本机直出</text>
        </template>

        <!-- 互联网 -->
        <circle :cx="X.net + W.net / 2" :cy="mid(r.y)" :r="BOX_H / 2" class="box net" />
        <text :x="X.net + W.net / 2" :y="mid(r.y) + 4" class="label" text-anchor="middle">互联网</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.topo {
  padding: 8px 16px 4px;
  overflow-x: auto;
}
svg {
  display: block;
  width: 100%;
  min-width: 560px;
  height: auto;
}
.box {
  fill: var(--hover);
  stroke: var(--rule);
  stroke-width: 1;
}
.box.relay,
.box.direct {
  fill: var(--sheet);
}
.box.relay {
  stroke: var(--accent);
}
.box.panel {
  fill: var(--ok-bg);
  stroke: var(--ok);
}
.box.socks {
  fill: var(--caution-bg);
  stroke: var(--caution-mark);
}
.box.client,
.box.net {
  fill: var(--sheet);
  stroke: var(--rule);
  stroke-dasharray: 3 3;
}
.link {
  stroke: var(--ink-soft);
  stroke-width: 1.4;
}
.arrow-head {
  fill: var(--ink-soft);
}
.label {
  font-size: 12px;
  fill: var(--ink-soft);
}
.title {
  font-size: 13px;
  font-weight: 600;
  fill: var(--ink);
}
.tag {
  font-size: 11px;
  font-weight: 500;
  fill: var(--ink-soft);
}
.sub {
  font-size: 11px;
  fill: var(--ink-soft);
}
.edge {
  font-size: 11px;
  fill: var(--ink-soft);
}
</style>
