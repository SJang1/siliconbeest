/* oxlint-disable fp/no-loop-statements */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

type JsonObject = Record<string, unknown>;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIR, '../../..');
const MAIN_PROJECT_DIR = join(REPOSITORY_ROOT, 'siliconbeest');
const WORKERS_AI_SOURCE = join(
  MAIN_PROJECT_DIR,
  'server/worker/services/workersAi.ts',
);
const WORKERS_TYPES = join(
  MAIN_PROJECT_DIR,
  'node_modules/@cloudflare/workers-types/index.d.ts',
);
const WRANGLER_BIN = join(MAIN_PROJECT_DIR, 'node_modules/.bin/wrangler');
const CHECKED_IN_WORKER_TYPES = join(MAIN_PROJECT_DIR, 'worker-configuration.d.ts');
const fixtureRoots = new Set<string>();

afterEach(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

type ConfigFixture = {
  root: string;
  script: string;
  mainDir: string;
  consumerDir: string;
  emailDir: string;
};

function createFixture(): ConfigFixture {
  const root = mkdtempSync(join(tmpdir(), 'siliconbeest-workers-ai-config-'));
  fixtureRoots.add(root);
  const scriptsDir = join(root, 'scripts');
  const mainDir = join(root, 'siliconbeest');
  const consumerDir = join(root, 'siliconbeest-queue-consumer');
  const emailDir = join(root, 'siliconbeest-email-sender');

  for (const directory of [scriptsDir, mainDir, consumerDir, emailDir]) {
    mkdirSync(directory, { recursive: true });
  }

  cpSync(join(REPOSITORY_ROOT, 'scripts/config.sh'), join(scriptsDir, 'config.sh'));
  cpSync(
    join(REPOSITORY_ROOT, 'scripts/sync-config.sh'),
    join(scriptsDir, 'sync-config.sh'),
  );

  return {
    root,
    script: join(scriptsDir, 'sync-config.sh'),
    mainDir,
    consumerDir,
    emailDir,
  };
}

function fixtureEnvironment(
  fixture: ConfigFixture,
  workersAiEnabled?: string,
  workersAiRateLimits?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PROJECT_ROOT: fixture.root,
    MAIN_DIR: fixture.mainDir,
    CONSUMER_DIR: fixture.consumerDir,
    EMAIL_DIR: fixture.emailDir,
    PROJECT_PREFIX: 'test-instance',
    INSTANCE_DOMAIN: 'social.test.example',
    INSTANCE_TITLE: 'Workers AI Config Test',
    REPOSITORY_URL: 'https://example.com/test/siliconbeest',
    REGISTRATION_MODE: 'closed',
    SKIP_SIGNATURE_VERIFICATION: 'false',
    D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001',
    KV_CACHE_ID: 'cache-test-id',
    KV_SESSIONS_ID: 'sessions-test-id',
    KV_FEDIFY_ID: 'fedify-test-id',
    WORKERS_AI_RECOMMENDATION_MODEL: '@cf/test/recommendation-model',
    WORKERS_AI_TRANSLATION_MODEL: '@cf/test/translation-model',
    WORKERS_AI_IMAGE_CAPTION_MODEL: '@cf/test/image-caption-model',
    WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID: '9101',
    WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID: '9102',
    WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID: '9103',
  };

  if (workersAiEnabled === undefined) {
    delete environment.WORKERS_AI_ENABLED;
  } else {
    environment.WORKERS_AI_ENABLED = workersAiEnabled;
  }

  if (workersAiRateLimits === undefined) {
    delete environment.WORKERS_AI_RATE_LIMITS;
  } else {
    environment.WORKERS_AI_RATE_LIMITS = workersAiRateLimits;
  }

  return environment;
}

function runGenerator(
  fixture: ConfigFixture,
  workersAiEnabled?: string,
  workersAiRateLimits?: string,
): void {
  execFileSync('/bin/bash', [fixture.script, '--apply'], {
    cwd: fixture.root,
    env: fixtureEnvironment(fixture, workersAiEnabled, workersAiRateLimits),
    stdio: 'pipe',
  });
}

