<script setup lang="ts">
// 面板页 / SOCKS 页上展开的地球那一块:地球 + 下面一行汇总(几个、几个地点、遍布哪些地区)、还没定位的清单、位置从哪来的说明。
// 地球(three.js)很大,展开时才加载。
import { computed, defineAsyncComponent } from 'vue';
import { locale, t } from '../i18n';
import { regionsOf, type GlobePoint } from '../geoRegions';

const WorldGlobe = defineAsyncComponent(() => import('./WorldGlobe.vue'));

const props = defineProps<{
  points: GlobePoint[];
  /** 还没定位的:名字和原因 */
  unlocated: { id: number; name: string; reason: string }[];
  /** 正在按 IP 查位置 */
  locating: boolean;
  /** 汇总、说明、读屏说明的文案 key(参数 n / spots) */
  summaryKey: string;
  sourceKey: string;
  labelKey: string;
}>();
const emit = defineEmits<{ pick: [id: number] }>();

const spots = computed(() => new Set(props.points.map((p) => `${Math.round(p.lat * 2)}:${Math.round(p.lng * 2)}`)).size);
const regions = computed(() => regionsOf(props.points, locale.value));
</script>

<template>
  <section class="globe-block sheet">
    <WorldGlobe :points="points" :label="t(labelKey, { n: points.length })" @pick="(id) => emit('pick', id)" />
    <div class="globe-foot small">
      <span>{{ t(summaryKey, { n: points.length, spots }) }}</span>
      <span v-if="regions.length" class="regions">
        <span class="muted">{{ t('globe.regions') }}</span>
        <span v-for="r in regions" :key="r.name" class="region">{{ r.name }} <b>{{ r.n }}</b></span>
      </span>
      <span v-if="locating" class="muted">{{ t('globe.locating') }}</span>
      <details v-else-if="unlocated.length" class="unlocated">
        <summary class="text-warn">{{ t('globe.unlocated', { n: unlocated.length }) }}</summary>
        <ul>
          <li v-for="u in unlocated" :key="u.id">
            <button type="button" class="link" @click="emit('pick', u.id)">{{ u.name }}</button>
            <span class="muted">{{ u.reason || t('globe.notYet') }}</span>
          </li>
        </ul>
      </details>
      <span class="muted src">{{ t(sourceKey) }}</span>
    </div>
  </section>
</template>

<style scoped>
.globe-block {
  padding: 10px;
  margin-bottom: 14px;
}
.globe-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  align-items: baseline;
  padding: 10px 4px 2px;
}
.regions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
.region b {
  font-weight: 600;
  color: var(--accent-strong);
}
.unlocated summary {
  cursor: pointer;
}
.unlocated[open],
.src {
  flex-basis: 100%;
}
.unlocated ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.unlocated li {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 2px 0;
}
</style>
