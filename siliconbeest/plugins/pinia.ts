import { createPinia } from 'pinia';

export default defineNuxtPlugin({
  name: 'pinia',
  enforce: 'pre',
  setup(nuxtApp) {
    nuxtApp.vueApp.use(createPinia());
  },
});
