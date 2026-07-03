<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui'
import DeckShell from '../layout/DeckShell.vue'
import DeckColumn from '../components/DeckColumn.vue'
import { useDeckColumns, DECK_COLUMN_ORDER, type DeckColumnKey } from '../composables/useDeckColumns'

const { t } = useI18n()
const ui = useUiStore()
const { visibleColumns } = useDeckColumns()

// Mobile shows one column at a time
const activeMobile = ref<DeckColumnKey>(visibleColumns.value[0] ?? 'home')

watch(visibleColumns, (cols) => {
  if (cols.length > 0 && !cols.includes(activeMobile.value)) {
    activeMobile.value = cols[0]!
  }
})
</script>

<template>
  <DeckShell>
    <!-- Desktop: horizontal multi-column deck -->
    <div
      v-if="!ui.isMobile"
      class="flex h-full min-h-0 gap-3.5 overflow-x-auto px-[18px] pb-2.5 pt-3.5"
    >
      <DeckColumn v-for="key in visibleColumns" :key="key" :type="key" />

      <div v-if="visibleColumns.length === 0" class="dk-card dk-dim-text m-auto max-w-md px-6 py-8 text-center text-[13.5px]">
        {{ t('deck.columns_empty') }}
      </div>
    </div>

    <!-- Mobile: single column + switcher chips -->
    <div v-else class="flex h-full min-h-0 flex-col">
      <div class="flex flex-none gap-1.5 overflow-x-auto px-3 py-2" role="tablist">
        <button
          v-for="key in DECK_COLUMN_ORDER"
          :key="key"
          type="button"
          role="tab"
          class="dk-pill-btn flex-none"
          :style="activeMobile === key ? 'color: var(--dk-acc); border-color: var(--dk-acc)' : ''"
          :aria-selected="activeMobile === key"
          @click="activeMobile = key"
        >
          {{ t(`deck.col_${key}`) }}
        </button>
      </div>
      <div class="min-h-0 flex-1 px-3 pb-2">
        <DeckColumn :key="activeMobile" :type="activeMobile" fluid />
      </div>
    </div>
  </DeckShell>
</template>
