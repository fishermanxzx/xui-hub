<script setup lang="ts">
// 面板页的 3D 地球:按面板的位置打点(同一个地方的几块面板合成一个点),可拖动旋转、滚轮缩放,没人动时慢慢自转。
// 点是发光的小圆点 + 地面上一圈圈波纹:都连得上是亮青色,有连不上的是红色、波纹更急。
// 悬停看是哪几块面板,点一下跳到那块面板。
// globe.gl(three.js)和各国轮廓只在打开地球时才加载,不拖慢别的页面。地球底色固定是深色,亮色 / 暗色主题下都一样。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '../i18n';
import type { Panel } from '../types';
import countriesUrl from 'world-atlas/countries-110m.json?url';

const props = defineProps<{ panels: Panel[] }>();
const emit = defineEmits<{ pick: [id: number] }>();

/** 波纹的颜色(圆点的颜色在下面的样式里) */
const RING_OK = [95, 227, 196];
const RING_DOWN = [255, 107, 91];

/** 地图上的一个点:同一个地方(约 0.5°)的几块面板 */
interface Spot {
  key: string;
  lat: number;
  lng: number;
  place: string;
  panels: Panel[];
  down: number;
}

function spotsOf(list: Panel[]): Spot[] {
  const byKey = new Map<string, Spot>();
  for (const p of list) {
    if (p.geo_lat == null || p.geo_lng == null) continue;
    const key = `${Math.round(p.geo_lat * 2)}:${Math.round(p.geo_lng * 2)}`;
    let s = byKey.get(key);
    if (!s) byKey.set(key, (s = { key, lat: p.geo_lat, lng: p.geo_lng, place: p.geo_city, panels: [], down: 0 }));
    s.panels.push(p);
    if (p.check_error) s.down++;
    if (!s.place && p.geo_city) s.place = p.geo_city;
  }
  return [...byKey.values()];
}

/** globe.gl 的回调参数是 object,这里转成 Spot */
const by = <R,>(f: (s: Spot) => R) => (o: object) => f(o as Spot);
const nameOf = (s: Spot) => (s.panels.length === 1 ? s.panels[0].name : `${s.place || s.panels[0].name} ×${s.panels.length}`);

// ---------- 悬停提示(Vue 渲染,名字不会被当成 HTML) ----------
const hovered = ref<Spot | null>(null);
const tipAt = ref({ x: 0, y: 0 });
const wrap = ref<HTMLElement | null>(null);
function showTip(s: Spot, e: MouseEvent) {
  const r = wrap.value!.getBoundingClientRect();
  // 提示框放在鼠标右下,靠右边 / 下边时翻到另一侧,别被裁掉
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  tipAt.value = { x: x + 280 > r.width ? Math.max(4, x - 274) : x + 14, y: y + 140 > r.height ? Math.max(4, y - 120) : y + 14 };
  hovered.value = s;
  hold();
}
function hideTip() {
  hovered.value = null;
  release();
}

/** 点:一个发光的圆点(连不上的红色、闪得急),旁边写名字。悬停出提示,点一下跳到面板 */
function markerEl(s: Spot): HTMLElement {
  const el = document.createElement('div');
  el.className = `globe-marker${s.down ? ' down' : ''}`;
  const dot = document.createElement('span');
  dot.className = 'globe-dot';
  const label = document.createElement('span');
  label.className = 'globe-name';
  label.textContent = nameOf(s);
  el.append(dot, label);
  el.addEventListener('mouseenter', (e) => showTip(s, e));
  el.addEventListener('mousemove', (e) => showTip(s, e));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('click', () => emit('pick', (s.panels.find((p) => p.check_error) ?? s.panels[0]).id));
  return el;
}

const box = ref<HTMLElement | null>(null);
const state = ref<'loading' | 'ready' | 'failed'>('loading');
const error = ref('');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let globe: any = null;
let observer: ResizeObserver | null = null;
let resumeTimer: number | undefined;
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** 有人在动(拖、悬停在点上)时停转,停手 2.5 秒后接着转 */
function hold() {
  if (!globe) return;
  clearTimeout(resumeTimer);
  globe.controls().autoRotate = false;
}
function release() {
  clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => {
    if (globe && !reduceMotion) globe.controls().autoRotate = true;
  }, 2500);
}

