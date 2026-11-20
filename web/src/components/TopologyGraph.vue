<script setup lang="ts">
// 一位客户的网络拓扑(cytoscape.js):客户端 → 入口面板 → 出口(落地面板的 socks 入站 / SOCKS 代理)→ 互联网。
// 读到了面板路由规则的线路按规则画:一个客户端可以按条件连出多个出口(边上标条件),面板上没登记的出站、拦截、负载均衡也画出来。
// 滚轮缩放、拖画布平移、拖节点摆位置;点节点高亮它下游的路径,点空白处恢复。只画这位客户用到的面板和 SOCKS。
import { t } from '../i18n';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Customer, Panel, Socks } from '../types';
import { routeWhen } from '../format';

const props = withDefaults(defineProps<{ customer: Customer; panels: Panel[]; socks: Socks[]; height?: number }>(), { height: 260 });

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
  /** 面板上没登记成 SOCKS 的出站 / 拦截 / 负载均衡:id → 节点数据 */
  const otherExits = new Map<string, { label: string; sub: string; cls: string }>();
  /** 按条件直出的边:面板 id → 条件文字 */
  const directWhen = new Map<number, Set<string>>();
  {
    const c = props.customer;
    addNode(`c:${c.id}`, { label: t('topo.client'), sub: c.name }, 'customer');
    for (const l of c.lines) {
      entryPanels.add(l.panel_id);
      addEdge(`l:${l.id}`, `c:${c.id}`, `p:${l.panel_id}`, `${proto(l.protocol)} · ${l.email}`, l.kind);
      if (l.routes?.length) {
        // 按面板上的路由规则画:一条规则一条边,只有一个出口时边上不标条件
        const multi = l.routes.length > 1;
        for (const h of l.routes) {
          const when = multi ? (h.fallback ? t('customers.routeRest') : routeWhen(h.when)) : '';
          const to = h.to;
          if (to.kind === 'direct') {
            directPanels.add(l.panel_id);
            if (when) directWhen.set(l.panel_id, new Set([...(directWhen.get(l.panel_id) ?? []), when]));
          } else if (to.kind === 'socks' && to.socks_id) {
            usedSocks.add(to.socks_id);
            addEdge(`x:${l.panel_id}:s${to.socks_id}:${when}`, `p:${l.panel_id}`, `s:${to.socks_id}`, when || 'socks', 'relay');
          } else {
            const id = to.kind === 'block' ? `o:block` : `o:${l.panel_id}:${to.kind}:${to.tag}`;
            if (!otherExits.has(id)) {
              const label = to.kind === 'block' ? t('customers.routeBlock') : to.kind === 'balancer' ? t('customers.routeBalancer', { tag: to.tag }) : to.tag;
              otherExits.set(id, { label, sub: to.address ?? (to.kind === 'unknown' ? t('topo.outboundMissing') : ''), cls: to.kind === 'block' ? 'block' : 'socks' });
            }
            addEdge(`x:${l.panel_id}:${id}:${when}`, `p:${l.panel_id}`, id, when, to.kind === 'block' ? 'blocked' : 'relay');
          }
        }
      } else if (l.kind === 'direct') directPanels.add(l.panel_id);
      else if (l.exit_kind === 'socks' && l.exit_socks_id) {
        usedSocks.add(l.exit_socks_id);
        addEdge(`x:${l.panel_id}:s${l.exit_socks_id}`, `p:${l.panel_id}`, `s:${l.exit_socks_id}`, 'socks', 'relay');
      } else if (l.exit_kind === 'panel' && l.exit_panel_id) {
        landingPanels.add(l.exit_panel_id);
        addEdge(`x:${l.panel_id}:p${l.exit_panel_id}:${l.exit_port}`, `p:${l.panel_id}`, `p:${l.exit_panel_id}`, `socks :${l.exit_port ?? '?'}`, 'relay');
      }
    }
  }
  // 只画用到的面板和 SOCKS;已经删除的面板 / SOCKS 用占位节点
  const panelIds = new Set([...entryPanels, ...landingPanels]);
  for (const id of panelIds) {
    const p = props.panels.find((x) => x.id === id);
    addNode(`p:${id}`, p ? { label: p.name, sub: hostOf(p.base_url) } : { label: t('topo.panelDeleted'), sub: '' }, `panel${!p || p.check_error ? ' bad' : ''}`);
  }
  for (const id of usedSocks) {
    const s = props.socks.find((x) => x.id === id);
    addNode(`s:${id}`, s ? { label: s.name, sub: `${s.host}:${s.port}` } : { label: t('topo.socksDeleted'), sub: '' }, 'socks');
  }
  for (const [id, x] of otherExits) addNode(id, { label: x.label, sub: x.sub }, x.cls);
  addNode('net', { label: t('topo.internet'), sub: '' }, 'net');
  const hasExitColumn = usedSocks.size > 0 || otherExits.size > 0 || [...landingPanels].some((id) => !entryPanels.has(id));
  for (const id of new Set([...directPanels, ...landingPanels])) {
    const fromEntry = entryPanels.has(id);
    const when = [...(directWhen.get(id) ?? [])].join(' / ');
    const label = landingPanels.has(id) && !directPanels.has(id) ? '' : when ? `${when} · ${t('topo.directOut')}` : t('topo.directOut');
    addEdge(`n:p${id}`, `p:${id}`, 'net', label, `out${fromEntry && hasExitColumn ? ' arc' : ''}`);
  }
  for (const id of usedSocks) addEdge(`n:s${id}`, `s:${id}`, 'net', '', 'out');
  // 拦截不通往互联网
  for (const id of otherExits.keys()) if (id !== 'o:block') addEdge(`n:${id}`, id, 'net', '', 'out');

  // 分列:客户端 | 入口面板 | 出口(纯落地面板、SOCKS) | 互联网
  const cols: string[][] = [[`c:${props.customer.id}`], [], [], ['net']];
  for (const id of panelIds) (entryPanels.has(id) ? cols[1] : cols[2]).push(`p:${id}`);
  for (const id of usedSocks) cols[2].push(`s:${id}`);
  for (const id of otherExits.keys()) cols[2].push(id);
  const positions: Record<string, { x: number; y: number }> = {};
  const rowH = 90;
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
      { selector: 'node.block', style: { 'background-color': t.sheet, 'border-color': '#d92d20', 'border-style': 'dashed', color: t.soft } },
      { selector: 'node.net', style: { shape: 'ellipse', width: 72, height: 72, 'background-color': t.sheet, 'border-style': 'dashed', color: t.soft } },
      { selector: 'edge', style: { width: 1.5, 'curve-style': 'bezier', 'line-color': t.soft, 'target-arrow-color': t.soft, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, label: 'data(label)', 'font-size': 10, color: t.ink, 'text-background-color': t.sheet, 'text-background-opacity': 1, 'text-background-padding': '3px', 'text-background-shape': 'roundrectangle', 'text-opacity': 0 } },
      { selector: 'edge.focus', style: { 'text-opacity': 1, width: 2.5 } },
      { selector: 'edge.relay', style: { 'line-color': t.accent, 'target-arrow-color': t.accent } },
      { selector: 'edge.blocked', style: { 'line-color': '#d92d20', 'target-arrow-color': '#d92d20', 'line-style': 'dotted' } },
      // 面板直出到互联网的虚线往上拱一下,免得被同一行的出口节点挡住
      { selector: 'edge.out', style: { 'line-style': 'dashed' } },
      { selector: 'edge.out.arc', style: { 'curve-style': 'unbundled-bezier', 'control-point-distances': [-70], 'control-point-weights': [0.5] } },
      { selector: '.faded', style: { opacity: 0.15 } },
      { selector: 'node:selected', style: { 'border-width': 2, 'border-color': t.ink } },
    ],
  });
  // 点节点:它直接相连的,加上它下游的整条路径(客户 → 中转 → 落地 / SOCKS → 互联网)都点亮,其余变淡
  cy.on('tap', 'node', (e) => {
    const n = e.target;
    const keep = n.closedNeighborhood().union(n.successors());
    cy!.elements().addClass('faded').removeClass('focus');
    keep.removeClass('faded');
    keep.edges().addClass('focus');
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
watch(() => [props.customer, props.panels, props.socks], render, { deep: true });
onBeforeUnmount(() => cy?.destroy());

defineExpose({ fit, relayout });
</script>

<template>
  <div class="wrap">
    <div ref="el" class="graph" :style="{ height: height + 'px' }" />
    <div class="controls">
      <button class="link small" @click="fit">{{ t('topo.fit') }}</button>
      <button class="link small" @click="relayout">{{ t('topo.relayout') }}</button>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
}
.graph {
  width: 100%;
  border: 1px solid var(--rule);
  border-radius: 10px;
  background:
    linear-gradient(var(--rule-soft) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(90deg, var(--rule-soft) 1px, transparent 1px) 0 0 / 24px 24px;
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
</style>
