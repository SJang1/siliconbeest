import { createApp } from 'vue';
import { createPinia } from 'pinia';
import * as Sentry from '@sentry/vue';
import App from './App.vue';
import router from './router';
import { i18n, loadLocale } from './i18n';
import './assets/main.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(i18n);

// Auto-load browser locale if not English
const browserLocale = navigator.language.split('-')[0] || 'en';
if (browserLocale !== 'en') {
  loadLocale(browserLocale).catch(() => { /* fallback to en */ });
}

// Optional Sentry -- only init if DSN is configured
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    app,
    dsn: sentryDsn,
    integrations: [Sentry.browserTracingIntegration({ router })],
    tracesSampleRate: 0.1,
  });
}

app.mount('#app');
