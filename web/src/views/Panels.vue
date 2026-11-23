<script setup lang="ts">
// 面板页:每块面板一张卡片,展开看入站和客户端;添加 / 编辑面板用弹窗。
import { t } from '../i18n';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import PanelCard from '../components/PanelCard.vue';
import { costSummary, dateInputToMs, fmtBytes, fmtCost, msToDateInput } from '../format';
import { toast, toastError } from '../toast';
import type { Panel, PanelInput } from '../types';

const panels = ref<Panel[]>([]);
const checking = ref(false);
const summary = computed(() => costSummary(panels.value));

/** 展开的卡片,记在浏览器里,刷新后保持 */
const OPEN_KEY = 'xui-hub.openPanels';
const open = ref<Set<number>>(new Set());
try {
  open.value = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]'));
} catch {
  /* 忽略坏数据 */
}
function toggle(id: number) {
  const next = new Set(open.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  open.value = next;
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
  } catch {
    /* 存不了就算了 */
  }
}

async function load() {
  try {
    panels.value = await api.panels();
    // 没有面板再带的标签不再选着
    pickedTags.value = pickedTags.value.filter((x) => panels.value.some((p) => p.tags?.includes(x)));
    // 只有一块面板时默认展开
    if (panels.value.length === 1 && !open.value.size) toggle(panels.value[0].id);
  } catch (e) {
    toastError(e);
  }
}

async function checkAll() {
  checking.value = true;
  try {
    panels.value = await api.checkPanels();
    const failed = panels.value.filter((p) => p.check_error).length;
    toast(failed ? t('panels.someDown', { n: failed }) : t('panels.allOk'), failed ? 'err' : 'ok');
  } catch (e) {
    toastError(e);
  } finally {
    checking.value = false;
  }
}

// ---------- 新增 / 编辑 ----------
const editing = ref<Panel | null>(null);
const showForm = ref(false);
const saving = ref(false);
const form = ref({ name: '', base_url: '', token: '', cost: '', expire: '', nodeName: '', tags: '', ratio: '1' });
/** 表单里填的标签(逗号 / 空格分开) */
const splitTags = (s: string) => [...new Set(s.split(/[,,\s]+/).map((x) => x.trim()).filter(Boolean))];
/** 别的面板用过、这里还没填的标签,点一下加上 */
const tagSuggestions = computed(() => {
  const have = new Set(splitTags(form.value.tags));
  return allTags.value.filter((x) => !have.has(x));
});
function addTag(tag: string) {
  form.value.tags = [...splitTags(form.value.tags), tag].join(', ');
}

// ---------- 按标签筛面板 ----------
/** 所有面板用到的标签(按出现先后) */
const allTags = computed(() => [...new Set(panels.value.flatMap((p) => p.tags ?? []))]);
const pickedTags = ref<string[]>([]);
function toggleTag(tag: string) {
  pickedTags.value = pickedTags.value.includes(tag) ? pickedTags.value.filter((x) => x !== tag) : [...pickedTags.value, tag];
}
/** 选了标签:带其中任一个的面板 */
const shownPanels = computed(() => (pickedTags.value.length ? panels.value.filter((p) => p.tags?.some((x) => pickedTags.value.includes(x))) : panels.value));

function openForm(panel: Panel | null) {
  editing.value = panel;
  form.value = { name: panel?.name ?? '', base_url: panel?.base_url ?? '', token: '', cost: panel?.monthly_cost == null ? '' : String(panel.monthly_cost), expire: msToDateInput(panel?.expire_at ?? 0), nodeName: panel?.node_name ?? '', tags: (panel?.tags ?? []).join(', '), ratio: String(panel?.traffic_ratio ?? 1) };
  showForm.value = true;
}

