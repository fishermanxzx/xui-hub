<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, setUnauthorizedHandler } from './api';
import { toasts } from './toast';
import Login from './views/Login.vue';
import Panels from './views/Panels.vue';

const ready = ref(false);
const loggedIn = ref(false);
const authRequired = ref(false);

async function checkSession() {
  try {
    const s = await api.session();
    authRequired.value = s.auth_required;
    loggedIn.value = s.logged_in;
  } finally {
    ready.value = true;
  }
}

async function logout() {
  await api.logout();
  loggedIn.value = false;
}

setUnauthorizedHandler(() => (loggedIn.value = false));
onMounted(checkSession);
</script>

<template>
  <template v-if="ready">
    <Login v-if="!loggedIn" @done="checkSession" />
    <template v-else>
      <header class="topbar">
        <div class="topbar-inner">
          <span class="mark"><span class="logo" aria-hidden="true" />xui-hub</span>
          <span class="spacer" />
          <button v-if="authRequired" class="link quiet" @click="logout">退出登录</button>
        </div>
      </header>
      <main class="shell">
        <Panels />
      </main>
    </template>
  </template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast sheet" :class="t.kind">{{ t.text }}</div>
  </div>
</template>

<style scoped>
.topbar {
  background: var(--sheet);
  border-bottom: 1px solid var(--rule);
  position: sticky;
  top: 0;
  z-index: 20;
}
.topbar-inner {
  max-width: 1240px;
  margin: 0 auto;
  padding: 0 24px;
  display: flex;
  align-items: center;
  gap: 32px;
  height: 56px;
}
.mark {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 15px;
  letter-spacing: -0.01em;
}
/* 三条错开的线,像线路汇入一处 */
.logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background:
    linear-gradient(var(--sheet), var(--sheet)) 5px 6px / 9px 2px no-repeat,
    linear-gradient(var(--sheet), var(--sheet)) 5px 10px / 12px 2px no-repeat,
    linear-gradient(var(--sheet), var(--sheet)) 5px 14px / 7px 2px no-repeat,
    var(--accent);
}
.spacer {
  flex: 1;
}
.quiet {
  color: var(--ink-soft);
}
.shell {
  max-width: 1240px;
  margin: 0 auto;
  padding: 24px 24px 48px;
}
.toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 100;
  max-width: calc(100vw - 32px);
}
.toast {
  padding: 10px 14px;
  max-width: 440px;
  border-left: 3px solid var(--accent);
}
.toast.err {
  border-left-color: var(--fault);
  color: var(--fault);
}
@media (max-width: 640px) {
  .topbar-inner {
    padding: 0 12px;
    gap: 12px;
  }
  .shell {
    padding: 16px 12px 32px;
  }
}
</style>
