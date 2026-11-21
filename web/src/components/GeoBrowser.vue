<script setup lang="ts">
// geo 分类浏览器(照 3x-ui 3.7+ 的 geo 分类):读线路所在面板 Xray 目录里的 geo 库,
// 左边搜分类、勾选(分类多,只渲染看得见的几十行),右边看点开的分类里有哪些域名 / 网段(分页、过滤),
// 底下是已选;「应用」后写回规则的域名 / IP 框:框里原有的普通域名照留,浏览过的库里取消勾选的去掉。
// 数据都是面板现读(面板自己缓存索引),所以看到的就是这块面板 Xray 实际用的库。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { fmtBytes, fmtDateTime } from '../format';
import { canonicalToken, mergeSelection, selectionFromValue, tokenFor } from '../geoTokens';
import { t } from '../i18n';
import type { GeoCategory, GeoEntry, GeoFile, GeoKind } from '../types';
import Select, { type SelectOption } from './Select.vue';

const props = defineProps<{ panelId: number; panelName: string; kind: GeoKind; value: string; separator: string }>();
const emit = defineEmits<{ apply: [value: string]; close: [] }>();

const PAGE = 100;
const ROW_H = 34;
const OVERSCAN = 10;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- 库 ----------
const loadingFiles = ref(true);
const filesError = ref('');
const supported = ref(true);
const files = ref<GeoFile[]>([]);
const file = ref('');
// 只给这个框的那一类库:域名框只列 geosite 类,IP 框只列 geoip 类(填错类 Xray 起不来);解析失败的按文件名猜
const prefersKind = (name: string) => name.toLowerCase().includes('ip') === (props.kind === 'ip');
const usableFiles = computed(() => files.value.filter((f) => f.kind === props.kind || (f.error && prefersKind(f.name))));
const fileErrorText = (error: string) => (error.includes('too large') ? t('geo.tooLarge') : t('geo.parseFailed'));
const fileOptions = computed<SelectOption<string>[]>(() =>
  usableFiles.value.map((f) => ({ value: f.name, label: f.error ? `${f.name} — ${fileErrorText(f.error)}` : f.name, disabled: !!f.error })),
);
const activeFile = computed(() => files.value.find((f) => f.name === file.value));
const fileMeta = computed(() =>
  activeFile.value ? t('geo.fileMeta', { count: activeFile.value.categories.toLocaleString(), size: fmtBytes(activeFile.value.size), date: fmtDateTime(activeFile.value.modifiedAt) }) : '',
);

async function loadFiles() {
  loadingFiles.value = true;
  filesError.value = '';
  try {
    const r = await api.geoFiles(props.panelId);
    supported.value = r.supported;
    files.value = r.files ?? [];
  } catch (e) {
    filesError.value = errText(e);
  } finally {
    loadingFiles.value = false;
  }
  const ok = usableFiles.value.filter((f) => !f.error);
  const pick = ok.find((f) => f.name === (props.kind === 'ip' ? 'geoip.dat' : 'geosite.dat')) ?? ok[0];
  if (pick) void pickFile(pick.name);
}

// ---------- 分类 ----------
const catCache = new Map<string, GeoCategory[]>();
const categories = ref<GeoCategory[]>([]);
const loadingCats = ref(false);
const catsError = ref('');
const catQuery = ref('');
/** 浏览过的库里所有分类的写法(规范形式):应用时据此判断框里哪些项归浏览器管 */
const known = new Set<string>();
const seeded = new Set<string>();

function seed(name: string, items: GeoCategory[]) {
  if (seeded.has(name)) return;
  seeded.add(name);
  const tokens = new Set(items.map((c) => canonicalToken(tokenFor(name, c.code, props.kind))));
  for (const x of tokens) known.add(x);
  // 框里已经写了的分类先勾上
  const have = new Set(selected.value.map(canonicalToken));
  selected.value.push(...selectionFromValue(props.value, tokens).filter((x) => !have.has(canonicalToken(x))));
}

async function pickFile(name: string) {
  file.value = name;
  catQuery.value = '';
  preview('');
  const cached = catCache.get(name);
  if (cached) {
    categories.value = cached;
    return;
  }
  categories.value = [];
  catsError.value = '';
  loadingCats.value = true;
  try {
    const items = (await api.geoCategories(props.panelId, name)).items ?? [];
    catCache.set(name, items);
    seed(name, items);
    if (file.value === name) categories.value = items;
  } catch (e) {
    if (file.value === name) catsError.value = errText(e);
  } finally {
    if (file.value === name) loadingCats.value = false;
  }
}

