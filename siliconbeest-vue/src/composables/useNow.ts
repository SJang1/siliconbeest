/**
 * Reactive "now" timestamp that updates every 30 seconds.
 * Shared across all components using this composable.
 * Used by relativeTime computed properties to ensure time displays stay current.
 */
import { ref, onUnmounted } from 'vue';

// Module-level shared state — one timer for the entire app
const now = ref(Date.now());
let refCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    now.value = Date.now();
  }, 30_000); // Update every 30 seconds
}

function stopTimer() {
  if (timer && refCount <= 0) {
    clearInterval(timer);
    timer = null;
  }
}

export function useNow() {
  refCount++;
  startTimer();

  onUnmounted(() => {
    refCount--;
    if (refCount <= 0) {
      stopTimer();
    }
  });

  return { now };
}
