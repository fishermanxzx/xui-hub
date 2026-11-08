<script setup lang="ts">
// 整体网络拓扑(cytoscape.js):客户 → 入口面板 → 出口(落地面板的 socks 入站 / SOCKS 代理)→ 互联网。
// 滚轮缩放、拖画布平移、拖节点摆位置;点节点高亮它连着的边,点空白处恢复。面板节点共享:一块面板可同时是别人的直连面板和落地。
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Customer, Panel, Socks } from '../types';

const props = defineProps<{ customers: Customer[]; panels: Panel[]; socks: Socks[] }>();

const el = ref<HTMLDivElement | null>(null);
let cy: Core | null = null;

const PROTOCOL: Record<string, string> = { hysteria: 'hy2' };
const proto = (p: string) => PROTOCOL[p] ?? p;
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** 读页面的主题色给 cytoscape 用(它不认 CSS 变量) */
function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { ink: v('--ink'), soft: v('--ink-soft'), rule: v('--rule'), sheet: v('--sheet'), hover: v('--hover'), accent: v('--accent'), accentSoft: v('--accent-soft'), ok: v('--ok'), okBg: v('--ok-bg'), warn: v('--caution-mark'), warnBg: v('--caution-bg') };
}

/** 把客户 / 面板 / SOCKS / 线路变成节点和边,并按列算好初始位置 */
function build(): { elements: ElementDefinition[]; positions: Record<string, { x: number; y: number }> } {
  const nodes = new Map<string, ElementDefinition>();
  const edges: ElementDefinition[] = [];
  const addNode = (id: string, data: Record<string, unknown>, classes: string) => {
    if (!nodes.has(id)) nodes.set(id, { data: { id, ...data }, classes });
  };
  const edgeIds = new Set<string>();
  const addEdge = (id: string, source: string, target: string, label: string, classes: string) => {
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ data: { id, source, target, label }, classes });
  };

  const entryPanels = new Set<number>();
  const landingPanels = new Set<number>();
  const usedSocks = new Set<number>();
  const directPanels = new Set<number>();
  for (const c of props.customers) {
    addNode(`c:${c.id}`, { label: c.name, sub: `${c.lines.length} 条线路` }, 'customer');
    for (const l of c.lines) {
      entryPanels.add(l.panel_id);
      addEdge(`l:${l.id}`, `c:${c.id}`, `p:${l.panel_id}`, `${proto(l.protocol)} · ${l.email}`, l.kind);
      if (l.kind === 'direct') directPanels.add(l.panel_id);
      else if (l.exit_kind === 'socks' && l.exit_socks_id) {
        usedSocks.add(l.exit_socks_id);
        addEdge(`x:${l.panel_id}:s${l.exit_socks_id}`, `p:${l.panel_id}`, `s:${l.exit_socks_id}`, 'socks', 'relay');
      } else if (l.exit_kind === 'panel' && l.exit_panel_id) {
        landingPanels.add(l.exit_panel_id);
        addEdge(`x:${l.panel_id}:p${l.exit_panel_id}:${l.exit_port}`, `p:${l.panel_id}`, `p:${l.exit_panel_id}`, `socks :${l.exit_port ?? '?'}`, 'relay');
      }
    }
  }
  for (const p of props.panels) addNode(`p:${p.id}`, { label: p.name, sub: hostOf(p.base_url) }, `panel${p.check_error ? ' bad' : ''}`);
  for (const s of props.socks) addNode(`s:${s.id}`, { label: s.name, sub: `${s.host}:${s.port}` }, 'socks');
  addNode('net', { label: '互联网', sub: '' }, 'net');
  for (const id of new Set([...directPanels, ...landingPanels])) addEdge(`n:p${id}`, `p:${id}`, 'net', landingPanels.has(id) && !directPanels.has(id) ? '' : '直出', 'out');
  for (const id of usedSocks) addEdge(`n:s${id}`, `s:${id}`, 'net', '', 'out');

  // 分列:客户 | 入口面板 | 出口(纯落地面板、SOCKS) | 互联网;没参与任何线路的面板 / SOCKS 放到出口列末尾
  const cols: string[][] = [[], [], [], ['net']];
  for (const c of props.customers) cols[0].push(`c:${c.id}`);
  for (const p of props.panels) (entryPanels.has(p.id) ? cols[1] : cols[2]).push(`p:${p.id}`);
  for (const s of props.socks) cols[2].push(`s:${s.id}`);
  const positions: Record<string, { x: number; y: number }> = {};
  const rowH = 100;
  const tallest = Math.max(1, ...cols.map((c) => c.length));
  cols.forEach((ids, ci) => {
    const offset = ((tallest - ids.length) * rowH) / 2;
    ids.forEach((id, ri) => (positions[id] = { x: ci * 260, y: offset + ri * rowH }));
  });
  return { elements: [...nodes.values(), ...edges], positions };
}

