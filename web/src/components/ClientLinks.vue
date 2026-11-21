<script setup lang="ts">
// 一个 client 的分享链接:逐条复制,点开看二维码。
import { t } from '../i18n';
import { ref } from 'vue';
import { copyText } from '../clipboard';
import QrCode from './QrCode.vue';

// collapsed:只有一条链接时也不自动展开二维码(一次列出好几条线路时用)
const props = defineProps<{ links: string[]; name: string; collapsed?: boolean }>();
const qr = ref<number | null>(props.links.length === 1 && !props.collapsed ? 0 : null);

const protocolOf = (link: string) => link.slice(0, link.indexOf('://'));
</script>

<template>
  <p v-if="!links.length" class="muted small">{{ t('links.none') }}</p>
  <ul v-else class="links">
    <li v-for="(link, i) in links" :key="link">
      <div class="row link-row">
        <span class="chip">{{ protocolOf(link) }}</span>
        <input class="grow" readonly :value="link" :aria-label="t('links.aria')" @focus="($event.target as HTMLInputElement).select()" />
        <button class="primary" @click="copyText(link, t('links.copied'))">{{ t('common.copy') }}</button>
        <button :aria-expanded="qr === i" @click="qr = qr === i ? null : i">{{ qr === i ? t('links.collapse') : t('links.qr') }}</button>
      </div>
      <QrCode v-if="qr === i" class="qr" :text="link" :name="name" />
    </li>
  </ul>
</template>

<style scoped>
.links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.link-row {
  gap: 8px;
}
.link-row input {
  min-width: 0;
  font-size: 12px;
}
.grow {
  flex: 1;
}
.qr {
  margin-top: 10px;
}
</style>
