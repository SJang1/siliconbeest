import { ref, computed } from 'vue'
import { useInstanceStore } from '@/stores/instance'

declare global {
  interface Window {
    turnstile?: {
      render: (container: string, options: TurnstileRenderOptions) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
    }
  }
}

interface TurnstileRenderOptions {
  sitekey: string
  callback: (token: string) => void
  'expired-callback': () => void
  theme: 'auto'
}

interface UseTurnstileOptions {
  siteKey?: string
  onVerified?: (token: string) => void
}

const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

export function useTurnstile(options: UseTurnstileOptions = {}) {
  const token = ref<string>('')
  const widgetId = ref<string>('')
  const instanceStore = useInstanceStore()
  const hasSiteKeyOverride = options.siteKey !== undefined

  const isEnabled = computed(
    () =>
      hasSiteKeyOverride
        ? Boolean(options.siteKey)
        : (instanceStore.instance?.configuration?.turnstile?.enabled ?? false),
  )
  const siteKey = computed(
    () =>
      hasSiteKeyOverride
        ? (options.siteKey ?? '')
        : (instanceStore.instance?.configuration?.turnstile?.site_key ?? ''),
  )

  function render(containerId: string) {
    if (!isEnabled.value || !siteKey.value) return

    if (!window.turnstile) {
      const existingScript = document.querySelector<HTMLScriptElement>(
        `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
      )
      if (existingScript) {
        existingScript.addEventListener('load', () => doRender(containerId), {
          once: true,
        })
        return
      }

      const script = document.createElement('script')
      script.src = TURNSTILE_SCRIPT_SRC
      script.async = true
      script.addEventListener('load', () => doRender(containerId), { once: true })
      document.head.appendChild(script)
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
        options.onVerified?.(t)
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

  function remove() {
    if (widgetId.value && window.turnstile) {
      window.turnstile.remove(widgetId.value)
      widgetId.value = ''
      token.value = ''
    }
  }

  return { token, isEnabled, render, reset, remove }
}
