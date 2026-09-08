import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  detectExecutionProfile,
  gitBlobSha,
} from '../lib/execution-profiles/detector.ts';
import type {
  InspectedRepositoryFile,
  RepositoryProfileInspection,
} from '../lib/execution-profiles/types.ts';

const COMMIT = 'a'.repeat(40);

function inspectedFile(value: unknown): InspectedRepositoryFile {
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  return { content, sha: gitBlobSha(content) };
}

function supportedManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'supported-app',
    version: '1.0.0',
    engines: { node: '24.x' },
    packageManager: 'npm@11.6.2',
    scripts: { test: 'node --test' },
    ...overrides,
  };
}

function inspection(overrides: Partial<RepositoryProfileInspection> = {}): RepositoryProfileInspection {
  const packageJson = inspectedFile(supportedManifest());
  const packageLock = inspectedFile({
    lockfileVersion: 3,
    name: 'supported-app',
    packages: { '': { name: 'supported-app', version: '1.0.0' } },
    version: '1.0.0',
  });
  const result: RepositoryProfileInspection = {
    baseCommitSha: COMMIT,
    githubRepositoryId: 8101,
    installationId: 9001,
    packageJson,
    packageLock,
    rootEntries: [
      { name: 'package-lock.json', path: 'package-lock.json', sha: packageLock.sha, size: packageLock.content.length, type: 'file' },
      { name: 'package.json', path: 'package.json', sha: packageJson.sha, size: packageJson.content.length, type: 'file' },
    ],
    workspaceId: 'workspace-one',
    ...overrides,
  };
  if (overrides.rootEntries === undefined) {
    result.rootEntries = [
      ...(result.packageLock
        ? [{ name: 'package-lock.json', path: 'package-lock.json', sha: result.packageLock.sha, size: result.packageLock.content.length, type: 'file' as const }]
        : [{ name: 'package-lock.json', path: 'package-lock.json', sha: packageLock.sha, size: packageLock.content.length, type: 'file' as const }]),
      ...(result.packageJson
        ? [{ name: 'package.json', path: 'package.json', sha: result.packageJson.sha, size: result.packageJson.content.length, type: 'file' as const }]
        : [{ name: 'package.json', path: 'package.json', sha: packageJson.sha, size: packageJson.content.length, type: 'file' as const }]),
    ];
  }
  return result;
}

function withManifest(value: Record<string, unknown>): RepositoryProfileInspection {
  return inspection({ packageJson: inspectedFile(value) });
}

test('supported Node 24 npm project produces only allowlisted entrypoints', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    scripts: {
      build: 'npm run compile && next build',
      test: 'node --test test/*.test.js',
      typecheck: 'npm run types:a && npm run types:b',
    },
  })));

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.install, { operation: 'ci', tool: 'npm' });
  assert.deepEqual(result.typecheck, { script: 'typecheck', tool: 'npm' });
  assert.deepEqual(result.build, { script: 'build', tool: 'npm' });
  assert.deepEqual(result.test, { script: 'test', tool: 'npm' });
  assert.equal(result.testRunner, 'node-test');
  assert.doesNotMatch(JSON.stringify(result), /compile|types:a|next build|node --test/);
});

test('direct node --test invocation is detected statically', () => {
  const result = detectExecutionProfile(inspection());
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.testRunner, 'node-test');
});

test('root test script may delegate through npm run to node --test', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    scripts: { test: 'npm run test:unit', 'test:unit': 'node --test test/*.test.js' },
  })));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.testRunner, 'node-test');
});

test('bounded nested npm-run traversal classifies the runner', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    scripts: {
      test: 'npm run test:a',
      'test:a': 'npm run test:b',
      'test:b': 'npm run test:c',
      'test:c': 'node --test',
    },
  })));
  assert.equal(result.status, 'ready');
});

test('script traversal cycles fail closed', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    scripts: { test: 'npm run test:a', 'test:a': 'npm run test' },
  })));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'invalid_script_graph');
});

test('script traversal beyond the depth limit fails closed', () => {
  const scripts: Record<string, string> = { test: 'npm run level:1' };
  for (let level = 1; level <= 7; level += 1) {
    scripts[`level:${level}`] = level === 7 ? 'node --test' : `npm run level:${level + 1}`;
  }
  const result = detectExecutionProfile(withManifest(supportedManifest({ scripts })));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'invalid_script_graph');
});

test('unknown referenced scripts fail closed', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    scripts: { test: 'npm run missing' },
  })));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'invalid_script_graph');
});

test('Vitest requires a direct declaration and matching execution path', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    devDependencies: { vitest: '4.0.0' },
    scripts: { test: 'vitest run' },
  })));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.testRunner, 'vitest');
});

test('Jest requires a direct declaration and matching execution path', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    devDependencies: { jest: '30.0.0' },
    scripts: { test: 'jest --runInBand' },
  })));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.testRunner, 'jest');
});

test('transitive Vitest lockfile metadata does not classify Vitest', () => {
  const base = inspection({
    packageJson: inspectedFile(supportedManifest({ scripts: { test: 'vitest run' } })),
    packageLock: inspectedFile({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/dependency': { peerDependencies: { vitest: '^4.0.0' } },
      },
    }),
  });
  const result = detectExecutionProfile(base);
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'unsupported_test_runner');
});

test('mixed supported runners in the traversed path fail closed', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    devDependencies: { vitest: '4.0.0' },
    scripts: { test: 'node --test && vitest run' },
  })));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'ambiguous_test_runner');
});

test('backgrounded mixed runners fail closed', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({
    devDependencies: { vitest: '4.0.0' },
    scripts: { test: 'node --test & vitest run' },
  })));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'ambiguous_test_runner');
});

