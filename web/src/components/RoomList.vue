<script setup lang="ts">
// 机房里的一间间房:门牌(房号、名字、在哪、几位客户 / 几位在线)+ 房里一人一台电脑。
// 大厅(客户页)不画门牌。面板连不上 / SOCKS 测试不通的房间关灯。点了哪位发 open(客户 id)。
import { t } from '../i18n';
import CustomerSeat from './CustomerSeat.vue';
import type { Room } from '../rooms';

withDefaults(defineProps<{ rooms: Room[]; header?: boolean; picked?: number | null; warnPct?: number }>(), { header: true, picked: null, warnPct: 80 });
defineEmits<{ open: [id: number] }>();
</script>

<template>
  <div class="rooms">
    <section v-for="r in rooms" :id="`room-${r.key}`" :key="r.key" class="room" :class="{ down: r.down }">
      <header v-if="header" class="room-head">
        <span class="room-sign"><span v-if="r.no" class="room-no">{{ r.no }}</span>{{ r.name }}</span>
        <span v-if="r.where" class="muted small">{{ r.where }}</span>
        <span v-if="r.down" class="badge err">{{ r.down }}</span>
        <span class="room-count small">
          {{ t('rooms.customers', { n: r.seats.length }, r.seats.length) }}
          <span v-if="r.online" class="text-ok"> · {{ t('rooms.online', { n: r.online }) }}</span>
        </span>
      </header>
      <div v-if="r.seats.length" class="seats">
        <CustomerSeat
          v-for="seat in r.seats"
          :key="seat.c.id"
          :customer="seat.c"
          :online="seat.online"
          :picked="picked === seat.c.id"
          :warn-pct="warnPct"
          :line-in="r.lineIn"
          @open="$emit('open', seat.c.id)"
        />
      </div>
      <p v-else class="room-empty muted small">{{ r.empty }}</p>
    </section>
  </div>
</template>

<style scoped>
.rooms {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.room {
  border: 1px solid var(--rule);
  border-radius: 12px;
  background: var(--sunk);
  overflow: hidden;
}
/* 门牌:房号、房名、在哪、几位客户 / 几位在线 */
.room-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--rule);
  background: var(--sheet);
}
.room-sign {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.room-no {
  padding: 0 6px;
  border-radius: 4px;
  background: #1f2622;
  color: #e9efe9;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 20px;
  letter-spacing: 0.05em;
}
.room-count {
  margin-left: auto;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.room-empty {
  margin: 0;
  padding: 18px 14px;
}
/* 面板连不上 / SOCKS 测试不通:这间房关灯(名牌照常看得清) */
.room.down .seats :deep(.scene) {
  filter: grayscale(0.75) brightness(0.6);
}
.room.down .room-sign {
  color: var(--fault);
}
/* 房里的地面 */
.seats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 18px 14px;
  padding: 16px 14px 18px;
}
@media (max-width: 420px) {
  .seats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 8px;
    padding: 12px 8px 14px;
  }
}
</style>
