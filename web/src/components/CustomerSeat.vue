<script setup lang="ts">
// 机房里的一个机位:一张桌子一台电脑(等距 3D 小场景,见 seatScene.ts),小人坐在那儿;桌上小主机接出网线,一条线路一根:
// 颜色按面板分(同一块面板到处同一种颜色),停用的灰色虚线,最近在线的线上有数据在流;悬停网线看是哪块面板。
// 在线坐着打字、屏幕亮,时不时随机抽根烟、喝口饮料、吃零食、伸个懒腰;不在线趴着睡觉。
// 下面一块名牌写编号、线路条数、在线(正在做小动作时写在干嘛,灯还是绿的;不在线写最近一次在线是多久前)、名字、流量、到期、月费。点了发 open。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { t } from '../i18n';
import { dueLevel, fmtAgo, fmtBytes, fmtCost, fmtDue, stateLabel } from '../format';
import { lineOnline } from '../rooms';
import { ACT_MS, cables, MAX_CABLES, SCENE_ACT, SCENE_SLEEP, SCENE_WORK, SCREEN_TEXT_TRANSFORM, SEAT_ACTS, SEAT_VIEWBOX, ZZZ, type SeatAct } from '../seatScene';
import type { Customer, Line } from '../types';

const props = withDefaults(
  defineProps<{
    customer: Customer;
    /** 这间房里算在线(房间按这间房的线路算) */
    online: boolean;
    /** 正在弹窗里看的那位 */
    picked?: boolean;
    /** 用量到额度的多少 % 时用量条变黄 */
    warnPct?: number;
    /** 哪些网线接在这间房里(其余的画淡);不给 = 全算 */
    lineIn?: (l: Line) => boolean;
  }>(),
  { picked: false, warnPct: 80, lineIn: undefined },
);
defineEmits<{ open: [] }>();

/** 最近一次在线:这间房里的几条线路(大厅里是全部线路)在面板上记的最近在线时间里最新的那次;0 = 没记到过 */
const seen = computed(() => props.customer.lines.reduce((m, l) => (props.lineIn && !props.lineIn(l) ? m : Math.max(m, l.last_online || 0)), 0));
const lightTitle = computed(() =>
  act.value
    ? `${t('customers.seatOnline')} · ${t(`customers.act.${act.value}`)}`
    : !props.online && seen.value
      ? `${t('customers.seatOffline')} · ${t('customers.lastOnline', { ago: fmtAgo(seen.value) })}`
      : undefined,
);

const pct = computed(() => (props.customer.quota_bytes ? Math.min(100, (props.customer.used / props.customer.quota_bytes) * 100) : 0));
const meter = computed(() => (!props.customer.quota_bytes ? '' : props.customer.used >= props.customer.quota_bytes ? 'full' : pct.value >= props.warnPct ? 'warn' : ''));

/**
 * 在线时的小动作:歇一会儿(头一次 2–20 秒,之后 12–40 秒)随机挑一个做,做完接着打字;不连着做同一个。
 * 每个机位各算各的,所以一屋子人不会一起动。系统设了减少动态效果就不做。
 */
