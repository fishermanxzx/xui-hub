import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import { createApp } from 'vue';
import App from './App.vue';
import { i18n } from './i18n';
import './style.css';

createApp(App).use(i18n).mount('#app');
