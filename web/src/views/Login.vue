<script setup lang="ts">
import { t } from '../i18n';
import { ref } from 'vue';
import { api } from '../api';

const emit = defineEmits<{ done: [] }>();
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await api.login(password.value);
    emit('done');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="login sheet" @submit.prevent="submit">
    <h1>xui-hub</h1>
    <label class="field">
      {{ t('login.password') }}
      <input v-model="password" type="password" autocomplete="current-password" autofocus required />
    </label>
    <p v-if="error" class="text-err small">{{ error }}</p>
    <button class="primary" :disabled="busy || !password">{{ busy ? t('login.submitting') : t('login.submit') }}</button>
  </form>
</template>

<style scoped>
.login {
  max-width: 340px;
  margin: 16vh auto 0;
  padding: 28px 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-top: 3px solid var(--accent);
}
h1 {
  font-size: 20px;
}
p {
  margin: 0;
}
</style>
