<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Status } from '@/types/mastodon'
import StatusCard from '@/components/status/StatusCard.vue'
import DeckStatusCard from '@/deck/components/DeckStatusCard.vue'
import type { ThreadNode } from './threadTree'

defineOptions({ name: 'ThreadBranch' })

const props = withDefaults(defineProps<{
  nodes: ThreadNode[]
  variant?: 'aurora' | 'deck'
  depth?: number
}>(), {
  variant: 'aurora',
  depth: 0,
})

const emit = defineEmits<{
  navigate: [status: Status]
  deleted: [statusId: string]
  overlay: [open: boolean]
}>()

const cardComponent = computed(() => props.variant === 'deck' ? DeckStatusCard : StatusCard)
const overlayNodeId = ref<string | null>(null)

function handleOverlay(nodeId: string, open: boolean) {
  if (open) overlayNodeId.value = nodeId
  else if (overlayNodeId.value === nodeId) overlayNodeId.value = null
  emit('overlay', open)
}
</script>

<template>
  <ul
    class="thread-branch"
    :class="[
      `thread-branch--${variant}`,
      { 'thread-branch--compact': depth >= 3 },
    ]"
    role="list"
  >
    <li
      v-for="node in nodes"
      :key="node.status.id"
      class="thread-node"
      :class="{ 'thread-node--overlay': overlayNodeId === node.status.id }"
    >
      <span class="thread-elbow" aria-hidden="true">
        <span class="thread-dot" />
      </span>

      <div class="thread-reply-card">
        <component
          :is="cardComponent"
          :status="node.status"
          @navigate="emit('navigate', $event)"
          @deleted="emit('deleted', $event)"
          @overlay="handleOverlay(node.status.id, $event)"
        />
      </div>

      <ThreadBranch
        v-if="node.children.length"
        :nodes="node.children"
        :variant="variant"
        :depth="depth + 1"
        @navigate="emit('navigate', $event)"
        @deleted="emit('deleted', $event)"
        @overlay="handleOverlay(node.status.id, $event)"
      />
    </li>
  </ul>
</template>

<style scoped>
.thread-branch {
  --branch-indent: 1.15rem;
  position: relative;
  margin: 0 0 0 1rem;
  padding: 0 0 0 var(--branch-indent);
  border-left: 2px solid var(--thread-line);
  list-style: none;
}

.thread-branch--compact {
  --branch-indent: 0.75rem;
  margin-left: 0.35rem;
}

.thread-node {
  position: relative;
  isolation: isolate;
}

.thread-node--overlay {
  z-index: 3;
}

.thread-node + .thread-node {
  margin-top: 0.75rem;
}

.thread-node:last-child::after {
  position: absolute;
  z-index: 0;
  top: 1.7rem;
  bottom: 0;
  left: calc(-1 * var(--branch-indent) - 3px);
  width: 4px;
  background: var(--thread-page);
  content: '';
}

.thread-elbow {
  position: absolute;
  z-index: 2;
  top: 1.65rem;
  left: calc(-1 * var(--branch-indent));
  width: var(--branch-indent);
  border-top: 2px solid var(--thread-line);
}

.thread-dot {
  position: absolute;
  top: -5px;
  right: -4px;
  width: 8px;
  height: 8px;
  border: 2px solid var(--thread-dot-ring);
  border-radius: 999px;
  background: var(--thread-dot);
  box-shadow: 0 0 0 2px var(--thread-page);
}

.thread-reply-card {
  position: relative;
  z-index: 1;
  border: 1px solid var(--thread-card-border);
  border-radius: 0.9rem;
  background: var(--thread-card);
  box-shadow: var(--thread-card-shadow);
}

.thread-branch > .thread-node > .thread-branch {
  margin-top: 0.65rem;
}

.thread-branch--aurora .thread-reply-card :deep(article) {
  border-bottom: 0;
  border-radius: inherit;
}

.thread-branch--deck .thread-reply-card {
  border: 0;
  background: transparent;
  box-shadow: none;
}

@media (max-width: 520px) {
  .thread-branch {
    --branch-indent: 0.85rem;
    margin-left: 0.45rem;
  }

  .thread-branch--compact {
    --branch-indent: 0.55rem;
    margin-left: 0.2rem;
  }
}
</style>
