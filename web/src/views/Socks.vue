<script setup lang="ts">
// SOCKS 页:登记购买的 SOCKS5 代理,测连通性(出口 IP / 地区 / 延迟),给客户页的中转当出口用。
import { onMounted, ref } from 'vue';
import { api } from '../api';
import Modal from '../components/Modal.vue';
import { fmtAgo, region } from '../format';
import { toast, toastError } from '../toast';
import type { Socks, SocksInput } from '../types';

const list = ref<Socks[]>([]);
const checkingAll = ref(false);
const checking = ref(new Set<number>());

async function load() {
  try {
    list.value = await api.socks();
  } catch (e) {
    toastError(e);
  }
}
onMounted(load);

async function checkOne(s: Socks) {
  checking.value.add(s.id);
  try {
    const updated = await api.checkSocks(s.id);
    Object.assign(s, updated);
    if (updated.check?.ok) toast(`「${s.name}」可用,延迟 ${updated.check.ms} ms,出口 ${updated.check.ip ?? '未知'} ${region(updated.check.loc)}`);
    else toast(`「${s.name}」${updated.check?.error ?? '测试失败'}`, 'err');
  } catch (e) {
    toastError(e);
  } finally {
    checking.value.delete(s.id);
  }
}

async function checkAll() {
  checkingAll.value = true;
  try {
    list.value = await api.checkAllSocks();
    const bad = list.value.filter((s) => !s.check?.ok).length;
    toast(`测试完成:${list.value.length - bad} 个可用,${bad} 个失败`, bad ? 'err' : 'ok');
  } catch (e) {
    toastError(e);
  } finally {
    checkingAll.value = false;
  }
}

// ---------- 新增 / 编辑 ----------
const editing = ref<Socks | null>(null);
const showForm = ref(false);
const saving = ref(false);
const form = ref({ name: '', address: '', remark: '' });

function openForm(s: Socks | null) {
  editing.value = s;
  form.value = { name: s?.name ?? '', address: '', remark: s?.remark ?? '' };
  showForm.value = true;
}

async function submit() {
  const body: SocksInput = { name: form.value.name, remark: form.value.remark };
  if (form.value.address.trim()) body.address = form.value.address.trim();
  const used = editing.value?.used_by ?? 0;
  if (body.address && used && !confirm(`有 ${used} 条线路在用这个 SOCKS:改地址会把这些中转面板上的出口一起改过去并重启 Xray,中转上的客户端会断流几秒。继续?`)) return;
  saving.value = true;
  try {
    const saved = editing.value ? await api.updateSocks(editing.value.id, body) : await api.createSocks(body);
    showForm.value = false;
    toast('已保存');
    await load();
    // 新登记的顺手测一下
    if (!editing.value) {
      const row = list.value.find((s) => s.id === saved.id);
      if (row) void checkOne(row);
    }
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(s: Socks) {
  if (s.used_by) return toast(`还有 ${s.used_by} 条线路在用「${s.name}」,先到客户页删掉这些线路`, 'err');
  if (!confirm(`删除 SOCKS「${s.name}」?`)) return;
  try {
    await api.deleteSocks(s.id);
    toast('已删除');
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <div class="toolbar">
    <div>
      <h2>SOCKS</h2>
      <p class="muted small">登记购买的 SOCKS5 代理,作为中转线路的出口。测试从 xui-hub 所在机器发起,代理商按来源 IP 放行的话,中转机上的结果可能不同。</p>
    </div>
    <div class="row">
      <button :disabled="checkingAll || !list.length" @click="checkAll">{{ checkingAll ? '测试中…' : '测试全部' }}</button>
      <button class="primary" @click="openForm(null)">添加 SOCKS</button>
    </div>
  </div>

  <section class="sheet">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>地址</th>
            <th>账号</th>
            <th>连通性</th>
            <th>出口</th>
            <th>在用</th>
            <th>备注</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in list" :key="s.id">
            <td class="name">{{ s.name }}</td>
            <td class="mono">{{ s.host }}:{{ s.port }}</td>
            <td class="muted">{{ s.username || '无' }}<template v-if="s.has_password"> / ••••</template></td>
            <td class="small">
              <template v-if="checking.has(s.id)"><span class="muted">测试中…</span></template>
              <template v-else-if="!s.check"><span class="muted">没测过</span></template>
              <template v-else-if="s.check.ok"><span class="text-ok">可用</span> <span class="muted">{{ s.check.ms }} ms · {{ fmtAgo(s.check.at) }}</span></template>
              <template v-else><span class="text-err" :title="s.check.error ?? ''">失败</span> <span class="muted">{{ (s.check.error ?? '').slice(0, 40) }} · {{ fmtAgo(s.check.at) }}</span></template>
            </td>
            <td class="small">
              <template v-if="s.check?.ok">{{ s.check.ip }} <span class="muted">{{ region(s.check.loc) }}</span></template>
              <span v-else class="muted">—</span>
            </td>
            <td class="small"><template v-if="s.used_by">{{ s.used_by }} 条线路</template><span v-else class="muted">—</span></td>
            <td class="muted small">{{ s.remark || '' }}</td>
            <td class="num">
              <div class="ops">
                <button class="link" :disabled="checking.has(s.id)" @click="checkOne(s)">测试</button>
                <button class="link" @click="openForm(s)">编辑</button>
                <button class="link danger" @click="remove(s)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!list.length" class="empty">还没有 SOCKS。点「添加 SOCKS」,粘贴代理商给的地址即可。</div>
    </div>
  </section>

  <Modal v-if="showForm" :title="editing ? `编辑 SOCKS「${editing.name}」` : '添加 SOCKS'" @close="showForm = false">
    <form id="socks-form" class="form" @submit.prevent="submit">
      <label class="field">名称<input v-model="form.name" required placeholder="如 美国家宽-1" /></label>
      <label class="field">
        地址{{ editing ? '(留空不修改)' : '' }}
        <input v-model="form.address" :required="!editing" placeholder="socks5://用户:密码@主机:端口 或 主机:端口:用户:密码" autocomplete="off" />
      </label>
      <label class="field">备注<input v-model="form.remark" placeholder="代理商、到期日之类" /></label>
      <p class="muted small hint">支持 socks5://用户:密码@主机:端口、主机:端口:用户:密码、主机:端口(无认证)。保存后会自动测一次连通性。</p>
    </form>
    <template #footer>
      <span class="spacer" />
      <button @click="showForm = false">取消</button>
      <button class="primary" form="socks-form" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
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
  max-width: 60ch;
}
.name {
  font-weight: 500;
  white-space: nowrap;
}
.mono {
  font-variant-numeric: tabular-nums;
}
.ops {
  display: flex;
  justify-content: flex-end;
  gap: 14px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hint {
  margin: 0;
}
</style>
