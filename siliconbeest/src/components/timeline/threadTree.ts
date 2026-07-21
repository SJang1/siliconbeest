import type { Status } from '@/types/mastodon'

export interface ThreadNode {
  status: Status
  children: ThreadNode[]
}

/**
 * Preserve the server-provided order while restoring the parent/child shape.
 * Replies whose parent is outside the returned context stay visible as roots.
 */
export function buildThreadTree(statuses: Status[]): ThreadNode[] {
  const nodes = new Map<string, ThreadNode>()
  const roots: ThreadNode[] = []

  for (const status of statuses) {
    nodes.set(status.id, { status, children: [] })
  }

  // Iterate the deduplicated nodes rather than the input so a repeated status
  // ID is linked exactly once. Map preserves the first insertion position
  // while the set above keeps the latest status payload.
  for (const node of nodes.values()) {
    const { status } = node
    const parent = status.in_reply_to_id ? nodes.get(status.in_reply_to_id) : undefined

    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  return roots
}

/**
 * Return a status ID and every descendant reachable through in_reply_to_id.
 * The root status may already have been evicted from the cache after deletion,
 * so traversal only relies on the remaining statuses.
 */
export function getThreadSubtreeIds(statuses: Status[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>()

  for (const status of statuses) {
    if (!status.in_reply_to_id) continue
    const children = childrenByParent.get(status.in_reply_to_id) ?? []
    children.push(status.id)
    childrenByParent.set(status.in_reply_to_id, children)
  }

  const subtreeIds = new Set<string>([rootId])
  const pending = [rootId]

  for (let index = 0; index < pending.length; index += 1) {
    const children = childrenByParent.get(pending[index]!) ?? []
    for (const childId of children) {
      if (subtreeIds.has(childId)) continue
      subtreeIds.add(childId)
      pending.push(childId)
    }
  }

  return subtreeIds
}
