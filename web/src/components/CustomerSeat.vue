<script setup lang="ts">
// 客户页「机房」里的一个机位:一张桌子一台电脑(等距 3D 小场景,见 seatScene.ts),小人坐在那儿;
// 在线坐着打字、屏幕亮,不在线趴着睡觉;下面一块名牌写编号、在线、名字、流量、到期、月费。点了发 open。
import { t } from '../i18n';
import { dueLevel, fmtBytes, fmtCost, fmtDue, stateLabel } from '../format';
import { SCENE_SLEEP, SCENE_WORK, SCREEN_TEXT_TRANSFORM, SEAT_VIEWBOX, ZZZ } from '../seatScene';
import type { Customer } from '../types';

defineProps<{
  customer: Customer;
  /** 这间房里算在线(分房时按这间房的线路算) */
  online: boolean;
  /** 正在弹窗里看的那位 */
  picked: boolean;
  /** 用量条:'' / 'warn' / 'full' 和百分比 */
  meter: string;
  pct: number;
}>();
defineEmits<{ open: [] }>();

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
    <svg class="scene" :viewBox="SEAT_VIEWBOX" aria-hidden="true">
      <template v-for="(f, i) in online ? SCENE_WORK : SCENE_SLEEP" :key="i">
        <text v-if="f.text" class="screen-text" :transform="SCREEN_TEXT_TRANSFORM">{{ avatarText(customer.name) }}</text>
        <polygon v-else :class="f.cls" :points="f.pts" />
      </template>
      <g v-if="!online" class="zzz">
        <text v-for="(z, i) in ZZZ" :key="i" :x="z.x" :y="z.y">z</text>
      </g>
    </svg>
    <span class="plate">
      <span class="seat-top">
        <span class="seat-no">#{{ seatNo(customer.id) }}</span>
        <span class="seat-light"><i aria-hidden="true" />{{ online ? t('customers.seatOnline') : t('customers.seatOffline') }}</span>
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
.seat-light {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
  .seat.online .arm {
    animation: none;
  }
  .zzz text {
    opacity: 1;
  }
}
</style>
