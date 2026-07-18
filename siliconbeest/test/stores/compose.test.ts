import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useComposeStore } from '@/stores/compose';

describe('Compose Store Article mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('uses the long-form limit and requires an Article title', () => {
    const compose = useComposeStore();
    compose.objectType = 'Article';
    compose.text = 'x'.repeat(501);

    expect(compose.characterLimit).toBe(100_000);
    expect(compose.remaining).toBe(99_499);
    expect(compose.canPublish).toBe(false);

    compose.title = 'A real title';
    expect(compose.canPublish).toBe(true);
  });

  it('restores Note defaults after reset', () => {
    const compose = useComposeStore();
    compose.objectType = 'Article';
    compose.title = 'Draft title';
    compose.text = 'Draft body';

    compose.reset();

    expect(compose.objectType).toBe('Note');
    expect(compose.title).toBe('');
    expect(compose.characterLimit).toBe(500);
  });
});
