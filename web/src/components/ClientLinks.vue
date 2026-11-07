<script setup lang="ts">
// 一个 client 的分享链接:逐条复制,点开看二维码。
import { ref } from 'vue';
import { copyText } from '../clipboard';
import QrCode from './QrCode.vue';

const props = defineProps<{ links: string[]; name: string }>();
const qr = ref<number | null>(props.links.length === 1 ? 0 : null);

const protocolOf = (link: string) => link.slice(0, link.indexOf('://'));
</script>

<template>
  <p v-if="!links.length" class="muted small">面板没有返回分享链接，去面板里检查这个 client。</p>
  <ul v-else class="links">
    <li v-for="(link, i) in links" :key="link">
      <div class="row link-row">
        <span class="chip">{{ protocolOf(link) }}</span>
        <input class="grow" readonly :value="link" aria-label="节点链接" @focus="($event.target as HTMLInputElement).select()" />
        <button class="primary" @click="copyText(link, '链接已复制')">复制</button>
        <button :aria-expanded="qr === i" @click="qr = qr === i ? null : i">{{ qr === i ? '收起' : '二维码' }}</button>
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
