import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import { createApp } from 'vue';
import App from './App.vue';
import { i18n } from './i18n';
import './style.css';

createApp(App).use(i18n).mount('#app');
