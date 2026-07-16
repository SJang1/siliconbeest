import { afterEach, describe, expect, it, vi } from 'vitest'
import { htmlToPlainText } from '@/utils/html'

describe('htmlToPlainText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('produces the same text without DOMParser', () => {
    const html = [
      '<p>Tom &amp; Jerry &copy; &#x1F431;</p>',
      '<script>window.alert(&quot;hidden&quot;)</script>',
      '<style>.hidden { display: none; }</style>',
      '<template><p>hidden template</p></template>',
      '<div>Visible<br>line</div>',
    ].join('')
    const browserText = htmlToPlainText(html)

    vi.stubGlobal('DOMParser', undefined)

    expect(htmlToPlainText(html)).toBe(browserText)
    expect(browserText).toBe('Tom & Jerry © 🐱\nVisible\nline')
  })

  it('does not interpret encoded tags as markup in the fallback', () => {
    vi.stubGlobal('DOMParser', undefined)

    expect(htmlToPlainText('&lt;strong&gt;safe&lt;/strong&gt;')).toBe('<strong>safe</strong>')
  })
})
