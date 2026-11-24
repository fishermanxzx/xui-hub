<script setup lang="ts">
// 设置页:通知渠道(Telegram / Webhook)和提醒项、数据备份与恢复。
import { t } from '../i18n';
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { toast, toastError } from '../toast';
import { copyText } from '../clipboard';
import { fmtAgo, fmtBytes, fmtDateTime } from '../format';
import type { ApiToken, OAuthGrant, RemoteBackups, Settings } from '../types';

const s = ref<Settings | null>(null);
const saving = ref(false);
const testing = ref(false);

async function load() {
  try {
    s.value = await api.settings();
  } catch (e) {
    toastError(e);
  }
}
onMounted(load);

// ---------- API 令牌 ----------
const tokens = ref<ApiToken[]>([]);
const tokenName = ref('');
/** 刚建好的令牌(明文只有这一次) */
const fresh = ref<ApiToken | null>(null);
const origin = window.location.origin;

async function loadTokens() {
  try {
    tokens.value = await api.tokens();
  } catch (e) {
    toastError(e);
  }
}
onMounted(loadTokens);

async function addToken() {
  try {
    fresh.value = await api.createToken(tokenName.value);
    tokenName.value = '';
    await loadTokens();
  } catch (e) {
    toastError(e);
  }
}

async function removeToken(tk: ApiToken) {
  if (!confirm(t('settings.confirmDeleteToken', { name: tk.name }))) return;
  try {
    await api.deleteToken(tk.id);
    if (fresh.value?.id === tk.id) fresh.value = null;
    await loadTokens();
  } catch (e) {
    toastError(e);
  }
}

async function save(): Promise<boolean> {
  if (!s.value) return false;
  saving.value = true;
  try {
    s.value = await api.updateSettings(s.value);
    toast(t('settings.saved'));
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    saving.value = false;
  }
}

/** 先保存再用保存好的渠道发测试消息 */
async function test() {
  if (!(await save())) return;
  testing.value = true;
  try {
    const { results } = await api.testNotify();
    const bad = results.filter((r) => !r.ok);
    toast(bad.length ? t('settings.sendFailed', { list: bad.map((r) => `${r.channel} (${r.error})`).join(', ') }) : t('settings.sent', { list: results.map((r) => r.channel).join(', ') }), bad.length ? 'err' : 'ok');
  } catch (e) {
    toastError(e);
  } finally {
    testing.value = false;
  }
}

// ---------- MCP ----------
const mcpUrl = `${origin}/mcp`;
const grants = ref<OAuthGrant[]>([]);

async function loadGrants() {
  try {
    grants.value = await api.oauthGrants();
  } catch (e) {
    toastError(e);
  }
}
onMounted(loadGrants);

async function revoke(g: OAuthGrant) {
  if (!confirm(t('settings.confirmRevoke', { name: g.client_name }))) return;
  try {
    await api.revokeGrant(g.id);
    await loadGrants();
  } catch (e) {
    toastError(e);
  }
}

// ---------- 异地备份 ----------
const remote = ref<RemoteBackups | null>(null);
const remoteBusy = ref(false);
async function loadRemote() {
  try {
    remote.value = await api.remoteBackups();
  } catch (e) {
    toastError(e);
  }
}
onMounted(loadRemote);
/** 先保存,再传一份 */
async function remoteNow() {
  if (!(await save())) return;
  remoteBusy.value = true;
  try {
    const r = await api.remoteBackupNow();
    toast(t('settings.remoteDone', { key: r.key, size: fmtBytes(r.size), deleted: r.deleted ? t('settings.remoteDeleted', { n: r.deleted }) : '' }), 'ok');
    await loadRemote();
  } catch (e) {
    toastError(e);
    await loadRemote();
  } finally {
    remoteBusy.value = false;
  }
}
async function remoteRestore(key: string) {
  if (!confirm(t('settings.confirmRemoteRestore', { key }))) return;
  restoring.value = true;
  try {
    const info = await api.remoteRestore(key);
    restored.value = info;
    toast(info.restarting ? t('settings.restoreRestarting') : t('settings.restorePlaced'));
  } catch (e) {
    toastError(e);
  } finally {
    restoring.value = false;
  }
}

// ---------- 恢复 ----------
const fileInput = ref<HTMLInputElement | null>(null);
const restoring = ref(false);
const restored = ref<{ panels: number; customers: number; lines: number } | null>(null);

