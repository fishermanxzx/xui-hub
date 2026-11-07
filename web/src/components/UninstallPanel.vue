<script setup lang="ts">
// 卸载面板:先列出会删掉的客户线路(这台面板上的;落地机还包括其他面板上出口全部经过它的),确认后执行。
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import type { LineDeleteResult, Panel, UninstallLine, UninstallPlan } from '../types';
import Modal from './Modal.vue';

const props = defineProps<{ panel: Panel }>();
const emit = defineEmits<{ close: []; done: [] }>();

const plan = ref<UninstallPlan | null>(null);
const error = ref('');
const running = ref(false);
const results = ref<LineDeleteResult[] | null>(null);

onMounted(async () => {
  try {
    plan.value = await api.uninstallPlan(props.panel.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});

const total = computed(() => (plan.value ? plan.value.direct.length + plan.value.through.length : 0));
const failed = computed(() => (results.value ?? []).filter((r) => !r.ok));

async function run() {
  running.value = true;
  error.value = '';
  try {
    results.value = (await api.uninstallPanel(props.panel.id)).results;
    emit('done');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    running.value = false;
  }
}

const groups = computed(() => {
  const p = plan.value;
  if (!p) return [];
  return [
    { key: 'direct', title: `这台面板上的客户线路(${p.direct.length})`, lines: p.direct, showPanel: false },
    { key: 'through', title: `其他面板上出口全部经过这台的客户线路(${p.through.length})`, lines: p.through, showPanel: true },
  ].filter((g) => g.lines.length);
});
const lineText = (l: UninstallLine, showPanel: boolean) => (showPanel ? `${l.panel_name} · ${l.email}` : l.email);
</script>

<template>
  <Modal :title="`卸载面板「${panel.name}」`" wide @close="emit('close')">
    <div v-if="error" class="notice">{{ error }}</div>

    <template v-if="results">
      <p :class="failed.length ? 'text-err' : 'text-ok'">
        已卸载：删除并解绑 {{ results.length }} 条客户线路，面板已从系统移除。
      </p>
      <template v-if="failed.length">
        <p class="small">以下 client 没能在面板上删掉（线路已解绑，面板恢复后可以到面板上手动删）：</p>
        <ul class="small fails">
          <li v-for="r in failed" :key="r.panel + r.email">{{ r.panel }} · {{ r.email }}：{{ r.error }}</li>
        </ul>
      </template>
    </template>

    <div v-else-if="!plan && !error" class="empty">正在列出受影响的客户线路…</div>

    <template v-else-if="plan">
      <p v-if="!total" class="small">没有客户线路在这台面板上，卸载只会把它从系统移除，面板本身不受影响。</p>
      <template v-else>
        <p class="small">卸载会：</p>
        <ol class="small steps">
          <li>在面板上删除下面 {{ total }} 条客户线路的 client，并从客户那里解绑（面板连不上也照样解绑，结果里会列出没删掉的）；</li>
          <li v-if="plan.through.length">其他面板上转到这台的入站和路由不动，之后可以在那些面板上清理；</li>
          <li>把面板从系统移除：不再同步，月成本不再计入，它的配置快照一起删除（每天的数据库备份里还有）。</li>
        </ol>
        <section v-for="g in groups" :key="g.key" class="group">
          <h4>{{ g.title }}</h4>
          <div class="chips">
            <span v-for="l in g.lines" :key="l.binding_id" class="chip">
              <b>{{ l.customer_name }}</b><span class="muted">{{ lineText(l, g.showPanel) }}</span>
            </span>
          </div>
        </section>
      </template>
      <section v-if="plan.partial.length" class="group">
        <h4>只有部分出口经过这台，不会删除（{{ plan.partial.length }}）</h4>
        <div class="chips">
          <span v-for="l in plan.partial" :key="l.binding_id" class="chip">
            <b>{{ l.customer_name }}</b><span class="muted">{{ l.panel_name }} · {{ l.email }}</span>
          </span>
        </div>
      </section>
    </template>

    <template #footer>
      <span class="spacer" />
      <template v-if="results">
        <button class="primary" @click="emit('close')">关闭</button>
      </template>
      <template v-else>
        <button @click="emit('close')">取消</button>
        <button class="danger-btn" :disabled="!plan || running" @click="run">
          {{ running ? '卸载中…' : total ? `删除 ${total} 条线路并卸载` : '卸载' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.steps {
  margin: 4px 0 12px;
  padding-left: 20px;
  line-height: 1.7;
}
.group {
  margin-top: 12px;
}
h4 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip b {
  font-weight: 500;
}
.fails {
  padding-left: 20px;
  line-height: 1.7;
}
.danger-btn {
  background: var(--fault);
  border-color: var(--fault);
  color: #fff;
}
.danger-btn:hover:not(:disabled) {
  background: var(--fault);
  opacity: 0.9;
}
</style>