function setData() {
  if (!globe) return;
  const spots = spotsOf(props.panels);
  globe.ringsData(spots).htmlElementsData(spots);
  if (hovered.value && !spots.some((s) => s.key === hovered.value!.key)) hovered.value = null;
}

/** 一开始对准面板最多的那一片:离各点(按面板数加权)的大圆距离之和最小的那个点 */
function aimAtSpots() {
  const spots = spotsOf(props.panels);
  if (!spots.length) return globe.pointOfView({ lat: 25, lng: 110, altitude: 1.75 });
  const rad = Math.PI / 180;
  const dist = (a: Spot, b: Spot) => Math.acos(Math.min(1, Math.sin(a.lat * rad) * Math.sin(b.lat * rad) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((a.lng - b.lng) * rad)));
  const cost = (c: Spot) => spots.reduce((n, s) => n + s.panels.length * dist(c, s), 0);
  const best = spots.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  globe.pointOfView({ lat: Math.max(-45, Math.min(45, best.lat)), lng: best.lng, altitude: 1.75 });
}

/**
 * 陆地按国家一块块画(整块陆地的大多边形跨了 180° 经线,打点算不出来),南极洲不画(同样的原因,也用不上);
 * 去掉缩成一个点的碎块(地图数据里有,打点会直接报错,整层陆地都画不出来)
 */
type Ring = [number, number][];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function landOf(countries: any[]) {
  const solid = (poly: Ring[]) => new Set(poly[0].map((p) => `${p[0]},${p[1]}`)).size >= 3;
  return countries
    .filter((f) => f.id !== '010' && f.geometry)
    .map((f) => {
      const polys = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) as Ring[][];
      return { ...f, geometry: { type: 'MultiPolygon', coordinates: polys.filter(solid) } };
    })
    .filter((f) => f.geometry.coordinates.length);
}

onMounted(async () => {
  try {
    const [{ default: Globe }, { feature }, world] = await Promise.all([import('globe.gl'), import('topojson-client'), fetch(countriesUrl).then((r) => r.json())]);
    if (!box.value) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const land = landOf((feature(world, world.objects.countries) as any).features);
    const el = box.value;
    globe = new Globe(el, { animateIn: true })
      .width(el.clientWidth)
      .height(el.clientHeight)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .atmosphereColor('#3fb69a')
      .atmosphereAltitude(0.18)
      // 陆地:一颗颗暗青色的小圆点,面板的点要比它亮
      .hexPolygonsData(land)
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.32)
      .hexPolygonUseDots(true)
      .hexPolygonAltitude(0.003)
      .hexPolygonColor(() => 'rgba(84, 170, 150, 0.38)')
      // 面板所在地:地面上一圈圈往外扩的波纹
      .ringLat('lat')
      .ringLng('lng')
      .ringAltitude(0.004)
      .ringColor(by((s) => (k: number) => `rgba(${(s.down ? RING_DOWN : RING_OK).join(',')}, ${0.85 * (1 - k)})`))
      .ringMaxRadius(by((s) => (s.down ? 6 : 4.5)))
      .ringPropagationSpeed(by((s) => (s.down ? 3.5 : 2)))
      .ringRepeatPeriod(by((s) => (s.down ? 800 : 1500)))
      // 面板:发光的圆点 + 名字(DOM,中文名字也能显示)
      .htmlLat('lat')
      .htmlLng('lng')
      .htmlAltitude(0.005)
      .htmlElement(by((s) => markerEl(s)))
      // 转到背面的点藏起来,也点不到
      .htmlElementVisibilityModifier((m: HTMLElement, visible: boolean) => {
        m.style.opacity = visible ? '1' : '0';
        m.style.pointerEvents = visible ? 'auto' : 'none';
      })
      .onGlobeReady(() => (state.value = 'ready'));
    // 球体:深青色,带一点自发光,背光的一面不至于全黑
    const mat = globe.globeMaterial();
    mat.color.set('#0b211d');
    mat.emissive?.set('#06120f');
    mat.shininess = 4;
    const controls = globe.controls();
    controls.enablePan = false;
    controls.minDistance = 140;
    controls.maxDistance = 520;
    controls.autoRotate = !reduceMotion;
    controls.autoRotateSpeed = 0.45;
    controls.addEventListener('start', hold);
    controls.addEventListener('end', release);
    setData();
    aimAtSpots();
    observer = new ResizeObserver(() => globe?.width(el.clientWidth).height(el.clientHeight));
    observer.observe(el);
  } catch (e) {
    state.value = 'failed';
    error.value = e instanceof Error ? e.message : String(e);
  }
});