function render() {
  if (!el.value) return;
  const t = theme();
  const { elements, positions } = build();
  cy?.destroy();
  cy = cytoscape({
    container: el.value,
    elements,
    layout: { name: 'preset', positions: (n: any) => positions[n.id()] ?? { x: 0, y: 0 }, fit: true, padding: 24 },
    minZoom: 0.3,
    maxZoom: 3,
    wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: { shape: 'round-rectangle', width: 150, height: 44, 'background-color': t.hover, 'border-width': 1, 'border-color': t.rule, label: 'data(label)', color: t.ink, 'font-size': 12, 'font-weight': 600, 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'ellipsis', 'text-max-width': '136px' } },
      { selector: 'node[sub]', style: { label: (n: any) => (n.data('sub') ? `${n.data('label')}\n${n.data('sub')}` : n.data('label')), 'text-wrap': 'wrap', 'line-height': 1.3 } },
      { selector: 'node.customer', style: { 'background-color': t.sheet, 'border-style': 'dashed' } },
      { selector: 'node.panel', style: { 'background-color': t.accentSoft, 'border-color': t.accent } },
      { selector: 'node.panel.bad', style: { 'border-color': '#d92d20', 'border-style': 'dashed' } },
      { selector: 'node.socks', style: { 'background-color': t.warnBg, 'border-color': t.warn } },
      { selector: 'node.net', style: { shape: 'ellipse', width: 72, height: 72, 'background-color': t.sheet, 'border-style': 'dashed', color: t.soft } },
      { selector: 'edge', style: { width: 1.5, 'curve-style': 'bezier', 'line-color': t.soft, 'target-arrow-color': t.soft, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, label: 'data(label)', 'font-size': 10, color: t.ink, 'text-background-color': t.sheet, 'text-background-opacity': 1, 'text-background-padding': '3px', 'text-background-shape': 'roundrectangle', 'text-opacity': 0 } },
      { selector: 'edge.focus', style: { 'text-opacity': 1, width: 2.5 } },
      { selector: 'edge.relay', style: { 'line-color': t.accent, 'target-arrow-color': t.accent } },
      { selector: 'edge.out', style: { 'line-style': 'dashed' } },
      { selector: '.faded', style: { opacity: 0.15 } },
      { selector: 'node:selected', style: { 'border-width': 2, 'border-color': t.ink } },
    ],
  });
  cy.on('tap', 'node', (e) => {
    const n = e.target;
    const keep = n.closedNeighborhood();
    cy!.elements().addClass('faded').removeClass('focus');
    keep.removeClass('faded');
    n.connectedEdges().addClass('focus');
  });
  cy.on('tap', (e) => {
    if (e.target === cy) cy!.elements().removeClass('faded').removeClass('focus');
  });
}

function fit() {
  cy?.fit(undefined, 24);
}
function relayout() {
  render();
}

onMounted(render);
watch(() => [props.customers, props.panels, props.socks], render, { deep: true });
onBeforeUnmount(() => cy?.destroy());

defineExpose({ fit, relayout });
</script>

<template>
  <div class="wrap">
    <div ref="el" class="graph" />
    <div class="controls">
      <button class="link small" @click="fit">适应窗口</button>
      <button class="link small" @click="relayout">重新排列</button>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
}
.graph {
  height: 380px;
  width: 100%;
  background:
    linear-gradient(var(--rule-soft) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(90deg, var(--rule-soft) 1px, transparent 1px) 0 0 / 24px 24px;
  border-radius: 0 0 12px 12px;
}
.controls {
  position: absolute;
  top: 8px;
  right: 10px;
  display: flex;
  gap: 10px;
  padding: 4px 8px;
  background: var(--sheet);
  border: 1px solid var(--rule);
  border-radius: 8px;
}
@media (max-width: 720px) {
  .graph {
    height: 300px;
  }
}
</style>
