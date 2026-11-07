<script setup lang="ts">
import { computed } from 'vue';
import { fmtBytes, usagePercent } from '../format';

const props = defineProps<{ used: number; quota: number }>();
const pct = computed(() => usagePercent(props.used, props.quota));
const level = computed(() => (props.quota > 0 && pct.value >= 100 ? 'full' : props.quota > 0 && pct.value >= 90 ? 'warn' : ''));
</script>

<template>
  <div class="usage">
    <div class="nums">
      <span class="figure">{{ fmtBytes(used) }}</span>
      <span class="muted">/ {{ quota > 0 ? fmtBytes(quota) : '不限' }}</span>
      <span v-if="quota > 0" class="pct" :class="{ 'text-warn': level === 'warn', 'text-err': level === 'full' }">{{ Math.floor(pct) }}%</span>
    </div>
    <div v-if="quota > 0" class="bar" :class="level"><span :style="{ width: pct + '%' }" /></div>
  </div>
</template>

<style scoped>
.usage {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
}
.nums {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 13px;
  white-space: nowrap;
}
.pct {
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-soft);
}
</style>
