<script setup lang="ts">
// 节点链接二维码:在浏览器里生成,不经过第三方服务。客户端(Shadowrocket、v2rayN、Hiddify 等)扫码即可添加节点。
// 颜色固定为深色模块 + 白底(不跟随深色模式),否则不少扫码器认不出。
import qrcode from 'qrcode-generator';
import { computed } from 'vue';

const props = defineProps<{ text: string; name: string }>();

const DARK = '#0f2a33';
const QUIET = 4;

// 二维码按字节编码:非 ASCII 字符先转成 %XX(节点链接里 # 后的名字可能是中文)
const encoded = computed(() => props.text.replace(/[^\x00-\x7f]/g, (c) => encodeURIComponent(c)));

const matrix = computed(() => {
  const qr = qrcode(0, 'M');
  qr.addData(encoded.value);
  qr.make();
  const n = qr.getModuleCount();
  return { n, dark: (r: number, c: number) => qr.isDark(r, c) };
});

const svg = computed(() => {
  const { n, dark } = matrix.value;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) d += `M${c + QUIET},${r + QUIET}h1v1h-1z`;
  return { size: n + QUIET * 2, d };
});

/** 保存成 PNG(下面带名字),方便直接发出去 */
function save() {
  const { n, dark } = matrix.value;
  const cell = 8;
  const side = (n + QUIET * 2) * cell;
  const caption = 48;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side + caption;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = DARK;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) ctx.fillRect((c + QUIET) * cell, (r + QUIET) * cell, cell, cell);
  ctx.font = `600 22px Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(props.name, side / 2, side + 22);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `${props.name}.png`;
  a.click();
}
</script>

<template>
  <figure class="qr">
    <svg :viewBox="`0 0 ${svg.size} ${svg.size}`" role="img" :aria-label="`${name} 的二维码`" shape-rendering="crispEdges">
      <rect :width="svg.size" :height="svg.size" fill="#ffffff" />
      <path :d="svg.d" :fill="DARK" />
    </svg>
    <figcaption>
      <p>用客户端的扫码功能扫描，直接添加节点。</p>
      <button type="button" @click="save">保存图片</button>
    </figcaption>
  </figure>
</template>

<style scoped>
.qr {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 20px;
  margin: 0;
}
svg {
  width: 200px;
  height: 200px;
  border: 1px solid var(--rule);
  border-radius: 4px;
}
figcaption {
  flex: 1;
  min-width: 180px;
  max-width: 36ch;
  font-size: 12px;
  color: var(--ink-soft);
}
figcaption p {
  margin: 0 0 10px;
}
</style>
