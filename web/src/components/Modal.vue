<script setup lang="ts">
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="overlay" @mousedown.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal sheet" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
      <header>
        <h2>{{ title }}</h2>
        <button class="link close" aria-label="关闭" @click="emit('close')">关闭</button>
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
  background: rgba(10, 30, 36, 0.5);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow-y: auto;
  z-index: 50;
}
.modal {
  width: 100%;
  max-width: 540px;
}
.modal.wide {
  max-width: 980px;
}
header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--rule);
}
h2 {
  flex: 1;
  font-size: 18px;
}
.close {
  color: var(--ink-soft);
}
.body {
  padding: 16px 20px;
}
footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--rule-soft);
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
