<script setup lang="ts">
// 「日志」页:操作日志,新的在前;可按文字搜、只看某位客户、只看没成的;往下「加载更多」。
import { t } from '../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import Select, { type SelectOption } from '../components/Select.vue';
import { fmtDateTime } from '../format';
import { toastError } from '../toast';
import type { Customer, OpLog } from '../types';

const rows = ref<OpLog[]>([]);
const more = ref(false);
const loading = ref(false);
const loaded = ref(false);
const q = ref('');
const customerId = ref(0);
const failedOnly = ref(false);
const customers = ref<Customer[]>([]);
let seq = 0;

const customerOptions = computed<SelectOption<number>[]>(() => [
  { value: 0, label: t('oplog.allCustomers') },
  ...[...customers.value].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.name })),
]);
const filtering = computed(() => !!q.value.trim() || !!customerId.value || failedOnly.value);

/** reset = 从头读;否则接着上一页往后读 */
async function load(reset = true) {
  const mine = ++seq;
  loading.value = true;
  try {
    const before = reset ? undefined : rows.value[rows.value.length - 1]?.id;
    const r = await api.oplog({ before, q: q.value.trim() || undefined, customer_id: customerId.value || undefined, failed: failedOnly.value });
    if (mine !== seq) return;
    rows.value = reset ? r.rows : [...rows.value, ...r.rows];
    more.value = r.more;
    loaded.value = true;
  } catch (e) {
    if (mine === seq) toastError(e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

// 打字停 300 毫秒再搜
let timer: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 300);
});
watch([customerId, failedOnly], () => void load());
onMounted(async () => {
  void load();
  try {
    customers.value = await api.customers();
  } catch (e) {
    toastError(e);
  }
});
</script>

<template>
  <header class="page-head">
    <div class="ph-main">
      <h1>{{ t('oplog.title') }}</h1>
      <details class="about">
        <summary>{{ t('common.about') }}</summary>
        <p>{{ t('oplog.intro') }}</p>
      </details>
    </div>
  </header>

  <div class="filters">
    <input v-model="q" type="search" class="search" :placeholder="t('oplog.searchPlaceholder')" :aria-label="t('oplog.search')" />
    <Select v-model="customerId" :options="customerOptions" :aria-label="t('oplog.customerLabel')" />
    <label class="row small check"><input v-model="failedOnly" type="checkbox" />{{ t('oplog.failedOnly') }}</label>
    <span v-if="loading" class="muted small">{{ t('common.loading') }}</span>
  </div>

  <section class="sheet">
    <div class="table-wrap">
      <table class="log">
        <thead>
          <tr>
            <th>{{ t('oplog.colTime') }}</th>
            <th>{{ t('oplog.colActor') }}</th>
            <th>{{ t('oplog.colWhat') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ bad: !r.ok }">
            <td class="time" :title="new Date(r.at).toLocaleString()">{{ fmtDateTime(r.at) }}</td>
            <td>
              <div class="who">
                <span>{{ r.actor }}</span>
                <span v-if="r.ip" class="muted small">{{ r.ip }}</span>
              </div>
            </td>
            <td>
              <div class="what">
                <span>{{ r.summary }}</span>
                <span v-if="!r.ok" class="small text-err"><span class="badge err">{{ t('oplog.failed') }}</span> {{ r.error }}</span>
              </div>
            </td>
          </tr>
          <tr v-if="loaded && !rows.length">
            <td colspan="3" class="muted empty">{{ filtering ? t('oplog.emptyFiltered') : t('oplog.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <div v-if="more" class="row more">
    <button :disabled="loading" @click="load(false)">{{ t('oplog.more') }}</button>
  </div>
</template>

<style scoped>
.intro {
  max-width: 80ch;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.search {
  flex: 1 1 220px;
  max-width: 360px;
}
.check {
  gap: 6px;
}
.log td {
  vertical-align: top;
}
.time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.who,
.what {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.who {
  min-width: 7em;
}
.what {
  min-width: 14em;
  overflow-wrap: anywhere;
}
.badge {
  margin-right: 4px;
}
.empty {
  text-align: center;
  padding: 28px 16px;
}
.more {
  justify-content: center;
  margin-top: 14px;
}
/* 窄屏:每条一块,第一行时间和谁,下面是做了什么 */
@media (max-width: 640px) {
  .log thead {
    display: none;
  }
  .log tr {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .log td {
    padding: 0;
    border: none;
  }
  .log td:nth-child(3) {
    grid-column: 1 / -1;
  }
  .time {
    font-size: 12px;
    color: var(--ink-soft);
  }
  .who {
    flex-direction: row;
    gap: 8px;
    min-width: 0;
    font-size: 12px;
  }
  .what {
    min-width: 0;
  }
  .log td.empty {
    grid-column: 1 / -1;
    padding: 20px 0;
  }
}
</style>
