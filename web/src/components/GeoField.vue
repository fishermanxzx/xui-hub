<script setup lang="ts">
// 出口规则的域名 / IP 框:旁边「浏览 geo 分类」打开 GeoBrowser 挑分类;
// 填的 geo 写法停手半秒后让面板按它自己的库核对,对不上的在框下面提示(照 3x-ui 的 GeoTokenInput)。
// 会让 Xray 起不来的(分类名写错、库不存在、写法不对、填错框)标红,保存时服务端也会拦;属性不存在只提醒。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api';
import { isGeoToken, parseTokens } from '../geoTokens';
import { t } from '../i18n';
import type { GeoIssue, GeoKind } from '../types';
import GeoBrowser from './GeoBrowser.vue';

const props = defineProps<{ modelValue: string; kind: GeoKind; panelId: number; panelName: string; label: string; placeholder?: string; multiline?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const browsing = ref(false);
const issues = ref<GeoIssue[]>([]);
const checkFailed = ref(false);
const id = `geo-${Math.random().toString(36).slice(2, 9)}`;
const value = computed({ get: () => props.modelValue, set: (v: string) => emit('update:modelValue', v) });

let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
watch(
  () => [props.modelValue, props.panelId] as const,
  ([v]) => {
    clearTimeout(timer);
    const tokens = parseTokens(v).filter(isGeoToken);
    const mine = ++seq;
    if (!tokens.length) {
      issues.value = [];
      checkFailed.value = false;
      return;
    }
    timer = setTimeout(async () => {
      try {
        const r = await api.geoValidate(props.panelId, props.kind, tokens);
        if (mine !== seq) return;
        issues.value = r.issues;
        checkFailed.value = false;
      } catch {
        // 核对没成功不等于都对,说一声
        if (mine !== seq) return;
        issues.value = [];
        checkFailed.value = true;
      }
    }, 600);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

function applyPicked(v: string) {
  emit('update:modelValue', v);
  browsing.value = false;
}

const FATAL = new Set(['syntax', 'fileMissing', 'categoryMissing', 'wrongKind']);
/** 按原因归组:每种原因一行 */
const groups = computed(() => {
  const by = new Map<string, string[]>();
  for (const x of issues.value) by.set(x.reason, [...(by.get(x.reason) ?? []), x.token]);
  return [...by].map(([reason, tokens]) => ({ reason, fatal: FATAL.has(reason), text: reasonText(reason, tokens.join(', ')) }));
});
function reasonText(reason: string, tokens: string): string {
  switch (reason) {
    case 'fileMissing':
      return t('geo.issueFileMissing', { tokens });
    case 'attributeMissing':
      return t('geo.issueAttributeMissing', { tokens });
    case 'syntax':
      return t('geo.issueSyntax', { tokens });
    case 'wrongKind':
      return t(props.kind === 'ip' ? 'geo.issueWrongKindIp' : 'geo.issueWrongKindSite', { tokens });
    default:
      return t('geo.issueCategoryMissing', { tokens });
  }
}
</script>

<template>
  <div class="geo-field">
    <div class="head">
      <label class="lbl" :for="id">{{ label }}</label>
      <button type="button" class="link small" @click="browsing = true">{{ t('geo.browse') }}</button>
    </div>
    <textarea v-if="multiline" :id="id" v-model="value" rows="2" spellcheck="false" :placeholder="placeholder" />
    <input v-else :id="id" v-model="value" spellcheck="false" :placeholder="placeholder" />
    <p v-for="g in groups" :key="g.reason" class="small hint" :class="g.fatal ? 'text-err' : 'text-warn'">{{ g.text }}</p>
    <p v-if="checkFailed" class="small hint muted">{{ t('geo.checkFailed') }}</p>
    <GeoBrowser
      v-if="browsing"
      :panel-id="panelId"
      :panel-name="panelName"
      :kind="kind"
      :value="modelValue"
      :separator="multiline ? '\n' : ', '"
      @apply="applyPicked"
      @close="browsing = false"
    />
  </div>
</template>

<style scoped>
.geo-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.lbl {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-soft);
}
.hint {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
