<script setup lang="ts">
// 3D 地球(面板页、SOCKS 页共用):按位置打点(同一个地方的几个合成一个点),可拖动旋转、滚轮缩放,没人动时慢慢自转。
// 地球用卫星图(NASA Blue Marble,公有领域),带地形起伏和海面反光;外面一圈淡蓝的大气光晕,背景是星空。
// 点是发光的小圆点 + 地面上一圈圈波纹:都正常是白蓝色,有不通的(面板连不上 / SOCKS 测试失败)是红色、波纹更急。
// 悬停看这里有哪几个,点一下跳到页面上那一行。
// globe.gl(three.js)和贴图只在打开地球时才加载,不拖慢别的页面。亮色 / 暗色主题下都一样。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '../i18n';
import type { GlobePoint } from '../geoRegions';
import dayUrl from '../assets/globe/earth-day.jpg?url';
import bumpUrl from '../assets/globe/earth-bump.jpg?url';
import waterUrl from '../assets/globe/earth-water.jpg?url';

/** label:读屏用的说明 */
const props = defineProps<{ points: GlobePoint[]; label: string }>();
const emit = defineEmits<{ pick: [id: number] }>();

/** 波纹的颜色(圆点的颜色在下面的样式里) */
const RING_OK = [124, 200, 255];
const RING_DOWN = [255, 107, 91];

/** 地图上的一个点:同一个地方(约 0.5°)的几个 */
interface Spot {
  key: string;
  lat: number;
  lng: number;
  place: string;
  items: GlobePoint[];
  down: number;
}

function spotsOf(list: GlobePoint[]): Spot[] {
  const byKey = new Map<string, Spot>();
  for (const p of list) {
    const key = `${Math.round(p.lat * 2)}:${Math.round(p.lng * 2)}`;
    let s = byKey.get(key);
    if (!s) byKey.set(key, (s = { key, lat: p.lat, lng: p.lng, place: p.city, items: [], down: 0 }));
    s.items.push(p);
    if (p.down) s.down++;
    if (!s.place && p.city) s.place = p.city;
  }
  return [...byKey.values()];
}

/** globe.gl 的回调参数是 object,这里转成 Spot */
const by = <R,>(f: (s: Spot) => R) => (o: object) => f(o as Spot);
const nameOf = (s: Spot) => (s.items.length === 1 ? s.items[0].name : `${s.place || s.items[0].name} ×${s.items.length}`);

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
  el.addEventListener('click', () => emit('pick', (s.items.find((p) => p.down) ?? s.items[0]).id));
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
  const spots = spotsOf(props.points);
  globe.ringsData(spots).htmlElementsData(spots);
  if (hovered.value && !spots.some((s) => s.key === hovered.value!.key)) hovered.value = null;
}

/** 一开始对准面板最多的那一片:离各点(按面板数加权)的大圆距离之和最小的那个点 */
function aimAtSpots() {
  const spots = spotsOf(props.points);
  if (!spots.length) return globe.pointOfView({ lat: 25, lng: 110, altitude: 1.75 });
  const rad = Math.PI / 180;
  const dist = (a: Spot, b: Spot) => Math.acos(Math.min(1, Math.sin(a.lat * rad) * Math.sin(b.lat * rad) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((a.lng - b.lng) * rad)));
  const cost = (c: Spot) => spots.reduce((n, s) => n + s.items.length * dist(c, s), 0);
  const best = spots.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  globe.pointOfView({ lat: Math.max(-45, Math.min(45, best.lat)), lng: best.lng, altitude: 1.75 });
}

onMounted(async () => {
  try {
    const [{ default: Globe }, THREE] = await Promise.all([import('globe.gl'), import('three')]);
    if (!box.value) return;
    const el = box.value;
    globe = new Globe(el, { animateIn: true })
      .width(el.clientWidth)
      .height(el.clientHeight)
      .backgroundColor('rgba(0,0,0,0)')
      // 卫星图 + 地形起伏
      .globeImageUrl(dayUrl)
      .bumpImageUrl(bumpUrl)
      .showAtmosphere(true)
      .atmosphereColor('#7cc0ff')
      .atmosphereAltitude(0.16)
      // 面板所在地:地面上一圈圈往外扩的波纹
      .ringLat('lat')
      .ringLng('lng')
      .ringAltitude(0.004)
      .ringColor(by((s) => (k: number) => `rgba(${(s.down ? RING_DOWN : RING_OK).join(',')}, ${0.9 * (1 - k)})`))
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
    // 海面反光:海洋的地方亮一点(陆地不反光)
    new THREE.TextureLoader().load(waterUrl, (tex) => {
      const mat = globe?.globeMaterial();
      if (!mat) return;
      mat.specularMap = tex;
      mat.specular = new THREE.Color('#4a6680');
      mat.shininess = 16;
      mat.needsUpdate = true;
    });
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

watch(() => props.points, setData);

onBeforeUnmount(() => {
  clearTimeout(resumeTimer);
  observer?.disconnect();
  globe?._destructor?.();
  globe = null;
});
</script>

<template>
  <div ref="wrap" class="globe-wrap">
    <div ref="box" class="globe" role="img" :aria-label="label" />
    <p v-if="state === 'loading'" class="globe-msg">{{ t('globe.loading') }}</p>
    <p v-else-if="state === 'failed'" class="globe-msg">{{ t('globe.failed', { error }) }}</p>
    <div v-if="hovered" class="globe-tip" :style="{ left: `${tipAt.x}px`, top: `${tipAt.y}px` }">
      <div v-if="hovered.place || hovered.items[0].country" class="muted-tip">{{ hovered.place || hovered.items[0].country }}</div>
      <div v-for="p in hovered.items" :key="p.id" class="tip-row">
        <b :class="{ bad: p.down }">{{ p.name }}</b>
        <span class="muted-tip">{{ p.meta }}</span>
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
  /* 星空:几层稀疏的小亮点 + 深蓝渐变 */
  background:
    radial-gradient(1px 1px at 20px 30px, rgba(255, 255, 255, 0.7), transparent),
    radial-gradient(1px 1px at 110px 80px, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1.5px 1.5px at 170px 150px, rgba(200, 225, 255, 0.8), transparent),
    radial-gradient(1px 1px at 60px 190px, rgba(255, 255, 255, 0.45), transparent),
    radial-gradient(1px 1px at 230px 40px, rgba(255, 255, 255, 0.6), transparent),
    radial-gradient(circle at 50% 46%, rgba(90, 160, 255, 0.16) 0%, rgba(90, 160, 255, 0) 42%),
    radial-gradient(ellipse at 50% 120%, #0d1d3a 0%, #070d1c 55%, #03060d 100%);
  background-size:
    260px 230px,
    260px 230px,
    260px 230px,
    260px 230px,
    260px 230px,
    auto,
    auto;
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
  color: #93a4bd;
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
  background: #f2f8ff;
  box-shadow:
    0 0 0 2px rgba(124, 200, 255, 0.65),
    0 0 10px 3px rgba(124, 200, 255, 0.85);
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
  color: #f2f7ff;
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
  border: 1px solid rgba(124, 200, 255, 0.35);
  border-radius: 8px;
  background: rgba(7, 13, 28, 0.94);
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
  color: #93a4bd;
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