async function submit() {
  // 到期日没动就原样发回(表单里只有日期,重算会把到期时刻改成当天 23:59)
  const was = editing.value;
  const expireAt = was && form.value.expire === msToDateInput(was.expire_at) ? was.expire_at : dateInputToMs(form.value.expire);
  const ratio = form.value.ratio === '' ? 1 : Number(form.value.ratio);
  const body: PanelInput = { name: form.value.name, base_url: form.value.base_url, monthly_cost: form.value.cost === '' ? null : Number(form.value.cost), expire_at: expireAt, node_name: form.value.nodeName.trim(), tags: splitTags(form.value.tags), traffic_ratio: ratio };
  if (form.value.token) body.token = form.value.token;
  saving.value = true;
  try {
    // 改倍率:这块面板上的客户本期已用会当场按新倍率重算,先算出谁会超额,确认了再存
    if (was && ratio !== was.traffic_ratio && was.line_count && !(await confirmRatio(was, ratio))) return;
    const saved = editing.value ? await api.updatePanel(editing.value.id, body) : await api.createPanel(body);
    showForm.value = false;
    toast(saved.check_error ? t('panels.savedButDown', { error: saved.check_error }) : t('panels.savedOk'), saved.check_error ? 'err' : 'ok');
    await load();
    if (!editing.value && !saved.check_error) toggle(saved.id);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function confirmRatio(panel: Panel, ratio: number): Promise<boolean> {
  const p = await api.panelRatioPreview(panel.id, ratio);
  const over = p.customers.filter((c) => c.over_after && !c.over_before);
  const lines = [
    t('panels.ratioConfirm', { name: panel.name, from: p.ratio_before, to: p.ratio, n: p.customers.length }),
    '',
    ...p.customers.slice(0, 12).map((c) => t('panels.ratioRow', { name: c.name, before: fmtBytes(c.used_before), after: fmtBytes(c.used_after), quota: c.quota_bytes ? fmtBytes(c.quota_bytes) : t('customers.unlimited').trim() }) + (c.over_after && !c.over_before ? ` ← ${t('panels.ratioOver')}` : c.over_after ? ` (${t('panels.ratioAlreadyOver')})` : '')),
    ...(p.customers.length > 12 ? [t('panels.ratioMore', { n: p.customers.length - 12 })] : []),
    '',
    over.length ? t('panels.ratioOverSummary', { n: over.length, names: over.map((c) => c.name).join('、') }) : t('panels.ratioNoneOver'),
  ];
  return confirm(lines.join('\n'));
}

async function remove(panel: Panel) {
  const notes = [
    panel.line_count ? t('panels.deleteLines', { n: panel.line_count }) : '',
    panel.exit_line_count ? t('panels.deleteExits', { n: panel.exit_line_count }) : '',
  ].filter(Boolean);
  if (!confirm(t('panels.confirmDelete', { name: panel.name }) + (notes.length ? `\n\n${notes.join('\n')}` : ''))) return;
  try {
    await api.deletePanel(panel.id, panel.line_count > 0);
    toast(t('panels.deleted'));
    await load();
  } catch (e) {
    toastError(e);
  }
}

let timer: number | undefined;
onMounted(() => {
  void load();
  timer = window.setInterval(load, 30_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>{{ t('panels.title') }}</h2>
      <p class="muted small">{{ t('panels.intro') }}</p>
      <p v-if="panels.length" class="small summary">
        <span>{{ t('cost.total', { total: fmtCost(summary.total) }) }}</span>
        <span v-if="summary.unset" class="muted">{{ t('cost.unset', { n: summary.unset }) }}</span>
        <span v-if="summary.soon" class="text-warn">{{ t('cost.soon', { n: summary.soon }) }}</span>
        <span v-if="summary.overdue" class="text-err">{{ t('cost.overdue', { n: summary.overdue }) }}</span>
      </p>
    </div>
    <div class="row">
      <button :disabled="checking || !panels.length" @click="checkAll">{{ checking ? t('panels.checking') : t('panels.checkAll') }}</button>
      <button class="primary" @click="openForm(null)">{{ t('panels.add') }}</button>
    </div>
  </div>

  <div v-if="allTags.length" class="tag-filter small" role="group" :aria-label="t('panels.filterTags')">
    <span class="muted">{{ t('panels.filterTags') }}</span>
    <button type="button" class="tag-btn" :aria-pressed="!pickedTags.length" @click="pickedTags = []">{{ t('panels.allTags') }}</button>
    <button v-for="tag in allTags" :key="tag" type="button" class="tag-btn" :aria-pressed="pickedTags.includes(tag)" @click="toggleTag(tag)">
      {{ tag }} <span class="muted">{{ panels.filter((p) => p.tags?.includes(tag)).length }}</span>
    </button>
    <span v-if="pickedTags.length" class="muted">{{ t('panels.shown', { n: shownPanels.length, total: panels.length }) }}</span>
  </div>

  <div class="cards">
    <PanelCard v-for="p in shownPanels" :key="p.id" :panel="p" :open="open.has(p.id)" :picked-tags="pickedTags" @toggle="toggle(p.id)" @edit="openForm(p)" @remove="remove(p)" @changed="load" @tag="toggleTag" />
  </div>
  <div v-if="!panels.length" class="empty sheet">{{ t('panels.empty') }}</div>

  <Modal v-if="showForm" :title="editing ? t('panels.editTitle', { name: editing.name }) : t('panels.add')" @close="showForm = false">
    <form id="panel-form" class="form" @submit.prevent="submit">
      <label class="field">{{ t('panels.name') }}<input v-model="form.name" required :placeholder="t('panels.namePlaceholder')" /></label>
      <label class="field">{{ t('panels.baseUrl') }}<input v-model="form.base_url" required placeholder="https://1.2.3.4:2053/path" /></label>
      <label class="field">
        {{ t('panels.token') }}{{ editing ? t('panels.keepBlank') : '' }}
        <input v-model="form.token" type="password" autocomplete="off" :required="!editing" />
      </label>
      <label class="field">{{ t('panels.nodeName') }}<input v-model="form.nodeName" maxlength="64" :placeholder="t('panels.nodeNamePlaceholder')" /></label>
      <p class="muted small hint node-hint">{{ t('panels.nodeNameHint') }}</p>
      <label class="field">{{ t('panels.tags') }}<input v-model="form.tags" :placeholder="t('panels.tagsPlaceholder')" /></label>
      <p class="muted small hint node-hint">
        {{ t('panels.tagsHint') }}
        <template v-if="tagSuggestions.length">
          <br />{{ t('panels.tagsUsed') }}
          <button v-for="tag in tagSuggestions" :key="tag" type="button" class="tag-btn" @click="addTag(tag)">+ {{ tag }}</button>
        </template>
      </p>
      <div class="two">
        <label class="field">{{ t('cost.field') }}<input v-model="form.cost" type="number" min="0" step="0.01" /></label>
        <label class="field">{{ t('cost.expireField') }}<input v-model="form.expire" type="date" /></label>
      </div>
      <label class="field">{{ t('panels.trafficRatio') }}<input v-model="form.ratio" type="number" min="0.01" max="100" step="0.01" :title="t('panels.ratioHint')" /></label>
      <p class="muted small hint node-hint">{{ t('panels.ratioHint') }}</p>
      <p class="muted small hint">{{ t('panels.hint') }} {{ t('cost.hint') }}</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">{{ t('common.cancel') }}</button>
      <button class="primary" form="panel-form" :disabled="saving">{{ saving ? t('panels.savingCheck') : t('common.save') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
h2 {
  font-size: 18px;
}
.toolbar p {
  margin: 4px 0 0;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hint {
  margin: 0;
}
.node-hint {
  margin-top: -6px;
}
.tag-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}
.tag-btn {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 20px;
}
.tag-btn[aria-pressed='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}
.node-hint .tag-btn {
  margin: 4px 4px 0 0;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}
</style>