watch(() => props.panels, setData);

onBeforeUnmount(() => {
  clearTimeout(resumeTimer);
  observer?.disconnect();
  globe?._destructor?.();
  globe = null;
});
</script>

<template>
  <div ref="wrap" class="globe-wrap">
    <div ref="box" class="globe" role="img" :aria-label="t('globe.aria', { n: panels.filter((p) => p.geo_lat != null).length })" />
    <p v-if="state === 'loading'" class="globe-msg">{{ t('globe.loading') }}</p>
    <p v-else-if="state === 'failed'" class="globe-msg">{{ t('globe.failed', { error }) }}</p>
    <div v-if="hovered" class="globe-tip" :style="{ left: `${tipAt.x}px`, top: `${tipAt.y}px` }">
      <div v-if="hovered.place || hovered.panels[0].geo_country" class="muted-tip">{{ hovered.place || hovered.panels[0].geo_country }}</div>
      <div v-for="p in hovered.panels" :key="p.id" class="tip-row">
        <b :class="{ bad: p.check_error }">{{ p.name }}</b>
        <span class="muted-tip">{{ [p.ip, p.check_error ? t('globe.down') : t('globe.clients', { n: p.client_count ?? 0 })].filter(Boolean).join(' · ') }}</span>
      </div>
      <div class="muted-tip tip-hint">{{ t('globe.clickHint') }}</div>
    </div>
  </div>
</template>

<style scoped>
.globe-wrap {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 46%, rgba(63, 182, 154, 0.14) 0%, rgba(63, 182, 154, 0) 42%),
    radial-gradient(ellipse at 50% 120%, #0f2a25 0%, #08130f 55%, #040907 100%);
}
.globe {
  height: 460px;
}
.globe-msg {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: #8fa39d;
  font-size: 13px;
  pointer-events: none;
}
/* 点:12×12 的框正好落在位置上(globe.gl 按元素大小居中),名字挂在右边,不影响居中 */
.globe :deep(.globe-marker) {
  position: relative;
  width: 12px;
  height: 12px;
  cursor: pointer;
  transition: opacity 0.25s;
}
.globe :deep(.globe-dot) {
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  background: #eafff8;
  box-shadow:
    0 0 0 2px rgba(95, 227, 196, 0.55),
    0 0 10px 3px rgba(95, 227, 196, 0.75);
  animation: globe-glow 2.4s ease-in-out infinite;
}
.globe :deep(.globe-marker.down .globe-dot) {
  background: #ffd9d3;
  box-shadow:
    0 0 0 2px rgba(255, 107, 91, 0.7),
    0 0 12px 4px rgba(255, 107, 91, 0.85);
  animation-duration: 0.9s;
}
.globe :deep(.globe-name) {
  position: absolute;
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
  white-space: nowrap;
  font: 500 11px/1 'IBM Plex Sans', system-ui, sans-serif;
  color: #d6f1ea;
  text-shadow:
    0 1px 3px rgba(0, 0, 0, 0.95),
    0 0 6px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}
.globe :deep(.globe-marker.down .globe-name) {
  color: #ffb9ae;
}
.globe :deep(.globe-marker:hover .globe-dot) {
  transform: scale(1.35);
}
@keyframes globe-glow {
  50% {
    filter: brightness(1.25);
    transform: scale(1.15);
  }
}
@media (prefers-reduced-motion: reduce) {
  .globe :deep(.globe-dot) {
    animation: none;
  }
}
.globe-tip {
  position: absolute;
  z-index: 2;
  max-width: 260px;
  padding: 8px 10px;
  border: 1px solid rgba(95, 227, 196, 0.35);
  border-radius: 8px;
  background: rgba(8, 19, 15, 0.94);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  color: #e5e9e6;
  font-size: 12px;
  line-height: 1.45;
  pointer-events: none;
}
.tip-row {
  margin-top: 4px;
}
.tip-row b {
  margin-right: 6px;
}
.tip-row b.bad {
  color: #ff8a7a;
}
.muted-tip {
  color: #8fa39d;
}
.tip-hint {
  margin-top: 6px;
}
@media (max-width: 640px) {
  .globe {
    height: 340px;
  }
}
</style>
