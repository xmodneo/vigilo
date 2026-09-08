import { createHash } from 'node:crypto';

import { satisfies, validRange } from 'semver';

import {
  EXECUTION_PROFILE_VERSION,
  type ExecutionProfileDraft,
  type InspectedRepositoryFile,
  type ReadyExecutionProfileDraft,
  type RepositoryProfileInspection,
  type TestRunner,
  type UnsupportedProfileReason,
} from './types.ts';

const MAX_SCRIPT_BYTES = 8_192;
const MAX_SCRIPT_DEPTH = 6;
const MAX_REFERENCED_SCRIPTS = 32;
const COMPETING_LOCKFILES = new Set([
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const MONOREPO_MARKERS = new Set([
  'lerna.json',
  'nx.json',
  'pnpm-workspace.yaml',
  'rush.json',
  'turbo.json',
  'workspace.json',
]);

type JsonObject = Record<string, unknown>;

function unsupported(
  input: RepositoryProfileInspection,
  reason: UnsupportedProfileReason,
): ExecutionProfileDraft {
  return {
    baseCommitSha: input.baseCommitSha,
    githubRepositoryId: input.githubRepositoryId,
    installationId: input.installationId,
    profileVersion: EXECUTION_PROFILE_VERSION,
    reason,
    status: 'unsupported',
    workspaceId: input.workspaceId,
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(content: string): JsonObject | null {
  try {
    const value = JSON.parse(content) as unknown;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function validInspectedFile(value: InspectedRepositoryFile): boolean {
  return /^[0-9a-f]{40}$/.test(value.sha) && gitBlobSha(value.content) === value.sha;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isObject(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9:_-]{1,128}$/.test(key) ||
      typeof candidate !== 'string' ||
      Buffer.byteLength(candidate, 'utf8') > MAX_SCRIPT_BYTES
    ) {
      return null;
    }
    result[key] = candidate;
  }
  return result;
}

function dependencyNames(manifest: JsonObject): Set<string> | null {
  const result = new Set<string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!isObject(value)) return null;
    for (const [name, version] of Object.entries(value)) {
      if (typeof version !== 'string' || version.length === 0) return null;
      result.add(name);
    }
  }
  return result;
}

function splitCommands(script: string): string[] | null {
  const commands: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      current += character;
      quote = character;
      continue;
    }
    if (character === ';' || character === '\n' || character === '|') {
      if (current.trim()) commands.push(current.trim());
      current = '';
      if (character === '|' && script[index + 1] === '|') index += 1;
      continue;
    }
    if (character === '&') {
      if (current.trim()) commands.push(current.trim());
      current = '';
      if (script[index + 1] === '&') index += 1;
      continue;
    }
    current += character;
  }

  if (quote || escaped) return null;
  if (current.trim()) commands.push(current.trim());
  return commands;
}

function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (quote || escaped) return null;
  if (current) words.push(current);
  return words;
}

type RunnerResult =
  | { runners: Set<TestRunner>; valid: true }
  | { valid: false };

function classifyTestRunner(
  scripts: Record<string, string>,
  dependencies: Set<string>,
): RunnerResult {
  const runners = new Set<TestRunner>();
  const visited = new Set<string>();
  const active = new Set<string>();

  function visit(name: string, depth: number): boolean {
    if (depth > MAX_SCRIPT_DEPTH || visited.size >= MAX_REFERENCED_SCRIPTS) {
      return false;
    }
    if (active.has(name)) return false;
    if (visited.has(name)) return true;
    const script = scripts[name];
    if (script === undefined) return false;
    visited.add(name);
    active.add(name);
    const commands = splitCommands(script);
    if (!commands) return false;

    for (const command of commands) {
      const words = shellWords(command);
      if (!words || words.length === 0) return false;
      if (words[0] === 'npm' && (words[1] === 'run' || words[1] === 'run-script')) {
        const referenced = words[2];
        if (!referenced || !/^[A-Za-z0-9:_-]{1,128}$/.test(referenced)) return false;
        if (!visit(referenced, depth + 1)) return false;
        continue;
      }
      if (
        words[0] === 'node' &&
        !words.includes('-e') &&
        !words.includes('--eval') &&
        words.slice(1).some((word) => word === '--test' || word.startsWith('--test='))
      ) {
        runners.add('node-test');
      }
      if (words[0] === 'vitest' && dependencies.has('vitest')) runners.add('vitest');
      if (words[0] === 'jest' && dependencies.has('jest')) runners.add('jest');
    }

    active.delete(name);
    return true;
  }

  return visit('test', 0) ? { runners, valid: true } : { valid: false };
}

function validPackageManager(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  const match = /^npm@(.+)$/.exec(value);
  return Boolean(match?.[1] && validRange(match[1]));
}

