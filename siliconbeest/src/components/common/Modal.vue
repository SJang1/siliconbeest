<script setup lang="ts">
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  TransitionRoot,
  TransitionChild,
} from '@headlessui/vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  open: boolean
  title?: string
}>()

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <TransitionRoot :show="open" as="template">
    <Dialog @close="emit('close')" class="relative z-50">
      <!-- Backdrop -->
      <TransitionChild
        enter="ease-out duration-200"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="ease-in duration-150"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="fixed inset-0 bg-slate-950/40 backdrop-blur-sm dark:bg-slate-950/60" aria-hidden="true" />
      </TransitionChild>

      <!-- Panel -->
      <div class="fixed inset-0 flex items-start justify-center p-3 pt-[6dvh] sm:p-4 sm:pt-[15vh]">
        <TransitionChild
          enter="ease-out duration-200"
          enter-from="opacity-0 scale-95"
          enter-to="opacity-100 scale-100"
          leave="ease-in duration-150"
          leave-from="opacity-100 scale-100"
          leave-to="opacity-0 scale-95"
        >
          <DialogPanel
            class="sb-card animate-rise-in w-full sm:w-[600px] lg:w-[640px] max-h-[90dvh] sm:max-h-[85vh] p-4 sm:p-6 shadow-lift overflow-y-auto"
          >
            <div v-if="title" class="flex items-center justify-between mb-4">
              <DialogTitle class="sb-heading text-lg text-slate-900 dark:text-slate-50">
                {{ title }}
              </DialogTitle>
              <button
                @click="emit('close')"
                class="rounded-full p-1.5 text-slate-500 transition-colors hover:bg-surface-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-surface-2-dark dark:hover:text-white"
                :aria-label="t('common.close')"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18 18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <slot />
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
