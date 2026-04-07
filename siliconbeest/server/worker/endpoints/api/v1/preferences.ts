import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import * as userPreferences from '../../../repositories/userPreferences';

const UI_KEYS = ['ui:columns', 'ui:show_trending'] as const;
type UiKey = (typeof UI_KEYS)[number];

function isUiKey(key: string): key is UiKey {
  return (UI_KEYS as readonly string[]).includes(key);
}

const app = new Hono<{ Variables: AppVariables }>();

app.get('/', authRequired, async (c) => {
  const user = c.get('currentUser')!;

  const allPrefs = await userPreferences.getByUserId(user.id);

  const prefs: Record<string, string | boolean | null> = {
    'posting:default:visibility': 'public',
    'posting:default:sensitive': false,
    'posting:default:language': null,
    'reading:expand:media': 'default',
    'reading:expand:spoilers': false,
    'ui:columns': null,
    'ui:show_trending': null,
  };

  for (const [key, value] of Object.entries(allPrefs)) {
    if (key in prefs) {
      if (value === 'true') prefs[key] = true;
      else if (value === 'false') prefs[key] = false;
      else prefs[key] = value;
    }
  }

  return c.json(prefs);
});

app.patch('/', authRequired, async (c) => {
  const user = c.get('currentUser')!;
  const body = await c.req.json<Record<string, string>>();

  const updates: Array<{ key: UiKey; value: string }> = [];
  for (const [key, value] of Object.entries(body)) {
    if (isUiKey(key) && typeof value === 'string') {
      updates.push({ key, value });
    }
  }

  if (updates.length === 0) {
    return c.json({ error: 'No valid preference keys provided' }, 422);
  }

  await Promise.all(
    updates.map(({ key, value }) => userPreferences.set(user.id, key, value)),
  );

  return c.json({});
});

export default app;
