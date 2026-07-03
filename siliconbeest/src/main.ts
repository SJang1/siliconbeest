import { createApp } from 'vue';
import { createPinia } from 'pinia';
import * as Sentry from '@sentry/vue';
import App from './App.vue';
import router from './router';
import { i18n, loadLocale, getDisplayLocale } from './i18n';
import './assets/main.css';
import './assets/deck.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(i18n);

// Load the detected/stored display locale (localStorage > browser > 'en')
const displayLocale = getDisplayLocale();
if (displayLocale !== 'en') {
  loadLocale(displayLocale).catch(() => { /* fallback to en */ });
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
