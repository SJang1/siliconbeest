import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Status } from '@/types/mastodon'
import ThreadConversation from '@/components/timeline/ThreadConversation.vue'
import { buildThreadTree, getThreadSubtreeIds } from '@/components/timeline/threadTree'
import { createTestI18n } from '../helpers'

function status(id: string, parentId: string | null = null): Status {
  return {
    id,
    in_reply_to_id: parentId,
    content: `<p>${id}</p>`,
    object_type: 'Note',
    title: '',
    account: {
      id: `account-${id}`,
      username: id,
      acct: id,
      display_name: id,
    },
  } as Status
}

describe('thread conversation', () => {
  it('restores parent, child, and sibling relationships in server order', () => {
    const replies = [
      status('reply-a', 'current'),
      status('nested-a', 'reply-a'),
      status('reply-b', 'current'),
      status('nested-b', 'reply-b'),
    ]

    const tree = buildThreadTree(replies)

    expect(tree.map((node) => node.status.id)).toEqual(['reply-a', 'reply-b'])
    expect(tree[0]?.children.map((node) => node.status.id)).toEqual(['nested-a'])
    expect(tree[1]?.children.map((node) => node.status.id)).toEqual(['nested-b'])
  })

  it('links a duplicate status ID only once and keeps its latest payload', () => {
    const original = status('nested', 'reply-a')
    const updated = { ...status('nested', 'reply-b'), content: '<p>updated</p>' }
    const tree = buildThreadTree([
      status('reply-a', 'current'),
      original,
      status('reply-b', 'current'),
      updated,
    ])

    expect(tree.map((node) => node.status.id)).toEqual(['reply-a', 'reply-b'])
    expect(tree[0]?.children).toHaveLength(0)
    expect(tree[1]?.children.map((node) => node.status.id)).toEqual(['nested'])
    expect(tree[1]?.children[0]?.status.content).toBe('<p>updated</p>')
  })

  it('collects a deleted reply subtree without dropping unrelated orphans', () => {
    const replies = [
      status('child', 'deleted-parent'),
      status('grandchild', 'child'),
      status('sibling', 'current'),
      status('orphan', 'missing-parent'),
    ]

    expect([...getThreadSubtreeIds(replies, 'deleted-parent')]).toEqual([
      'deleted-parent',
      'child',
      'grandchild',
    ])
    expect(buildThreadTree(replies).map((node) => node.status.id)).toEqual([
      'child',
      'sibling',
      'orphan',
    ])
  })

  it('marks the current post and renders nested replies as nested lists', () => {
    const wrapper = mount(ThreadConversation, {
      props: {
        status: status('current'),
        ancestors: [status('ancestor')],
        descendants: [
          status('reply-a', 'current'),
          status('nested-a', 'reply-a'),
          status('reply-b', 'current'),
        ],
      },
      global: {
        plugins: [createTestI18n()],
        stubs: {
          StatusCard: {
            props: {
              status: { type: Object, required: true },
              expanded: { type: Boolean, default: false },
            },
            template: '<article class="status-stub" :data-status-id="status.id" :data-expanded="String(Boolean(expanded))" />',
          },
          DeckStatusCard: true,
        },
      },
    })

    expect(wrapper.get('.thread-current').attributes('aria-label')).toBe('Post you are viewing')
    expect(wrapper.get('[data-status-id="current"]').attributes('data-expanded')).toBe('true')
    expect(wrapper.findAll('.thread-branch')).toHaveLength(2)
    expect(wrapper.findAll('.thread-reply-card')).toHaveLength(3)
    expect(wrapper.get('.thread-replies').attributes('aria-label')).toBe('3 replies')
  })

  it('raises every ancestor reply node while a nested action menu is open', async () => {
    const wrapper = mount(ThreadConversation, {
      props: {
        status: status('current'),
        ancestors: [],
        descendants: [
          status('reply-a', 'current'),
          status('nested-a', 'reply-a'),
          status('reply-b', 'current'),
        ],
      },
      global: {
        plugins: [createTestI18n()],
        stubs: {
          StatusCard: {
            props: { status: { type: Object, required: true } },
            emits: ['overlay'],
            template: `
              <div :data-status-id="status.id">
                <button class="open-overlay" @click="$emit('overlay', true)" />
                <button class="close-overlay" @click="$emit('overlay', false)" />
              </div>
            `,
          },
          DeckStatusCard: true,
        },
      },
    })

    const nestedCard = wrapper.get('[data-status-id="nested-a"]')
    await nestedCard.get('.open-overlay').trigger('click')
    expect(wrapper.findAll('.thread-node--overlay')).toHaveLength(2)

    await nestedCard.get('.close-overlay').trigger('click')
    expect(wrapper.findAll('.thread-node--overlay')).toHaveLength(0)
  })
})