const visible = computed(() => {
  const q = catQuery.value.trim().toLowerCase();
  return q ? categories.value.filter((c) => c.code.includes(q)) : categories.value;
});

// 分类列表只渲染看得见的行
const listEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewH = ref(440);
const windowed = computed(() => {
  const list = visible.value;
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN);
  const end = Math.min(list.length, Math.ceil((scrollTop.value + viewH.value) / ROW_H) + OVERSCAN);
  return { rows: list.slice(start, end), top: start * ROW_H, height: list.length * ROW_H };
});
function onScroll() {
  scrollTop.value = listEl.value?.scrollTop ?? 0;
}
watch(catQuery, () => {
  if (listEl.value) listEl.value.scrollTop = 0;
  scrollTop.value = 0;
});
let resize: ResizeObserver | null = null;
watch(listEl, (el) => {
  resize?.disconnect();
  if (!el) return;
  viewH.value = el.clientHeight || 440;
  resize = new ResizeObserver(() => (viewH.value = el.clientHeight || 440));
  resize.observe(el);
});

// ---------- 已选 ----------
const selected = ref<string[]>([]);
const selectedSet = computed(() => new Set(selected.value.map(canonicalToken)));
const tokenOf = (code: string) => tokenFor(file.value, code, props.kind);
const isPicked = (code: string) => selectedSet.value.has(canonicalToken(tokenOf(code)));
function toggle(code: string) {
  const token = tokenOf(code);
  const c = canonicalToken(token);
  if (selectedSet.value.has(c)) selected.value = selected.value.filter((x) => canonicalToken(x) !== c);
  else selected.value.push(token);
}
function selectFound() {
  const have = new Set(selectedSet.value);
  for (const cat of visible.value) {
    const token = tokenOf(cat.code);
    const c = canonicalToken(token);
    if (have.has(c)) continue;
    have.add(c);
    selected.value.push(token);
  }
}
const unpick = (token: string) => (selected.value = selected.value.filter((x) => x !== token));
const apply = () => emit('apply', mergeSelection(props.value, selected.value, known, props.separator));

// ---------- 条目预览 ----------
const active = ref('');
const entryQuery = ref('');
const entryFilter = ref('');
const page = ref(1);
const entries = ref<{ total: number; items: GeoEntry[] } | null>(null);
const loadingEntries = ref(false);
const entriesError = ref('');
let filterTimer: ReturnType<typeof setTimeout> | undefined;
const activeCat = computed(() => categories.value.find((c) => c.code === active.value));
const countLabel = computed(() =>
  activeCat.value ? t(props.kind === 'ip' ? 'geo.subnets' : 'geo.entries', { n: activeCat.value.entries.toLocaleString() }) : '',
);

function preview(code: string) {
  clearTimeout(filterTimer);
  entryQuery.value = '';
  entryFilter.value = '';
  page.value = 1;
  entries.value = null;
  entriesError.value = '';
  active.value = code;
}
// 过滤每次都要面板扫一遍库,停手半秒再查
watch(entryQuery, (v) => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    if (entryFilter.value === v.trim()) return;
    entryFilter.value = v.trim();
    page.value = 1;
  }, 500);
});
let entriesKey = '';
async function loadEntries() {
  if (!active.value || !file.value) return;
  const key = (entriesKey = `${file.value}|${active.value}|${entryFilter.value}|${page.value}`);
  loadingEntries.value = true;
  entriesError.value = '';
  try {
    const r = await api.geoEntries(props.panelId, file.value, active.value, entryFilter.value, (page.value - 1) * PAGE, PAGE);
    if (key === entriesKey) entries.value = { total: r.total ?? 0, items: r.items ?? [] };
  } catch (e) {
    if (key === entriesKey) entriesError.value = errText(e);
  } finally {
    if (key === entriesKey) loadingEntries.value = false;
  }
}
watch([active, entryFilter, page], () => void loadEntries());
const pages = computed(() => Math.max(1, Math.ceil((entries.value?.total ?? 0) / PAGE)));
const shownRange = computed(() => {
  const total = entries.value?.total ?? 0;
  if (!total) return '';
  const from = (page.value - 1) * PAGE + 1;
  return t('geo.shownRange', { from: from.toLocaleString(), to: Math.min(page.value * PAGE, total).toLocaleString(), total: total.toLocaleString() });
});