test('profile identity is deterministic for logically identical inputs', () => {
  const first = detectExecutionProfile(inspection());
  const second = detectExecutionProfile(inspection());
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  if (first.status === 'ready' && second.status === 'ready') {
    assert.equal(first.profileIdentity, second.profileIdentity);
  }
});

test('changed commit changes profile identity', () => {
  const first = detectExecutionProfile(inspection());
  const second = detectExecutionProfile(inspection({ baseCommitSha: 'b'.repeat(40) }));
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  if (first.status === 'ready' && second.status === 'ready') {
    assert.notEqual(first.profileIdentity, second.profileIdentity);
  }
});

test('changed package metadata changes profile identity', () => {
  const first = detectExecutionProfile(inspection());
  const second = detectExecutionProfile(withManifest(supportedManifest({ private: true })));
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  if (first.status === 'ready' && second.status === 'ready') {
    assert.notEqual(first.profileIdentity, second.profileIdentity);
  }
});

test('missing package.json is rejected', () => {
  const result = detectExecutionProfile(inspection({ packageJson: null }));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'missing_package_json');
});

test('missing package-lock.json is rejected', () => {
  const result = detectExecutionProfile(inspection({ packageLock: null }));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'missing_package_lock');
});

for (const lockfile of ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']) {
  test(`${lockfile} is rejected as a conflicting package manager`, () => {
    const base = inspection();
    const result = detectExecutionProfile(inspection({
      rootEntries: [...base.rootEntries, { name: lockfile, path: lockfile, sha: 'b'.repeat(40), size: 1, type: 'file' }],
    }));
    assert.deepEqual(result.status === 'unsupported' && result.reason, 'conflicting_lockfiles');
  });
}

test('multiple lockfiles are rejected', () => {
  const base = inspection();
  const result = detectExecutionProfile(inspection({
    rootEntries: [
      ...base.rootEntries,
      { name: 'yarn.lock', path: 'yarn.lock', sha: 'b'.repeat(40), size: 1, type: 'file' },
      { name: 'pnpm-lock.yaml', path: 'pnpm-lock.yaml', sha: 'c'.repeat(40), size: 1, type: 'file' },
    ],
  }));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'conflicting_lockfiles');
});

test('package.json workspaces are rejected even when empty', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({ workspaces: [] })));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'unsupported_monorepo');
});

test('obvious root monorepo configuration is rejected', () => {
  const base = inspection();
  const result = detectExecutionProfile(inspection({
    rootEntries: [...base.rootEntries, { name: 'turbo.json', path: 'turbo.json', sha: 'b'.repeat(40), size: 1, type: 'file' }],
  }));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'unsupported_monorepo');
});

test('unsupported Node engines are rejected while compatible ranges are accepted', () => {
  const unsupported = detectExecutionProfile(withManifest(supportedManifest({ engines: { node: '22.x' } })));
  const compatible = detectExecutionProfile(withManifest(supportedManifest({ engines: { node: '>=22 <25' } })));
  assert.deepEqual(unsupported.status === 'unsupported' && unsupported.reason, 'unsupported_node_version');
  assert.equal(compatible.status, 'ready');
});

test('malformed package.json is rejected', () => {
  const malformed = inspectedFile('{not json');
  const result = detectExecutionProfile(inspection({ packageJson: malformed }));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'malformed_package_json');
});

test('tampered package content that disagrees with its Git blob SHA is rejected', () => {
  const value = inspectedFile(supportedManifest());
  value.content = `${value.content} `;
  const result = detectExecutionProfile(inspection({ packageJson: value }));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'malformed_package_json');
});

test('root listing and fetched manifest identities must agree', () => {
  const base = inspection();
  const result = detectExecutionProfile(inspection({
    rootEntries: base.rootEntries.map((entry) =>
      entry.path === 'package.json' ? { ...entry, sha: 'f'.repeat(40) } : entry,
    ),
  }));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'malformed_package_json');
});

test('missing optional build and typecheck scripts remain explicitly absent', () => {
  const result = detectExecutionProfile(inspection());
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.build, null);
  assert.equal(result.typecheck, null);
});

test('unsupported package manager declaration is rejected', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({ packageManager: 'pnpm@10.0.0' })));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'unsupported_package_manager');
});

test('missing root test script is rejected', () => {
  const result = detectExecutionProfile(withManifest(supportedManifest({ scripts: { build: 'tsc' } })));
  assert.deepEqual(result.status === 'unsupported' && result.reason, 'missing_test_script');
});

test('real Vigilo package.json shape classifies as Node test without executing scripts', async () => {
  const [packageJsonContent, packageLockContent] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('package-lock.json', 'utf8'),
  ]);
  const result = detectExecutionProfile(inspection({
    packageJson: inspectedFile(packageJsonContent),
    packageLock: inspectedFile(packageLockContent),
  }));
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.testRunner, 'node-test');
  assert.deepEqual(result.build, { script: 'build', tool: 'npm' });
  assert.deepEqual(result.typecheck, { script: 'typecheck', tool: 'npm' });
  assert.deepEqual(result.test, { script: 'test', tool: 'npm' });
});

test('repository scripts are parsed as data and never executed during detection', async () => {
  const marker = `/tmp/vigilo-profile-detector-${randomUUID()}`;
  const result = detectExecutionProfile(withManifest(supportedManifest({
    scripts: {
      build: `touch ${marker}`,
      test: 'node --test',
      typecheck: `touch ${marker}`,
    },
  })));
  assert.equal(result.status, 'ready');
  await assert.rejects(access(marker));
});
