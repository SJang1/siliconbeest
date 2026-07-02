// One-shot scaffold: snapshot current UI into src/legacy and mirror pages/ under pages/old/.
// Safe to re-run: it overwrites the generated trees.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'siliconbeest');
const SRC = join(APP, 'src');
const LEGACY = join(SRC, 'legacy');
const PAGES = join(APP, 'pages');
const OLD_PAGES = join(PAGES, 'old');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// 1. Snapshot views + components into src/legacy with rewritten imports.
await rm(LEGACY, { recursive: true, force: true });
await mkdir(LEGACY, { recursive: true });
await cp(join(SRC, 'views'), join(LEGACY, 'views'), { recursive: true });
await cp(join(SRC, 'components'), join(LEGACY, 'components'), { recursive: true });

let rewritten = 0;
for await (const file of walk(LEGACY)) {
  if (!/\.(vue|ts)$/.test(file)) continue;
  const before = await readFile(file, 'utf-8');
  const after = before
    .replaceAll('@/components/', '@/legacy/components/')
    .replaceAll('@/views/', '@/legacy/views/');
  if (after !== before) {
    await writeFile(file, after);
    rewritten++;
  }
}

// 2. Mirror pages/ under pages/old/, pointing at legacy views.
await rm(OLD_PAGES, { recursive: true, force: true });
const skip = new Set(['setup.vue']);
let generated = 0;
const warnings = [];
for await (const file of walk(PAGES)) {
  const rel = relative(PAGES, file);
  if (rel.startsWith('old/') || !rel.endsWith('.vue') || skip.has(rel)) continue;
  let content = await readFile(file, 'utf-8');
  if (!content.includes('@/views/')) {
    warnings.push(`${rel}: no @/views import, copied as-is`);
  }
  content = content
    .replaceAll('@/views/', '@/legacy/views/')
    .replaceAll('@/components/', '@/legacy/components/')
    .replace(/definePageMeta\(\{\s*name:\s*'([^']+)'/g, "definePageMeta({ name: 'old-$1'")
    // Keep in-page redirects and route aliases inside the /old tree.
    .replaceAll("navigateTo('/", "navigateTo('/old/")
    .replace(/alias:\s*\[([^\]]*)\]/g, (_m, inner) => `alias: [${inner.replaceAll("'/", "'/old/")}]`);
  const dest = join(OLD_PAGES, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content);
  generated++;
}

console.log(`legacy files rewritten: ${rewritten}`);
console.log(`old pages generated: ${generated}`);
for (const w of warnings) console.log(`WARN ${w}`);