async function restore() {
  const file = fileInput.value?.files?.[0];
  if (!file) return;
  if (!confirm(t('settings.confirmRestore', { file: file.name }))) return;
  restoring.value = true;
  try {
    const info = await api.restore(file);
    restored.value = info;
    toast(info.restarting ? t('settings.restoreRestarting') : t('settings.restorePlaced'));
  } catch (e) {
    toastError(e);
  } finally {
    restoring.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}
</script>

<template>
  <header class="page-head">
    <div class="ph-main">
      <h1>{{ t('settings.title') }}</h1>
      <details class="about">
        <summary>{{ t('common.about') }}</summary>
        <p>{{ t('settings.intro') }}</p>
      </details>
    </div>
  </header>

  <template v-if="s">
    <section class="sheet block">
      <div class="block-head">
        <h3>{{ t('settings.channels') }}</h3>
        <p class="muted small">{{ t('settings.channelsIntro') }}</p>
      </div>
      <div class="block-body">
        <div class="grid">
          <label class="field">
            Telegram Bot token
            <input v-model="s.telegram.token" :placeholder="t('settings.tgTokenPlaceholder')" autocomplete="off" />
          </label>
          <label class="field">
            Telegram Chat ID
            <input v-model="s.telegram.chat_id" :placeholder="t('settings.tgChatPlaceholder')" autocomplete="off" />
          </label>
        </div>
        <p class="muted small">{{ t('settings.tgNote') }}</p>
        <div class="grid">
          <label class="field">
            {{ t('settings.feishu') }}
            <input v-model="s.feishu.url" :placeholder="t('settings.feishuPlaceholder')" autocomplete="off" spellcheck="false" />
          </label>
          <label class="field">
            {{ t('settings.feishuSecret') }}
            <input v-model="s.feishu.secret" :placeholder="t('settings.feishuSecretPlaceholder')" autocomplete="off" spellcheck="false" />
          </label>
        </div>
        <p class="muted small">{{ t('settings.feishuNote') }}</p>
        <label class="field">
          {{ t('settings.webhook') }}
          <input v-model="s.webhook.url" :placeholder="`${t('settings.webhookPlaceholder')} { event, title, text, at }`" autocomplete="off" />
        </label>
      </div>
    </section>

    <section class="sheet block">
      <div class="block-head">
        <h3>{{ t('settings.events') }}</h3>
      </div>
      <div class="block-body">
        <div class="checks">
          <label class="row small"><input v-model="s.notify.panel_down" type="checkbox" /><i18n-t keypath="settings.evPanel" tag="span" scope="global"><template #n><input v-model.number="s.notify.panel_down_after" type="number" min="1" max="60" class="num" /></template></i18n-t></label>
          <label class="row small"><input v-model="s.notify.customer_disabled" type="checkbox" />{{ t('settings.evDisabled') }}</label>
          <label class="row small"><input v-model="s.notify.expiring" type="checkbox" /><i18n-t keypath="settings.evExpiring" tag="span" scope="global"><template #n><input v-model.number="s.notify.expiring_days" type="number" min="1" max="30" class="num" /></template></i18n-t></label>
          <label class="row small"><input v-model="s.notify.quota_warn" type="checkbox" /><i18n-t keypath="settings.evQuota" tag="span" scope="global"><template #n><input v-model.number="s.notify.quota_warn_pct" type="number" min="50" max="99" class="num" /></template></i18n-t></label>
          <label class="row small"><input v-model="s.notify.monthly_reset" type="checkbox" />{{ t('settings.evReset') }}</label>
          <label class="row small"><input v-model="s.notify.sub_share" type="checkbox" /><i18n-t keypath="settings.evShare" tag="span" scope="global"><template #n><input v-model.number="s.notify.sub_share_ips" type="number" min="2" max="50" class="num" /></template></i18n-t></label>
        </div>
        <div class="row actions">
          <button class="primary" :disabled="saving" @click="save">{{ saving ? t('common.saving') : t('common.save') }}</button>
          <button :disabled="saving || testing" @click="test">{{ testing ? t('settings.sending') : t('settings.saveAndTest') }}</button>
        </div>
      </div>
    </section>

    <section class="sheet block">
      <div class="block-head">
        <h3>{{ t('settings.api') }}</h3>
        <p class="muted small">{{ t('settings.apiIntro') }}</p>
      </div>
      <div class="block-body">
        <form class="row actions" @submit.prevent="addToken">
          <input v-model="tokenName" required maxlength="64" :placeholder="t('settings.tokenPlaceholder')" class="grow" />
          <button class="primary">{{ t('settings.tokenCreate') }}</button>
        </form>
        <div v-if="fresh" class="fresh">
          <p class="small"><strong>{{ t('settings.tokenFresh', { name: fresh.name }) }}</strong></p>
          <div class="row">
            <input readonly :value="fresh.token" class="grow mono" @focus="($event.target as HTMLInputElement).select()" />
            <button type="button" @click="copyText(fresh.token ?? '', t('settings.tokenCopied'))">{{ t('common.copy') }}</button>
          </div>
          <p class="muted small">{{ t('settings.tryIt') }}<code>curl -H "Authorization: Bearer {{ fresh.token }}" {{ origin }}/api/customers</code></p>
        </div>
        <table v-if="tokens.length" class="tokens">
          <thead><tr><th>{{ t('settings.colName') }}</th><th>{{ t('settings.colToken') }}</th><th>{{ t('settings.colCreated') }}</th><th>{{ t('settings.colLastUsed') }}</th><th></th></tr></thead>
          <tbody>
            <tr v-for="tk in tokens" :key="tk.id">
              <td>{{ tk.name }}</td>
              <td class="mono muted">xh_…{{ tk.hint }}</td>
              <td class="muted small">{{ fmtAgo(tk.created_at) }}</td>
              <td class="muted small">{{ tk.last_used_at ? fmtAgo(tk.last_used_at) : t('settings.neverUsed') }}</td>
              <td><button type="button" class="link danger" @click="removeToken(tk)">{{ t('common.delete') }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="sheet block">
      <div class="block-head">
        <h3>MCP</h3>
        <p class="muted small">{{ t('settings.mcpIntro') }}</p>
      </div>
      <div class="block-body">
        <div class="row">
          <input readonly :value="mcpUrl" class="grow mono" :aria-label="t('settings.mcpAria')" @focus="($event.target as HTMLInputElement).select()" />
          <button type="button" @click="copyText(mcpUrl, t('settings.mcpCopied'))">{{ t('common.copy') }}</button>
        </div>
        <ul class="ways small">
          <li><strong>{{ t('settings.mcpOauthTitle') }}</strong>{{ t('settings.mcpOauth') }}</li>
          <li><strong>{{ t('settings.mcpTokenTitle') }}</strong>{{ t('settings.mcpToken') }}<code>claude mcp add --transport http xui-hub {{ mcpUrl }} --header "Authorization: Bearer xh_…"</code></li>
        </ul>
        <table v-if="grants.length" class="tokens">
          <thead><tr><th>{{ t('settings.grantsCol') }}</th><th>{{ t('settings.grantedAt') }}</th><th>{{ t('settings.colLastUsed') }}</th><th></th></tr></thead>
          <tbody>
            <tr v-for="g in grants" :key="g.id">
              <td :title="g.client_id">{{ g.client_name }}</td>
              <td class="muted small">{{ fmtAgo(g.created_at) }}</td>
              <td class="muted small">{{ g.last_used_at ? fmtAgo(g.last_used_at) : t('settings.neverUsed') }}</td>
              <td><button type="button" class="link danger" @click="revoke(g)">{{ t('settings.revoke') }}</button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted small">{{ t('settings.noGrants') }}</p>
      </div>
    </section>

    <section class="sheet block">
      <div class="block-head">
        <h3>{{ t('settings.backup') }}</h3>
        <p class="muted small">{{ t('settings.backupIntro') }}</p>
      </div>
      <div class="block-body">
        <div class="row actions">
          <a class="btn" :href="api.backupUrl" download>{{ t('settings.download') }}</a>
          <label class="row small"><input v-model="s.backup.daily" type="checkbox" @change="save" />{{ t('settings.daily') }}</label>
        </div>
        <div class="restore">
          <span class="label">{{ t('settings.restore') }}</span>
          <div class="row">
            <input ref="fileInput" type="file" accept=".db,application/octet-stream" :disabled="restoring" @change="restore" />
            <span class="muted small">{{ t('settings.restoreHint') }}</span>
          </div>
          <p v-if="restored" class="small text-ok">{{ t('settings.restored', { panels: restored.panels, customers: restored.customers, lines: restored.lines }) }}</p>
        </div>
      </div>
    </section>

    <section class="sheet block">
      <div class="block-head">
        <h3>{{ t('settings.remote') }}</h3>
        <p class="muted small">{{ t('settings.remoteIntro') }}</p>
      </div>
      <div class="block-body">
        <div class="grid">
          <label class="field">
            {{ t('settings.remoteEndpoint') }}
            <input v-model="s.backup.remote.endpoint" :placeholder="t('settings.remoteEndpointPlaceholder')" autocomplete="off" />
          </label>
          <label class="field">
            {{ t('settings.remoteBucket') }}
            <input v-model="s.backup.remote.bucket" autocomplete="off" />
          </label>
          <label class="field">
            Access Key ID
            <input v-model="s.backup.remote.access_key" autocomplete="off" />
          </label>
          <label class="field">
            Secret Access Key
            <input v-model="s.backup.remote.secret_key" type="password" autocomplete="new-password" />
          </label>
          <label class="field">
            {{ t('settings.remotePrefix') }}
            <input v-model="s.backup.remote.prefix" autocomplete="off" />
          </label>
          <label class="field">
            {{ t('settings.remoteRegion') }}
            <input v-model="s.backup.remote.region" autocomplete="off" />
          </label>
          <label class="field">
            {{ t('settings.remoteKeep') }}
            <input v-model.number="s.backup.remote.keep_days" type="number" min="0" max="3650" />
          </label>
        </div>
        <p class="muted small">{{ t('settings.remoteKeepHint') }}</p>
        <div class="row actions">
          <button :disabled="saving" @click="save">{{ saving ? t('common.saving') : t('common.save') }}</button>
          <button :disabled="remoteBusy || saving" @click="remoteNow">{{ remoteBusy ? t('settings.remoteUploading') : t('settings.remoteNow') }}</button>
          <template v-if="remote?.last">
            <span v-if="remote.last.ok" class="small text-ok">{{ t('settings.remoteLastOk', { ago: fmtAgo(remote.last.at), key: remote.last.key, size: fmtBytes(remote.last.size ?? 0) }) }}</span>
            <span v-else class="small text-err">{{ t('settings.remoteLastBad', { ago: fmtAgo(remote.last.at), error: remote.last.error }) }}</span>
          </template>
          <span v-else class="muted small">{{ t('settings.remoteNever') }}</span>
        </div>
        <template v-if="remote?.enabled">
          <div class="row remote-head">
            <span class="label">{{ t('settings.remoteFiles') }}</span>
            <button class="link" @click="loadRemote">{{ t('settings.remoteRefresh') }}</button>
          </div>
          <div v-if="remote.files.length" class="table-wrap">
            <table class="remote-files">
              <tbody>
                <tr v-for="f in remote.files" :key="f.key">
                  <td class="mono">{{ f.key }}</td>
                  <td class="muted small">{{ fmtBytes(f.size) }}</td>
                  <td class="muted small">{{ fmtDateTime(f.at) }}</td>
                  <td class="right"><button class="link" :disabled="restoring" @click="remoteRestore(f.key)">{{ t('settings.remoteRestore') }}</button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="muted small">{{ t('settings.remoteNoFiles') }}</p>
        </template>
      </div>
    </section>
  </template>
</template>

<style scoped>
h3 {
  font-size: 15px;
  margin: 0 0 4px;
}
code {
  font-size: 12px;
  background: var(--hover);
  padding: 1px 5px;
  border-radius: 4px;
}
.block {
  display: grid;
  grid-template-columns: minmax(13em, 0.36fr) minmax(0, 1fr);
  gap: 12px 40px;
  padding: 20px;
  margin-bottom: 12px;
}
.block-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.block-head p {
  line-height: 1.65;
}
.block-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.block p {
  margin: 0;
}
@media (max-width: 860px) {
  .block {
    grid-template-columns: minmax(0, 1fr);
  }
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.num {
  width: 64px;
  padding: 2px 6px;
  margin: 0 4px;
}
.actions {
  gap: 16px;
  flex-wrap: wrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  padding: 7px 14px;
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--sheet);
  color: var(--ink);
  text-decoration: none;
  font-weight: 500;
}
.btn:hover {
  background: var(--hover);
}
.ways {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ways code {
  word-break: break-all;
}
.block > .row {
  gap: 8px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.fresh {
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fresh .row {
  gap: 8px;
}
.fresh code {
  word-break: break-all;
}
.tokens {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tokens th,
.tokens td {
  text-align: left;
  padding: 6px 8px;
  border-top: 1px solid var(--rule);
}
.tokens th {
  font-weight: 500;
  font-size: 12px;
  color: var(--ink-soft);
  border-top: 0;
}
.restore .label {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-bottom: 6px;
}
.restore .row {
  gap: 12px;
  flex-wrap: wrap;
}
.remote-head {
  justify-content: space-between;
}
.remote-head .label {
  font-size: 12px;
  color: var(--ink-soft);
}
.remote-files td {
  padding: 6px 8px;
  border-top: 1px solid var(--rule-soft);
  white-space: nowrap;
}
.remote-files td.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: normal;
}
.remote-files td.right {
  text-align: right;
}
@media (max-width: 640px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