function node24Compatible(value: unknown): boolean {
  if (typeof value !== 'string' || !validRange(value)) return false;
  return satisfies('24.0.0', value, { includePrerelease: false });
}

function validatePackageLock(value: JsonObject): boolean {
  if (
    typeof value.lockfileVersion !== 'number' ||
    !Number.isInteger(value.lockfileVersion) ||
    value.lockfileVersion < 2 ||
    !isObject(value.packages) ||
    !isObject(value.packages[''])
  ) {
    return false;
  }
  return true;
}

function profileIdentity(
  profile: Omit<ReadyExecutionProfileDraft, 'profileIdentity' | 'status'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(profile), 'utf8')
    .digest('hex');
}

export function detectExecutionProfile(
  input: RepositoryProfileInspection,
): ExecutionProfileDraft {
  const rootNames = new Set(input.rootEntries.map((entry) => entry.path));
  if ([...rootNames].some((name) => COMPETING_LOCKFILES.has(name))) {
    return unsupported(input, 'conflicting_lockfiles');
  }
  if ([...rootNames].some((name) => MONOREPO_MARKERS.has(name))) {
    return unsupported(input, 'unsupported_monorepo');
  }
  const packageJsonEntry = input.rootEntries.find((entry) => entry.path === 'package.json');
  const packageLockEntry = input.rootEntries.find((entry) => entry.path === 'package-lock.json');
  if (!packageJsonEntry || !input.packageJson) {
    return unsupported(input, 'missing_package_json');
  }
  if (!packageLockEntry || !input.packageLock) {
    return unsupported(input, 'missing_package_lock');
  }
  if (packageJsonEntry.type !== 'file' || packageJsonEntry.sha !== input.packageJson.sha) {
    return unsupported(input, 'malformed_package_json');
  }
  if (packageLockEntry.type !== 'file' || packageLockEntry.sha !== input.packageLock.sha) {
    return unsupported(input, 'invalid_package_lock');
  }
  if (!validInspectedFile(input.packageJson)) {
    return unsupported(input, 'malformed_package_json');
  }
  if (!validInspectedFile(input.packageLock)) {
    return unsupported(input, 'invalid_package_lock');
  }

  const manifest = parseObject(input.packageJson.content);
  if (!manifest) return unsupported(input, 'malformed_package_json');
  const lockfile = parseObject(input.packageLock.content);
  if (!lockfile || !validatePackageLock(lockfile)) {
    return unsupported(input, 'invalid_package_lock');
  }
  if ('workspaces' in manifest) return unsupported(input, 'unsupported_monorepo');
  if (!validPackageManager(manifest.packageManager)) {
    return unsupported(input, 'unsupported_package_manager');
  }
  const engines = manifest.engines;
  if (!isObject(engines) || !node24Compatible(engines.node)) {
    return unsupported(input, 'unsupported_node_version');
  }
  const scripts = stringRecord(manifest.scripts);
  const dependencies = dependencyNames(manifest);
  if (!scripts || !dependencies) return unsupported(input, 'malformed_package_json');
  if (!scripts.test) return unsupported(input, 'missing_test_script');

  const runnerResult = classifyTestRunner(scripts, dependencies);
  if (!runnerResult.valid) return unsupported(input, 'invalid_script_graph');
  if (runnerResult.runners.size === 0) {
    return unsupported(input, 'unsupported_test_runner');
  }
  if (runnerResult.runners.size !== 1) {
    return unsupported(input, 'ambiguous_test_runner');
  }
  const testRunner = [...runnerResult.runners][0]!;

  const withoutIdentity: Omit<ReadyExecutionProfileDraft, 'profileIdentity' | 'status'> = {
    baseCommitSha: input.baseCommitSha,
    build: scripts.build ? { script: 'build', tool: 'npm' } : null,
    githubRepositoryId: input.githubRepositoryId,
    install: { operation: 'ci', tool: 'npm' },
    installationId: input.installationId,
    lockfileType: 'package-lock',
    nodeMajor: 24,
    packageJsonBlobSha: input.packageJson.sha,
    packageJsonContentSha256: contentSha256(input.packageJson.content),
    packageLockBlobSha: input.packageLock.sha,
    packageLockContentSha256: contentSha256(input.packageLock.content),
    packageManager: 'npm',
    profileVersion: EXECUTION_PROFILE_VERSION,
    runtimeFamily: 'node',
    test: { script: 'test', tool: 'npm' },
    testRunner,
    typecheck: scripts.typecheck ? { script: 'typecheck', tool: 'npm' } : null,
    workspaceId: input.workspaceId,
  };

  return {
    ...withoutIdentity,
    profileIdentity: profileIdentity(withoutIdentity),
    status: 'ready',
  };
}
