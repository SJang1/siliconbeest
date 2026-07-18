import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Component } from 'vue'
import MediaGallery from '@/components/status/MediaGallery.vue'
import LegacyMediaGallery from '@/legacy/components/status/MediaGallery.vue'
import { createSiliconBeestI18n } from '@/i18n'

function attachments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`,
    type: 'image',
    url: `https://example.com/image-${index}.jpg`,
    preview_url: null,
    description: `Image ${index + 1}`,
  }))
}

function mountGallery(component: Component, count: number) {
  return mount(component, {
    props: { attachments: attachments(count) },
    global: { plugins: [createSiliconBeestI18n('en')] },
  })
}

const galleryComponents: Array<[string, Component]> = [
  ['current', MediaGallery],
  ['legacy', LegacyMediaGallery],
]

describe.each(galleryComponents)('%s MediaGallery', (_name, component) => {
  it('uses a filled three-image frame', () => {
    const wrapper = mountGallery(component, 3)
    const gallery = wrapper.get('[role="group"]')
    const tiles = gallery.findAll('button')

    expect(gallery.classes()).toEqual(expect.arrayContaining([
      'grid-cols-2',
      'grid-rows-2',
      'aspect-video',
    ]))
    expect(tiles).toHaveLength(3)
    expect(tiles[0].classes()).toContain('row-span-2')
    expect(tiles.every((tile) => !tile.classes().includes('aspect-video'))).toBe(true)
  })

  it('keeps the four-image grid as four equal aspect-ratio tiles', () => {
    const wrapper = mountGallery(component, 4)
    const gallery = wrapper.get('[role="group"]')
    const tiles = gallery.findAll('button')

    expect(gallery.classes()).not.toContain('grid-rows-2')
    expect(tiles).toHaveLength(4)
    expect(tiles.every((tile) => tile.classes().includes('aspect-video'))).toBe(true)
    expect(tiles.every((tile) => !tile.classes().includes('row-span-2'))).toBe(true)
  })
})