function readJsonc(path: string): JsonObject {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (parsed.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'),
    );
  }
  return parsed.config as JsonObject;
}

function generateWorkerTypes(fixture: ConfigFixture): string {
  const outputPath = join(fixture.root, 'worker-configuration.d.ts');
  execFileSync(
    WRANGLER_BIN,
    [
      'types',
      outputPath,
      '--config',
      join(fixture.mainDir, 'wrangler.jsonc'),
      '--env-file',
      join(REPOSITORY_ROOT, 'scripts/typegen.env'),
      '--include-runtime=false',
    ],
    {
      cwd: MAIN_PROJECT_DIR,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: join(fixture.root, 'wrangler.log'),
      },
      stdio: 'pipe',
    },
  );
  return outputPath;
}

function addCheckedInRuntimeTypes(generatedTypes: string): string {
  const currentTypes = readFileSync(CHECKED_IN_WORKER_TYPES, 'utf8');
  const runtimeMarker = '// Begin runtime types';
  const runtimeStart = currentTypes.indexOf(runtimeMarker);
  if (runtimeStart < 0) {
    throw new Error('checked-in Worker declarations have no runtime types marker');
  }

  const mainModule = join(MAIN_PROJECT_DIR, 'server/index');
  const streamingClass = join(
    MAIN_PROJECT_DIR,
    'server/worker/durableObjects/streaming',
  );
  const generatedEnvironment = readFileSync(generatedTypes, 'utf8')
    // Wrangler emits imports relative to the temporary config. Rebase those
    // type-only links before compiling the real Worker source tree.
    .replace(
      /import\("[^"]*\/server\/index"\)/g,
      `import(${JSON.stringify(mainModule)})`,
    )
    .replace(
      /^(\s*)STREAMING_DO:.*$/m,
      `$1STREAMING_DO: DurableObjectNamespace<import(${JSON.stringify(streamingClass)}).StreamingDO>;`,
    );
  const combinedTypes = join(dirname(generatedTypes), 'worker-types-with-runtime.d.ts');
  writeFileSync(
    combinedTypes,
    `${generatedEnvironment}\n${currentTypes.slice(runtimeStart)}`,
  );
  return combinedTypes;
}

function typeCheckWorkersAiService(generatedTypes: string): string {
  const program = ts.createProgram({
    rootNames: [WORKERS_AI_SOURCE, WORKERS_TYPES, generatedTypes],
    options: {
      lib: ['lib.es2022.d.ts'],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => MAIN_PROJECT_DIR,
    getNewLine: () => '\n',
  });
}

function typeCheckWorker(generatedTypes: string): string {
  const configPath = join(MAIN_PROJECT_DIR, 'tsconfig.worker.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return ts.formatDiagnosticsWithColorAndContext([configFile.error], {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => MAIN_PROJECT_DIR,
      getNewLine: () => '\n',
    });
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    MAIN_PROJECT_DIR,
    undefined,
    configPath,
  );
  parsed.options.types = ['vite/client'];
  parsed.options.incremental = false;
  parsed.options.tsBuildInfoFile = undefined;

  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, generatedTypes],
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => MAIN_PROJECT_DIR,
    getNewLine: () => '\n',
  });
}

function variables(config: JsonObject): JsonObject {
  const value = config.vars;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('generated config has no vars object');
  }
  return value as JsonObject;
}

function optionalVariables(config: JsonObject): JsonObject {
  const value = config.vars;
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('generated config vars is not an object');
  }
  return value as JsonObject;
}

