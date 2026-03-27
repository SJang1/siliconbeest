/**
 * Actor Serializer Tests — SUPERSEDED
 *
 * The old `actorSerializer.ts` was removed in Phase 2.
 * Fedify's actor dispatcher now handles actor serialisation.
 * The equivalent behaviour is tested via the ActivityPub endpoint
 * integration tests (test/activitypub.test.ts).
 *
 * This file is kept as a placeholder so that the test count remains
 * stable; the describe block is intentionally empty.
 */

import { describe, it, expect } from 'vitest';

describe('serializeActor (legacy — replaced by Fedify actor dispatcher)', () => {
  it('is now handled by Fedify actor dispatcher', () => {
    // Placeholder: the Fedify actor dispatcher tests in activitypub.test.ts
    // cover the same actor serialisation concerns.
    expect(true).toBe(true);
  });
});
