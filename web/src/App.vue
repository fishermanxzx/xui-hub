<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, setUnauthorizedHandler } from './api';
import { toasts } from './toast';
import Login from './views/Login.vue';
import Customers from './views/Customers.vue';
import Panels from './views/Panels.vue';
import SocksView from './views/Socks.vue';

type Tab = 'customers' | 'panels' | 'socks';
const TABS: { id: Tab; label: string }[] = [
  { id: 'customers', label: '客户' },
  { id: 'panels', label: '面板' },
  { id: 'socks', label: 'SOCKS' },
];
function tabFromHash(): Tab {
  const id = location.hash.slice(1);
  return TABS.some((t) => t.id === id) ? (id as Tab) : 'panels';
}
const tab = ref<Tab>(tabFromHash());
window.addEventListener('hashchange', () => (tab.value = tabFromHash()));

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
          <nav aria-label="页面">
            <a v-for="t in TABS" :key="t.id" :href="'#' + t.id" :class="{ on: tab === t.id }" :aria-current="tab === t.id ? 'page' : undefined">{{ t.label }}</a>
          </nav>
          <span class="spacer" />
          <button v-if="authRequired" class="link quiet" title="所有设备上的登录一起退出" @click="logout">退出登录</button>
        </div>
      </header>
      <main class="shell">
        <Customers v-if="tab === 'customers'" />
        <Panels v-else-if="tab === 'panels'" />
        <SocksView v-else />
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
nav {
  display: flex;
  gap: 4px;
  align-items: center;
}
nav a {
  padding: 6px 12px;
  border-radius: 8px;
  color: var(--ink-soft);
  text-decoration: none;
  font-weight: 500;
}
nav a:hover {
  color: var(--ink);
  background: var(--hover);
}
nav a.on {
  color: var(--accent-strong);
  background: var(--accent-soft);
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
  .mark {
    font-size: 0;
    gap: 0;
  }
  .shell {
    padding: 16px 12px 32px;
  }
}
</style>