function expectStableWorkerStructure(
  main: JsonObject,
  consumer: JsonObject,
  email: JsonObject,
): void {
  expect(main).toMatchObject({
    preview_urls: false,
    main: '.output/server/index.mjs',
    assets: {
      directory: './.output/public',
      not_found_handling: 'none',
      binding: 'ASSETS',
    },
    observability: {
      enabled: false,
      head_sampling_rate: 1,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        persist: true,
        invocation_logs: true,
      },
      traces: {
        enabled: true,
        persist: true,
        head_sampling_rate: 1,
      },
    },
  });
  expect(consumer).toMatchObject({
    workers_dev: false,
    alias: {
      '@fedify/fedify': './node_modules/@fedify/fedify/dist/mod.js',
      '@fedify/fedify/vocab': './node_modules/@fedify/fedify/dist/vocab/mod.js',
      '@fedify/cfworkers': './node_modules/@fedify/cfworkers/dist/mod.js',
    },
    services: [
      {
        binding: 'INTERNAL_CONNECTION_MAIN',
        service: 'test-instance',
        entrypoint: 'Internal',
      },
    ],
  });
  expect(email).toMatchObject({ workers_dev: false });
}

describe('optional Workers AI wrangler generation', () => {
  it.each([
    ['unset', undefined],
    ['false', 'false'],
  ])('omits AI and rate-limit bindings when WORKERS_AI_ENABLED is %s', (_label, enabled) => {
    const fixture = createFixture();
    runGenerator(fixture, enabled);

    const main = readJsonc(join(fixture.mainDir, 'wrangler.jsonc'));
    const consumer = readJsonc(join(fixture.consumerDir, 'wrangler.jsonc'));
    const email = readJsonc(join(fixture.emailDir, 'wrangler.jsonc'));
    expectStableWorkerStructure(main, consumer, email);

    expect(main).not.toHaveProperty('ai');
    expect(main).not.toHaveProperty('ratelimits');
    expect(variables(main)).toMatchObject({
      WORKERS_AI_ENABLED: false,
      WORKERS_AI_RECOMMENDATION_MODEL: '@cf/test/recommendation-model',
      WORKERS_AI_TRANSLATION_MODEL: '@cf/test/translation-model',
      WORKERS_AI_IMAGE_CAPTION_MODEL: '@cf/test/image-caption-model',
      WORKERS_AI_RATE_LIMITS: true,
      WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS: 60,
      WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS: 60,
      WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS: 60,
    });
    expect(consumer).not.toHaveProperty('ai');
    expect(consumer).not.toHaveProperty('ratelimits');
    expect(variables(consumer)).not.toHaveProperty('WORKERS_AI_ENABLED');
    expect(email).not.toHaveProperty('ai');
    expect(email).not.toHaveProperty('ratelimits');
    expect(optionalVariables(email)).not.toHaveProperty('WORKERS_AI_ENABLED');
  });

  it('adds AI and feature rate-limit bindings only to the main Worker when enabled', () => {
    const fixture = createFixture();
    runGenerator(fixture, 'true');

    const main = readJsonc(join(fixture.mainDir, 'wrangler.jsonc'));
    const consumer = readJsonc(join(fixture.consumerDir, 'wrangler.jsonc'));
    const email = readJsonc(join(fixture.emailDir, 'wrangler.jsonc'));
    expectStableWorkerStructure(main, consumer, email);

    expect(main.ai).toEqual({ binding: 'AI', remote: true });
    expect(main.ratelimits).toEqual([
      {
        name: 'AI_RECOMMENDATION_RATE_LIMITER',
        namespace_id: '9101',
        simple: { limit: 2, period: 60 },
      },
      {
        name: 'AI_TRANSLATION_RATE_LIMITER',
        namespace_id: '9102',
        simple: { limit: 6, period: 60 },
      },
      {
        name: 'AI_IMAGE_DESCRIPTION_RATE_LIMITER',
        namespace_id: '9103',
        simple: { limit: 4, period: 60 },
      },
    ]);
    expect(variables(main)).toMatchObject({
      WORKERS_AI_ENABLED: true,
      WORKERS_AI_RECOMMENDATION_MODEL: '@cf/test/recommendation-model',
      WORKERS_AI_TRANSLATION_MODEL: '@cf/test/translation-model',
      WORKERS_AI_IMAGE_CAPTION_MODEL: '@cf/test/image-caption-model',
      WORKERS_AI_RATE_LIMITS: true,
      WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS: 60,
      WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS: 60,
      WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS: 60,
    });
    expect(consumer).not.toHaveProperty('ai');
    expect(consumer).not.toHaveProperty('ratelimits');
    expect(email).not.toHaveProperty('ai');
    expect(email).not.toHaveProperty('ratelimits');
    expect(variables(main)).not.toHaveProperty(
      'WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID',
    );
  });

  it('keeps the AI binding but omits native rate-limit bindings when disabled', () => {
    const fixture = createFixture();
    runGenerator(fixture, 'true', 'false');

    const main = readJsonc(join(fixture.mainDir, 'wrangler.jsonc'));
    const consumer = readJsonc(join(fixture.consumerDir, 'wrangler.jsonc'));
    const email = readJsonc(join(fixture.emailDir, 'wrangler.jsonc'));
    expectStableWorkerStructure(main, consumer, email);

    expect(main.ai).toEqual({ binding: 'AI', remote: true });
    expect(main).not.toHaveProperty('ratelimits');
    expect(variables(main)).toMatchObject({
      WORKERS_AI_ENABLED: true,
      WORKERS_AI_RATE_LIMITS: false,
      WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS: 60,
      WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS: 60,
      WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS: 60,
    });
    expect(consumer).not.toHaveProperty('ai');
    expect(consumer).not.toHaveProperty('ratelimits');
    expect(email).not.toHaveProperty('ai');
    expect(email).not.toHaveProperty('ratelimits');
  });

  it('writes configured limits and periods into Wrangler native bindings', () => {
    const fixture = createFixture();
    const environment = fixtureEnvironment(fixture, 'true', 'true');
    environment.WORKERS_AI_RECOMMENDATION_RATE_LIMIT = '7';
    environment.WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS = '10';
    environment.WORKERS_AI_TRANSLATION_RATE_LIMIT = '11';
    environment.WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS = '60';
    environment.WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT = '13';
    environment.WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS = '10';

    execFileSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      stdio: 'pipe',
    });

    const main = readJsonc(join(fixture.mainDir, 'wrangler.jsonc'));
    expect(main.ratelimits).toEqual([
      {
        name: 'AI_RECOMMENDATION_RATE_LIMITER',
        namespace_id: '9101',
        simple: { limit: 7, period: 10 },
      },
      {
        name: 'AI_TRANSLATION_RATE_LIMITER',
        namespace_id: '9102',
        simple: { limit: 11, period: 60 },
      },
      {
        name: 'AI_IMAGE_DESCRIPTION_RATE_LIMITER',
        namespace_id: '9103',
        simple: { limit: 13, period: 10 },
      },
    ]);
    expect(variables(main)).toMatchObject({
      WORKERS_AI_RATE_LIMITS: true,
      WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS: 10,
      WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS: 60,
      WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS: 10,
    });
    expect(variables(main)).not.toHaveProperty(
      'WORKERS_AI_RECOMMENDATION_RATE_LIMIT',
    );
    expect(variables(main)).not.toHaveProperty(
      'WORKERS_AI_TRANSLATION_RATE_LIMIT',
    );
    expect(variables(main)).not.toHaveProperty(
      'WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT',
    );
  });

  it('uses safe default namespace IDs when overrides are unset', () => {
    const fixture = createFixture();
    const environment = fixtureEnvironment(fixture, 'true');
    delete environment.WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID;
    delete environment.WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID;
    delete environment.WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID;

    execFileSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      stdio: 'pipe',
    });

    const main = readJsonc(join(fixture.mainDir, 'wrangler.jsonc'));
    expect(main.ratelimits).toEqual([
      {
        name: 'AI_RECOMMENDATION_RATE_LIMITER',
        namespace_id: '1001',
        simple: { limit: 2, period: 60 },
      },
      {
        name: 'AI_TRANSLATION_RATE_LIMITER',
        namespace_id: '1002',
        simple: { limit: 6, period: 60 },
      },
      {
        name: 'AI_IMAGE_DESCRIPTION_RATE_LIMITER',
        namespace_id: '1003',
        simple: { limit: 4, period: 60 },
      },
    ]);
  });

  it.each(['1', 'TRUE', ' true ', 'yes'])(
    'rejects the non-boolean value %j before writing configs',
    (enabled) => {
      const fixture = createFixture();
      const result = spawnSync('/bin/bash', [fixture.script, '--apply'], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture, enabled),
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'WORKERS_AI_ENABLED must be boolean true or false',
      );
      expect(() => readFileSync(join(fixture.mainDir, 'wrangler.jsonc'))).toThrow();
      expect(() => readFileSync(join(fixture.consumerDir, 'wrangler.jsonc'))).toThrow();
      expect(() => readFileSync(join(fixture.emailDir, 'wrangler.jsonc'))).toThrow();
    },
  );

  it.each(['1', 'TRUE', ' false ', 'no'])(
    'rejects the non-boolean rate-limit master value %j before writing configs',
    (enabled) => {
      const fixture = createFixture();
      const result = spawnSync('/bin/bash', [fixture.script, '--apply'], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture, 'true', enabled),
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'WORKERS_AI_RATE_LIMITS must be boolean true or false',
      );
      expect(() => readFileSync(join(fixture.mainDir, 'wrangler.jsonc'))).toThrow();
      expect(() => readFileSync(join(fixture.consumerDir, 'wrangler.jsonc'))).toThrow();
      expect(() => readFileSync(join(fixture.emailDir, 'wrangler.jsonc'))).toThrow();
    },
  );

  it.each([
    ['WORKERS_AI_RECOMMENDATION_RATE_LIMIT', '0'],
    ['WORKERS_AI_TRANSLATION_RATE_LIMIT', '-1'],
    ['WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT', '1.5'],
    ['WORKERS_AI_RECOMMENDATION_RATE_LIMIT', '01'],
    ['WORKERS_AI_TRANSLATION_RATE_LIMIT', 'not-an-integer'],
  ])('rejects invalid native limit %s=%j before writing configs', (name, value) => {
    const fixture = createFixture();
    const environment = fixtureEnvironment(fixture, 'true', 'true');
    environment[name] = value;

    const result = spawnSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      `${name} must be a positive integer`,
    );
    expect(() => readFileSync(join(fixture.mainDir, 'wrangler.jsonc'))).toThrow();
  });

  it.each([
    ['WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS', '0'],
    ['WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS', '30'],
    ['WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS', '600'],
    ['WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS', '10.0'],
    ['WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS', 'not-a-period'],
  ])('rejects invalid native period %s=%j before writing configs', (name, value) => {
    const fixture = createFixture();
    const environment = fixtureEnvironment(fixture, 'true', 'true');
    environment[name] = value;

    const result = spawnSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      `${name} must be 10 or 60`,
    );
    expect(() => readFileSync(join(fixture.mainDir, 'wrangler.jsonc'))).toThrow();
  });

  it.each([
    ['AI disabled', 'false', 'true'],
    ['rate limits disabled', 'true', 'false'],
  ])('does not validate namespace IDs when %s', (_label, aiEnabled, rateLimits) => {
    const fixture = createFixture();
    const environment = fixtureEnvironment(fixture, aiEnabled, rateLimits);
    environment.WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID = 'invalid';
    environment.WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID = 'invalid';
    environment.WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID = 'invalid';

    execFileSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      stdio: 'pipe',
    });

    const main = readJsonc(join(fixture.mainDir, 'wrangler.jsonc'));
    expect(main).not.toHaveProperty('ratelimits');
  });

  it.each([
    ['WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID', '0'],
    ['WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID', '-1'],
    ['WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID', '1.5'],
    ['WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID', '01'],
    ['WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID', 'not-an-integer'],
  ])('rejects invalid namespace %s=%j before writing configs', (name, value) => {
    const fixture = createFixture();
    const environment = fixtureEnvironment(fixture, 'true');
    environment[name] = value;

    const result = spawnSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      `${name} must be a positive integer`,
    );
    expect(() => readFileSync(join(fixture.mainDir, 'wrangler.jsonc'))).toThrow();
    expect(() => readFileSync(join(fixture.consumerDir, 'wrangler.jsonc'))).toThrow();
    expect(() => readFileSync(join(fixture.emailDir, 'wrangler.jsonc'))).toThrow();
  });

  it.each([
    [
      'WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID',
      'WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID',
    ],
    [
      'WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID',
      'WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID',
    ],
    [
      'WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID',
      'WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID',
    ],
  ])('rejects duplicate namespaces %s and %s', (firstName, secondName) => {
    const fixture = createFixture();
    const environment = fixtureEnvironment(fixture, 'true');
    environment[firstName] = '9999';
    environment[secondName] = '9999';

    const result = spawnSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Workers AI rate-limit namespace IDs must be pairwise distinct',
    );
    expect(() => readFileSync(join(fixture.mainDir, 'wrangler.jsonc'))).toThrow();
    expect(() => readFileSync(join(fixture.consumerDir, 'wrangler.jsonc'))).toThrow();
    expect(() => readFileSync(join(fixture.emailDir, 'wrangler.jsonc'))).toThrow();
  });

  it('preserves the checked-in social.example.com placeholder on regeneration', () => {
    const fixture = createFixture();
    cpSync(
      join(REPOSITORY_ROOT, 'siliconbeest/wrangler.jsonc'),
      join(fixture.mainDir, 'wrangler.jsonc'),
    );
    const environment = fixtureEnvironment(fixture, 'false');
    delete environment.INSTANCE_DOMAIN;

    execFileSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      stdio: 'pipe',
    });

    const main = readJsonc(join(fixture.mainDir, 'wrangler.jsonc'));
    const consumer = readJsonc(join(fixture.consumerDir, 'wrangler.jsonc'));
    expect(variables(main).INSTANCE_DOMAIN).toBe('social.example.com');
    expect(variables(consumer).INSTANCE_DOMAIN).toBe('social.example.com');
    expect(main.routes).toEqual([
      { custom_domain: true, pattern: 'social.example.com' },
    ]);
  });

  it('regenerates the checked-in AI-off Wrangler configs without drift', () => {
    const fixture = createFixture();
    const environment = fixtureEnvironment(fixture, 'false');
    Object.assign(environment, {
      PROJECT_PREFIX: 'siliconbeest',
      MAIN_WORKER_NAME: 'siliconbeest',
      CONSUMER_NAME: 'siliconbeest-queue-consumer',
      EMAIL_SENDER_NAME: 'siliconbeest-email-sender',
      INSTANCE_DOMAIN: 'social.example.com',
      INSTANCE_TITLE: 'My SiliconBeest Instance',
      REPOSITORY_URL: 'https://github.com/SJang1/siliconbeest',
      REGISTRATION_MODE: 'open',
      D1_DATABASE_NAME: 'siliconbeest-db',
      D1_DATABASE_ID: 'YOUR_D1_DATABASE_ID',
      R2_BUCKET_NAME: 'siliconbeest-media',
      KV_CACHE_ID: 'YOUR_KV_CACHE_ID',
      KV_SESSIONS_ID: 'YOUR_KV_SESSIONS_ID',
      KV_FEDIFY_ID: 'YOUR_KV_FEDIFY_ID',
      QUEUE_FEDERATION: 'siliconbeest-federation',
      QUEUE_INTERNAL: 'siliconbeest-internal',
      QUEUE_EMAIL: 'siliconbeest-email',
      QUEUE_DLQ: 'siliconbeest-federation-dlq',
      WORKERS_AI_RECOMMENDATION_MODEL: '@cf/baai/bge-m3',
      WORKERS_AI_TRANSLATION_MODEL: '@cf/meta/m2m100-1.2b',
      WORKERS_AI_IMAGE_CAPTION_MODEL: '@cf/moondream/moondream3.1-9B-A2B',
    });

    execFileSync('/bin/bash', [fixture.script, '--apply'], {
      cwd: fixture.root,
      env: environment,
      stdio: 'pipe',
    });

    for (const [generated, checkedIn] of [
      [join(fixture.mainDir, 'wrangler.jsonc'), 'siliconbeest/wrangler.jsonc'],
      [
        join(fixture.consumerDir, 'wrangler.jsonc'),
        'siliconbeest-queue-consumer/wrangler.jsonc',
      ],
      [
        join(fixture.emailDir, 'wrangler.jsonc'),
        'siliconbeest-email-sender/wrangler.jsonc',
      ],
    ] as const) {
      expect(readFileSync(generated, 'utf8')).toBe(
        readFileSync(join(REPOSITORY_ROOT, checkedIn), 'utf8'),
      );
    }
  });

  it('keeps preview namespace defaults separate from production defaults', () => {
    const previewWorkflow = readFileSync(
      join(REPOSITORY_ROOT, '.github/workflows/pr-preview.yml'),
      'utf8',
    );
    const productionWorkflows = [
      join(REPOSITORY_ROOT, '.github/workflows/deploy.yml'),
      join(REPOSITORY_ROOT, '.github/workflows/upstream-sync-deploy.yml'),
    ].map((path) => readFileSync(path, 'utf8'));

    for (const [suffix, previewId, productionId] of [
      ['RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID', '2001', '1001'],
      ['TRANSLATION_RATE_LIMIT_NAMESPACE_ID', '2002', '1002'],
      ['IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID', '2003', '1003'],
    ] as const) {
      expect(previewWorkflow).toContain(
        `WORKERS_AI_${suffix}="\${V_WORKERS_AI_${suffix}:-${previewId}}"`,
      );
      for (const workflow of productionWorkflows) {
        expect(workflow).toContain(
          `WORKERS_AI_${suffix}="\${V_WORKERS_AI_${suffix}:-${productionId}}"`,
        );
      }
    }

    for (const [suffix, defaultValue] of [
      ['RATE_LIMITS', 'true'],
      ['RECOMMENDATION_RATE_LIMIT', '2'],
      ['RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS', '60'],
      ['TRANSLATION_RATE_LIMIT', '6'],
      ['TRANSLATION_RATE_LIMIT_PERIOD_SECONDS', '60'],
      ['IMAGE_DESCRIPTION_RATE_LIMIT', '4'],
      ['IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS', '60'],
    ] as const) {
      for (const workflow of [previewWorkflow, ...productionWorkflows]) {
        expect(workflow).toContain(
          `WORKERS_AI_${suffix}="\${V_WORKERS_AI_${suffix}:-${defaultValue}}"`,
        );
        expect(workflow).toContain(
          `V_WORKERS_AI_${suffix}: \${{ vars.WORKERS_AI_${suffix} }}`,
        );
      }
    }
  });

  it.each([
    ['disabled', 'false', undefined, false, false],
    ['enabled with rate limits', 'true', 'true', true, true],
    ['enabled without rate limits', 'true', 'false', true, false],
  ] as const)(
    'type-checks the adapter and full Worker with generated AI %s types',
    (_label, enabled, rateLimits, expectsAiBinding, expectsRateBindings) => {
      const fixture = createFixture();
      runGenerator(fixture, enabled, rateLimits);
      const generatedTypes = generateWorkerTypes(fixture);
      const declarations = readFileSync(generatedTypes, 'utf8');
      const fullWorkerTypes = addCheckedInRuntimeTypes(generatedTypes);

      expect(/\bAI:\s*Ai;/.test(declarations)).toBe(expectsAiBinding);
      expect(/\bAI_RECOMMENDATION_RATE_LIMITER:\s*RateLimit;/.test(declarations))
        .toBe(expectsRateBindings);
      expect(/\bAI_TRANSLATION_RATE_LIMITER:\s*RateLimit;/.test(declarations))
        .toBe(expectsRateBindings);
      expect(/\bAI_IMAGE_DESCRIPTION_RATE_LIMITER:\s*RateLimit;/.test(declarations))
        .toBe(expectsRateBindings);
      expect(declarations).toMatch(/\bOTP_ENCRYPTION_KEY:\s*string;/);
      expect(declarations).toMatch(/\bSETUP_SECRET:\s*string;/);
      expect(typeCheckWorkersAiService(generatedTypes)).toBe('');
      expect(typeCheckWorker(fullWorkerTypes)).toBe('');
    },
    30_000,
  );
});