const act = ref<SeatAct | null>(null);
let actTimer: ReturnType<typeof setTimeout> | undefined;
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function rest(first = false) {
  act.value = null;
  actTimer = setTimeout(startAct, first ? rand(2000, 20000) : rand(12000, 40000));
}
function startAct() {
  const last = act.value;
  const pick = SEAT_ACTS.filter((a) => a !== last);
  act.value = pick[Math.floor(Math.random() * pick.length)];
  actTimer = setTimeout(rest, ACT_MS[act.value]);
}
watch(
  () => props.online,
  (on) => {
    clearTimeout(actTimer);
    if (on && !calm) rest(true);
    else act.value = null;
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(actTimer));
const scene = computed(() => (!props.online ? SCENE_SLEEP : act.value ? SCENE_ACT[act.value] : SCENE_WORK));

/** 网线颜色:按面板 id 轮换,同一块面板到处同一种颜色 */
const CABLE_COLORS = ['#4f8ff7', '#f08a3c', '#3fbf7f', '#a77bf3', '#e2c13f', '#ee6fa8', '#36c3c9', '#9acd47'];
const wires = computed(() => {
  const lines = props.customer.lines.slice(0, MAX_CABLES);
  const pts = cables(lines.length);
  return lines.map((l, i) => ({
    id: l.id,
    pts: pts[i],
    color: l.enable ? CABLE_COLORS[l.panel_id % CABLE_COLORS.length] : '#7d8681',
    off: !l.enable,
    live: l.enable && lineOnline(l),
    dim: props.lineIn ? !props.lineIn(l) : false,
    title: [l.panel_name + (l.node_name || l.panel_node_name ? `「${l.node_name || l.panel_node_name}」` : ''), !l.enable ? t('rooms.lineOff') : lineOnline(l) ? t('customers.seatOnline') : t('customers.seatOffline')].join(' · '),
  }));
});

/** 屏幕上的字:英文 / 数字开头取前两个字母,其他取前两个字 */
function avatarText(name: string): string {
  const s = name.trim();
  const latin = s.match(/^[A-Za-z0-9]{1,2}/);
  return latin ? latin[0].toUpperCase() : [...s].slice(0, 2).join('') || '?';
}
/** 衣服颜色:按客户 id 在 8 种里轮换 */
const tone = (id: number) => id % 8;
const seatNo = (id: number) => String(id).padStart(3, '0');
</script>

<template>
  <button
    type="button"
    class="seat"
    :data-seat="customer.id"
    :class="[customer.state, `tone-${tone(customer.id)}`, { online, picked }]"
    :title="t('customers.seatOpen', { name: customer.name })"
    @click="$emit('open')"
  >
    <svg class="scene" :class="act && `act-${act}`" :viewBox="SEAT_VIEWBOX" aria-hidden="true">
      <template v-for="(f, i) in scene" :key="i">
        <text v-if="f.text" class="screen-text" :transform="SCREEN_TEXT_TRANSFORM">{{ avatarText(customer.name) }}</text>
        <g v-else-if="f.fx" class="fx" :class="[f.fx, f.cls]" :transform="`translate(${f.at![0]} ${f.at![1]})`">
          <circle v-for="k in 3" :key="k" :r="f.fx === 'puff' ? 1.6 + k * 0.6 : 0.9 + k * 0.2" :cx="f.fx === 'puff' ? (k - 2) * 2 : 0" />
        </g>
        <polygon v-else :class="f.cls" :points="f.pts" />
      </template>
      <g v-if="!online" class="zzz">
        <text v-for="(z, i) in ZZZ" :key="i" :x="z.x" :y="z.y">z</text>
      </g>
      <g v-for="w in wires" :key="w.id" class="wire" :class="{ off: w.off, dim: w.dim }">
        <title>{{ w.title }}</title>
        <polyline class="cable" :points="w.pts" :style="{ stroke: w.color }" />
        <polyline v-if="w.live && !w.dim" class="flow" :points="w.pts" />
      </g>
    </svg>
    <span class="plate">
      <span class="seat-top">
        <span class="seat-no">#{{ seatNo(customer.id) }}<span v-if="customer.lines.length" class="seat-lines"> · {{ t('customers.lineCount', { n: customer.lines.length }, customer.lines.length) }}</span></span>
        <span class="seat-light" :title="lightTitle"
          ><i aria-hidden="true" /><template v-if="act">{{ t(`customers.act.${act}`) }}</template
          ><template v-else-if="online">{{ t('customers.seatOnline') }}</template
          ><template v-else-if="seen"
            ><span class="seen-long">{{ t('customers.seatSeen', { ago: fmtAgo(seen) }) }}</span><span class="seen-short">{{ fmtAgo(seen) }}</span></template
          ><template v-else>{{ t('customers.seatOffline') }}</template></span
        >
      </span>
      <span class="seat-name">
        <span class="nm">{{ customer.name }}</span>
        <span v-if="customer.state !== 'active'" class="badge" :class="customer.state">{{ stateLabel(customer.state) }}</span>
      </span>
      <span class="seat-use">
        <span class="fig" :class="{ 'text-err': customer.state === 'over_quota' }"
          ><b>{{ fmtBytes(customer.used) }}</b><span class="muted"> / {{ customer.quota_bytes ? fmtBytes(customer.quota_bytes) : t('customers.noQuota') }}</span></span
        >
        <span class="meter" :class="[meter, { 'no-quota': !customer.quota_bytes }]"><span :style="{ width: pct + '%' }" /></span>
      </span>
      <span class="seat-foot">
        <span :class="{ 'text-warn': dueLevel(customer.expire_at) === 'warn', 'text-err': dueLevel(customer.expire_at) === 'err', muted: !customer.expire_at }">{{ fmtDue(customer.expire_at) }}</span>
        <span v-if="customer.monthly_fee != null">{{ t('customers.feeValue', { v: fmtCost(customer.monthly_fee) }) }}</span>
        <span v-else class="muted">{{ t('customers.noFee') }}</span>
      </span>
    </span>
  </button>
</template>

<style scoped>
.seat {
  --av: #3b78c4;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  text-align: left;
  font-weight: 400;
  line-height: 1.4;
  border: none;
  border-radius: 10px;
  background: none;
  transition: transform 0.15s;
}
.seat:hover:not(:disabled) {
  background: none;
  transform: translateY(-2px);
}
.seat:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.seat.tone-1 {
  --av: #c2573b;
}
.seat.tone-2 {
  --av: #23885f;
}
.seat.tone-3 {
  --av: #8a5cc8;
}
.seat.tone-4 {
  --av: #b8466f;
}
.seat.tone-5 {
  --av: #a36d12;
}
.seat.tone-6 {
  --av: #2f8a93;
}
.seat.tone-7 {
  --av: #5d6c7b;
}

/* 场景:等距 3D,长方体顶面最亮、左下面(+y)次之、右下面(+x)最暗;屏幕和机身两种主题下都是深色 */
.scene {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
.floor.t {
  fill: color-mix(in srgb, var(--ink) 6%, var(--sheet));
}
.floor.l {
  fill: color-mix(in srgb, var(--ink) 16%, var(--sheet));
}
.floor.r {
  fill: color-mix(in srgb, var(--ink) 26%, var(--sheet));
}
.wood.t {
  fill: #c4935f;
}
.wood.l {
  fill: #a77a4d;
}
.wood.r {
  fill: #86603d;
}
.metal.t {
  fill: #505955;
}
.metal.l {
  fill: #3b423e;
}
.metal.r {
  fill: #2a302d;
}
.chair.t {
  fill: #6e7784;
}
.chair.l {
  fill: #575f6b;
}
.chair.r {
  fill: #434a54;
}
.pants.t {
  fill: #61709a;
}
.pants.l {
  fill: #4b5778;
}
.pants.r {
  fill: #3a435d;
}
.shoe.t {
  fill: #3b3b3b;
}
.shoe.l {
  fill: #2b2b2b;
}
.shoe.r {
  fill: #1e1e1e;
}
.skin.t {
  fill: #f5d0a9;
}
.skin.l {
  fill: #e8ba8e;
}
.skin.r {
  fill: #cf9d71;
}
.hair.t {
  fill: #4a3e35;
}
.hair.l {
  fill: #33291f;
}
.hair.r {
  fill: #241d17;
}
.shirt.t {
  fill: color-mix(in srgb, var(--av) 70%, #fff);
}
.shirt.l {
  fill: var(--av);
}
.shirt.r {
  fill: color-mix(in srgb, var(--av) 70%, #000);
}
.case.t {
  fill: #6a746f;
}
.case.l {
  fill: #545d59;
}
.case.r {
  fill: #3f4643;
}
.led {
  fill: #39413d;
}
/* 小动作用到的东西:一罐饮料、一根烟、一包薯片、烟 */
.can.t {
  fill: #e4655a;
}
.can.l {
  fill: #d0413a;
}
.can.r {
  fill: #a32e28;
}
.lid.t {
  fill: #dfe3e6;
}
.lid.l {
  fill: #b9bfc4;
}
.lid.r {
  fill: #949a9f;
}
.cig {
  fill: #f4f1ea;
}
.cig.r {
  fill: #d8d4cb;
}
.ember {
  fill: #ff7a3c;
}
.bag.t {
  fill: #8a5a17;
}
.bag.l {
  fill: #f2bd3a;
}
.bag.r {
  fill: #cf9a22;
}
.band.l {
  fill: #e2483d;
}
.band.r {
  fill: #b93a31;
}
.fx circle {
  fill: #c9cdcb;
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
}
/* 两段的动作:一个循环里前 65% 画 pa、后 35% 画 pb(循环多长按动作定) */
.act-smoke {
  --cyc: 4.6s;
}
.act-drink {
  --cyc: 4s;
}
.act-snack {
  --cyc: 2.4s;
}
.pa {
  animation: seat-pa var(--cyc, 4s) step-end infinite;
}
.pb {
  animation: seat-pb var(--cyc, 4s) step-end infinite;
}
@keyframes seat-pa {
  0% {
    opacity: 1;
  }
  65%,
  100% {
    opacity: 0;
  }
}
@keyframes seat-pb {
  0% {
    opacity: 0;
  }
  65%,
  100% {
    opacity: 1;
  }
}
/* 烟头上一缕缕往上飘的烟 */
.fx.smoke circle {
  animation: seat-smoke 2.4s ease-out infinite;
}
.fx.smoke circle:nth-child(2) {
  animation-delay: 0.8s;
}
.fx.smoke circle:nth-child(3) {
  animation-delay: 1.6s;
}
@keyframes seat-smoke {
  0% {
    opacity: 0.75;
    transform: translate(0, 0) scale(0.6);
  }
  100% {
    opacity: 0;
    transform: translate(2px, -13px) scale(2.2);
  }
}
/* 吸完放下手吐一口:跟着循环,刚回到 pa 时冒出来 */
.fx.puff circle {
  animation: seat-puff var(--cyc, 4s) ease-out infinite;
}
@keyframes seat-puff {
  0% {
    opacity: 0.8;
    transform: translate(0, 0) scale(0.5);
  }
  45%,
  100% {
    opacity: 0;
    transform: translate(-2px, -10px) scale(1.7);
  }
}
/* 伸懒腰:两只手往上够一够 */
.reach {
  animation: seat-reach 1.5s ease-in-out infinite alternate;
}
@keyframes seat-reach {
  to {
    transform: translateY(-1.5px);
  }
}
.seat.online .led {
  fill: #4ee08f;
}
/* 网线:一条线路一根,颜色按面板;停用的灰色虚线;最近在线的线上有数据在流;不在这间房的画淡 */
.cable {
  fill: none;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.wire.off .cable {
  stroke-dasharray: 1.6 1.4;
}
.wire.dim {
  opacity: 0.18;
}
.flow {
  fill: none;
  stroke: #fff;
  stroke-width: 0.7;
  stroke-linecap: round;
  stroke-dasharray: 0.6 6;
  opacity: 0.9;
  animation: seat-flow 1.2s linear infinite;
}
@keyframes seat-flow {
  to {
    stroke-dashoffset: -6.6;
  }
}
.screen {
  fill: #0d1210;
}
.screen-text {
  fill: #4c5550;
  font-size: 9px;
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: central;
}
/* 不在线:冒 z */
.zzz text {
  fill: var(--ink-faint);
  font-size: 7px;
  font-weight: 700;
  animation: seat-zzz 3s ease-in-out infinite;
}
.zzz text + text {
  font-size: 9px;
  animation-delay: 1.5s;
}
@keyframes seat-zzz {
  0% {
    opacity: 0;
    transform: translateY(3px);
  }
  40%,
  60% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(-4px);
  }
}
/* 在线:屏幕亮,手在敲键盘 */
.seat.online .screen {
  fill: color-mix(in srgb, var(--av) 60%, #0d1210);
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--av) 85%, transparent));
}
.seat.online .screen-text {
  fill: #fff;
}
.seat.online .arm {
  animation: seat-type 0.45s steps(2) infinite;
}
@keyframes seat-type {
  50% {
    transform: translateY(-0.8px);
  }
}
/* 到期 / 超额:屏幕变红 */
.seat.expired .screen,
.seat.over_quota .screen {
  fill: #3d1616;
  filter: none;
}
.seat.expired .screen-text,
.seat.over_quota .screen-text {
  fill: #e0736b;
}

/* 名牌:编号、在线、名字、流量、到期、月费 */
.plate {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  margin-top: 6px;
  padding: 8px 10px 9px;
  border: 1px solid var(--rule);
  border-radius: 9px;
  container-type: inline-size;
  background: var(--sheet);
  box-shadow: var(--shadow);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.seat:hover .plate,
.seat.picked .plate {
  border-color: var(--accent);
  box-shadow: var(--lift);
}
.seat.expired .plate,
.seat.over_quota .plate {
  border-color: color-mix(in srgb, var(--fault) 40%, var(--rule));
}
.seat-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  line-height: 16px;
  color: var(--ink-faint);
}
.seat-no {
  font-family: var(--mono);
  letter-spacing: 0.04em;
}
.seat-lines {
  font-family: var(--font);
  letter-spacing: 0;
}
.seat-light {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.seat-light .seen-short {
  display: none;
}
/* 名牌窄的时候(比如一排六个)「3 小时前在线」放不下,只写「3 小时前」,悬停看全 */
@container (max-width: 179px) {
  .seat-light .seen-long {
    display: none;
  }
  .seat-light .seen-short {
    display: inline;
  }
}
/* 再窄(手机一排两个)一行放不下:编号和在线分两行,在线那行写全 */
@container (max-width: 149px) {
  .seat-top {
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
  }
  .seat-light .seen-long {
    display: inline;
  }
  .seat-light .seen-short {
    display: none;
  }
}
.seat-light i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--rule);
}
.seat.online .seat-light {
  color: var(--ok);
  font-weight: 500;
}
.seat.online .seat-light i {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-bg);
}
.seat-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.seat-name .nm {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 14px;
}
.seat-name .badge {
  flex: none;
}
.seat-use {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.seat-use .fig {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.seat-use .fig b {
  font-size: 13px;
  font-weight: 600;
}
.seat-use .meter {
  height: 4px;
  min-width: 0;
}
.seat-use .meter.no-quota {
  visibility: hidden;
}
.seat-foot {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px dashed var(--rule);
  font-size: 12px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@media (max-width: 420px) {
  .seat-foot {
    flex-direction: column;
    gap: 1px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .seat {
    transition: none;
  }
  .seat:hover:not(:disabled) {
    transform: none;
  }
  .zzz text,
  .seat.online .arm,
  .flow,
  .reach,
  .fx circle {
    animation: none;
  }
  .zzz text {
    opacity: 1;
  }
}
</style>
