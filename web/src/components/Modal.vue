<script setup lang="ts">
import { t } from '../i18n';
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <!-- Esc 不往外冒:弹窗里再开一个弹窗时,按 Esc 只关里面这个 -->
  <div class="overlay" @mousedown.self="emit('close')" @keydown.esc.stop="emit('close')">
    <div class="modal sheet" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
      <header>
        <h2>{{ title }}</h2>
        <button class="link close" :aria-label="t('common.close')" @click="emit('close')">{{ t('common.close') }}</button>
      </header>
      <div class="body">
        <slot />
      </div>
      <footer v-if="$slots.footer">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(17, 22, 19, 0.46);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 16px;
  overflow-y: auto;
  z-index: 50;
}
.modal {
  width: 100%;
  max-width: 560px;
  box-shadow: var(--lift);
}
.modal.wide {
  max-width: 980px;
}
header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 16px 20px 14px;
  border-bottom: 1px solid var(--rule-soft);
}
h2 {
  flex: 1;
  font-size: 17px;
  line-height: 24px;
}
.close {
  font-size: 13px;
}
.body {
  padding: 18px 20px;
}
footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--rule-soft);
  border-radius: 0 0 10px 10px;
  background: var(--sunk);
}
footer :deep(.spacer) {
  flex: 1;
}
@media (max-width: 640px) {
  .overlay {
    padding: 0;
  }
  .modal {
    min-height: 100%;
    border-radius: 0;
    border: none;
  }
}
</style>