const searchEl = ref<HTMLInputElement | null>(null);
onMounted(async () => {
  await loadFiles();
  await nextTick();
  searchEl.value?.focus();
});
onBeforeUnmount(() => {
  clearTimeout(filterTimer);
  resize?.disconnect();
});
</script>

<template>
  <Teleport to="body">
    <div class="overlay geo-overlay" @mousedown.self="emit('close')" @keydown.esc="emit('close')">
      <div class="sheet geo" role="dialog" aria-modal="true" :aria-label="t('geo.title')">
        <header>
          <h2>{{ t('geo.title') }}</h2>
          <span class="muted small">{{ t(kind === 'ip' ? 'geo.forIp' : 'geo.forDomain', { panel: panelName }) }}</span>
          <span class="spacer" />
          <button type="button" class="link close" @click="emit('close')">{{ t('common.close') }}</button>
        </header>

        <div class="body">
          <p v-if="loadingFiles" class="muted state">{{ t('geo.loading') }}</p>
          <p v-else-if="filesError" class="state">
            <span class="text-err">{{ t('geo.loadFailed', { error: filesError }) }}</span>
            <button type="button" class="link" @click="loadFiles">{{ t('geo.retry') }}</button>
          </p>
          <div v-else-if="!supported" class="notice">{{ t('geo.unsupported', { panel: panelName }) }}</div>
          <div v-else-if="!usableFiles.length" class="empty">
            {{ t(kind === 'ip' ? 'geo.noIpFiles' : 'geo.noSiteFiles') }}<br />
            <span class="small">{{ t('geo.noFilesHint') }}</span>
          </div>
          <template v-else>
            <div class="toolbar">
              <Select class="db" :model-value="file" :options="fileOptions" :aria-label="t('geo.database')" @update:model-value="pickFile" />
              <input ref="searchEl" v-model="catQuery" class="search" type="search" spellcheck="false" :placeholder="t('geo.searchCategory')" :aria-label="t('geo.searchCategory')" />
              <button type="button" :disabled="!visible.length" @click="selectFound">{{ t('geo.selectFound', { n: visible.length.toLocaleString() }) }}</button>
              <span class="meta small muted">{{ fileMeta }}</span>
            </div>

            <div class="columns">
              <div class="panel cats">
                <p v-if="loadingCats" class="muted state">{{ t('geo.loading') }}</p>
                <p v-else-if="catsError" class="state text-err">{{ t('geo.loadFailed', { error: catsError }) }}</p>
                <p v-else-if="!visible.length" class="muted state">{{ t('geo.noMatches') }}</p>
                <div v-else ref="listEl" class="list" @scroll.passive="onScroll">
                  <div :style="{ height: `${windowed.height}px`, paddingTop: `${windowed.top}px` }">
                    <div v-for="c in windowed.rows" :key="c.code" class="cat" :class="{ active: c.code === active, picked: isPicked(c.code) }">
                      <input type="checkbox" :checked="isPicked(c.code)" :aria-label="tokenOf(c.code)" @change="toggle(c.code)" />
                      <button type="button" class="cat-main" :title="tokenOf(c.code)" @click="preview(c.code)">
                        <span class="code">{{ c.code }}</span>
                        <span v-for="a in c.attributes" :key="a" class="attr">{{ '@' + a }}</span>
                        <span class="spacer" />
                        <span class="count">{{ c.entries.toLocaleString() }}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="panel preview">
                <template v-if="active">
                  <div class="preview-head">
                    <span class="code title" :title="tokenOf(active)">{{ active }}</span>
                    <span class="muted small">{{ countLabel }}</span>
                    <input v-model="entryQuery" class="filter" type="search" spellcheck="false" :placeholder="t('geo.searchEntries')" :aria-label="t('geo.searchEntries')" />
                  </div>
                  <div class="entries">
                    <p v-if="entriesError" class="state text-err">{{ t('geo.loadFailed', { error: entriesError }) }}</p>
                    <p v-else-if="!entries && loadingEntries" class="muted state">{{ t('geo.loading') }}</p>
                    <p v-else-if="entries && !entries.items.length" class="muted state">{{ t('geo.noMatches') }}</p>
                    <ul v-else-if="entries" :class="{ dim: loadingEntries }">
                      <li v-for="(e, i) in entries.items" :key="i">
                        <span class="kind" :class="e.kind">{{ e.kind }}</span>
                        <span class="value">{{ e.value }}</span>
                      </li>
                    </ul>
                  </div>
                  <div class="pager small">
                    <span class="muted">{{ shownRange }}</span>
                    <span class="spacer" />
                    <button type="button" class="link" :disabled="page <= 1 || loadingEntries" @click="page--">{{ t('geo.prev') }}</button>
                    <span class="muted">{{ page }} / {{ pages }}</span>
                    <button type="button" class="link" :disabled="page >= pages || loadingEntries" @click="page++">{{ t('geo.next') }}</button>
                  </div>
                </template>
                <p v-else class="muted state center">{{ t('geo.pickCategory') }}</p>
              </div>
            </div>
          </template>
        </div>

        <footer>
          <div class="chosen">
            <span v-if="!selected.length" class="muted small">{{ t('geo.emptySelection') }}</span>
            <template v-else>
              <span v-for="x in selected" :key="x" class="chip token">
                {{ x }}
                <button type="button" class="link x" :aria-label="t('geo.unpick', { token: x })" @click="unpick(x)">×</button>
              </span>
            </template>
          </div>
          <div class="actions">
            <template v-if="selected.length">
              <span class="small muted">{{ t('geo.selected', { n: selected.length }) }}</span>
              <button type="button" class="link small" @click="selected = []">{{ t('geo.clearAll') }}</button>
            </template>
            <span class="spacer" />
            <button type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
            <button type="button" class="primary" :disabled="loadingFiles || !supported || !!filesError" @click="apply">{{ t('geo.apply') }}</button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.geo-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 30, 36, 0.5);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow-y: auto;
  z-index: 60;
}
.geo {
  width: 100%;
  max-width: 920px;
}
header {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--rule);
}
h2 {
  font-size: 18px;
}
.close {
  color: var(--ink-soft);
}
.body {
  padding: 16px 20px;
}
.state {
  padding: 12px;
  margin: 0;
}
.center {
  margin: auto;
  text-align: center;
}
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.toolbar .db {
  min-width: 200px;
}
.toolbar .search {
  flex: 1;
  min-width: 160px;
}
.meta {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.columns {
  display: grid;
  grid-template-columns: minmax(240px, 340px) minmax(0, 1fr);
  gap: 12px;
  height: 440px;
}
.panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--rule);
  border-radius: 8px;
  overflow: hidden;
}
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.list > div {
  box-sizing: border-box;
}
.cat {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding-left: 10px;
  border-bottom: 1px solid var(--rule-soft);
}
.cat.active {
  background: var(--accent-soft);
}
.cat-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: none;
  padding: 0 10px 0 0;
  text-align: left;
  font-weight: 400;
}
.cat-main:hover:not(:disabled) {
  background: none;
}
.cat:not(.active):hover {
  background: var(--hover);
}
.code,
.value,
.token {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attr {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--rule-soft);
  color: var(--ink-soft);
}
.count {
  flex: none;
  font-size: 12px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.preview-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--rule);
}
.preview-head .title {
  font-weight: 600;
  max-width: 50%;
}
.preview-head .filter {
  flex: 1;
  min-width: 140px;
  margin-left: auto;
}
.entries {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.entries ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.entries ul.dim {
  opacity: 0.5;
}
.entries li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--rule-soft);
}
.kind {
  flex: none;
  width: 60px;
  text-align: center;
  font-size: 11px;
  line-height: 18px;
  border-radius: 4px;
  background: var(--rule-soft);
  color: var(--ink-soft);
}
.kind.domain {
  background: var(--accent-soft);
  color: var(--patch);
}
.value {
  min-width: 0;
  overflow-wrap: anywhere;
}
.pager {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-top: 1px solid var(--rule);
  font-variant-numeric: tabular-nums;
}
footer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--rule-soft);
}
.chosen {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 96px;
  overflow-y: auto;
}
.token {
  font-size: 12px;
  background: var(--accent-soft);
  border-color: transparent;
}
.token .x {
  color: var(--ink-soft);
  padding: 0 2px;
  line-height: 1;
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 640px) {
  .geo-overlay {
    padding: 0;
  }
  .geo {
    min-height: 100%;
    border-radius: 0;
    border: none;
  }
  .columns {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 280px 320px;
    height: auto;
  }
  .meta {
    margin-left: 0;
    width: 100%;
  }
  .toolbar .db {
    min-width: 0;
    flex: 1;
  }
}
</style>
