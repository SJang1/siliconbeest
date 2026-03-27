import { ref, computed } from 'vue'
import { useInstanceStore } from '@/stores/instance'

declare global {
  interface Window {
    turnstile?: {
      render: (container: string, options: Record<string, unknown>) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
    }
  }
}

export function useTurnstile() {
  const token = ref<string>('')
  const widgetId = ref<string>('')
  const instanceStore = useInstanceStore()

  const isEnabled = computed(
    () => instanceStore.instance?.configuration?.turnstile?.enabled ?? false,
  )
  const siteKey = computed(
    () => instanceStore.instance?.configuration?.turnstile?.site_key ?? '',
  )

  function render(containerId: string) {
    if (!isEnabled.value || !siteKey.value) return

    if (!window.turnstile) {
      const script = document.createElement('script')
      script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      document.head.appendChild(script)
      script.onload = () => doRender(containerId)
    } else {
      doRender(containerId)
    }
  }

  function doRender(containerId: string) {
    if (!window.turnstile || !siteKey.value) return
    widgetId.value = window.turnstile.render(`#${containerId}`, {
      sitekey: siteKey.value,
      callback: (t: string) => {
        token.value = t
      },
      'expired-callback': () => {
        token.value = ''
      },
      theme: 'auto',
    })
  }

  function reset() {
    if (widgetId.value && window.turnstile) {
      window.turnstile.reset(widgetId.value)
      token.value = ''
    }
  }

  return { token, isEnabled, render, reset }
}
