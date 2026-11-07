<script setup lang="ts">
// 续费:没到期的从原到期日往后顺延,已到期的从今天算起;可选同时清零已用(新周期重新计量)。
// 这里的新到期日只是预览,以服务端算的为准(按服务端时区,默认 UTC+8)。
import { computed, ref } from 'vue';
import { api } from '../api';
import { fmtDate } from '../format';
import type { Customer, LineOpResult } from '../types';
import Modal from './Modal.vue';

const props = defineProps<{ customer: Customer }>();
const emit = defineEmits<{ close: []; done: [customer: Customer, lines: LineOpResult[]] }>();

const MONTHS = [1, 2, 3, 6, 12];
const months = ref(1);
const resetUsage = ref(true);
const busy = ref(false);
const error = ref('');

const expired = computed(() => props.customer.expire_at <= Date.now());

/** 加自然月,月底顺延到短月取最后一天,时间定在当天 23:59:59.999 */
const preview = computed(() => {
  const base = new Date(expired.value ? Date.now() : props.customer.expire_at);
  const day = base.getDate();
  const target = new Date(base.getFullYear(), base.getMonth() + months.value, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(day, last), 23, 59, 59, 999).getTime();
});

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const { customer, lines } = await api.renew(props.customer.id, months.value, resetUsage.value);
    emit('done', customer, lines);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="`给${customer.name}续费`" @close="emit('close')">
    <div class="form">
      <div class="months" role="radiogroup" aria-label="续费时长">
        <button
          v-for="m in MONTHS"
          :key="m"
          type="button"
          role="radio"
          :aria-checked="months === m"
          :class="{ on: months === m }"
          @click="months = m"
        >
          {{ m === 12 ? '1 年' : `${m} 个月` }}
        </button>
      </div>
      <p class="due">
        到期日 <span :class="{ 'text-err': expired }">{{ fmtDate(customer.expire_at) }}{{ expired ? '（已到期）' : '' }}</span>
        → <span class="figure">{{ fmtDate(preview) }}</span>
      </p>
      <p class="muted small">{{ expired ? '已经到期，从今天算起。' : '从原到期日往后顺延。' }}</p>
      <label class="row small reset">
        <input v-model="resetUsage" type="checkbox" />
        同时清零已用：新周期重新计量，各面板上这位客户线路的流量也清零（每日流量历史保留）
      </label>
      <div v-if="error" class="notice">{{ error }}</div>
    </div>
    <template #footer>
      <span class="spacer" />
      <button @click="emit('close')">取消</button>
      <button class="primary" :disabled="busy" @click="submit">{{ busy ? '续费中…' : '续费' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.months {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.months button.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}
.due {
  margin: 4px 0 0;
  font-size: 15px;
}
.due + p {
  margin: 0;
}
.reset {
  align-items: flex-start;
  flex-wrap: nowrap;
  margin-top: 4px;
}
.reset input {
  margin-top: 2px;
  flex: none;
}
</style>
