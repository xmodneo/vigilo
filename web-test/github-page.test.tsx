import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { GitHubConnectionView } from '../app/app/github/github-connection-view.js';

test('GitHub connection page renders the disconnected installation action', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView installation={null} repairRequestId="11111111-1111-4111-8111-111111111111" workspaceId="workspace-1" />,
  );

  assert.match(html, /GitHub connection/);
  assert.match(html, /Not connected/);
  assert.match(html, /action="\/api\/github\/installations"/);
  assert.match(html, /method="post"/);
  assert.match(html, /Repository selection follows installation/);
});

test('GitHub connection page renders only stable connected installation facts', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView
      installation={{
        accountLogin: 'octo-org',
        accountType: 'Organization',
        installationId: 7001,
        status: 'active',
      }}
      repositories={[
        {
          defaultBranch: 'main',
          fullName: 'octo-org/private-app',
          id: 8101,
          isPrivate: true,
        },
      ]}
      repairRequestId="11111111-1111-4111-8111-111111111111"
      workspaceId="workspace-1"
    />,
  );

  assert.match(html, /Connected/);
  assert.match(html, /octo-org/);
  assert.match(html, /Organization/);
  assert.match(html, /active/);
  assert.match(html, /Select a repository/);
  assert.match(html, /octo-org\/private-app/);
  assert.match(html, /name="repositoryId" value="8101"/);
  assert.doesNotMatch(html, /access[_ -]?token|private[_ -]?key|client[_ -]?secret/i);
});

test('connected installation requires temporary GitHub App authorization before listing', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView
      installation={{
        accountLogin: 'octo-org',
        accountType: 'Organization',
        installationId: 7001,
        status: 'active',
      }}
      repairRequestId="11111111-1111-4111-8111-111111111111"
      workspaceId="workspace-1"
    />,
  );

  assert.match(html, /Load repositories/);
  assert.match(html, /action="\/api\/github\/repositories\/authorize"/);
  assert.doesNotMatch(html, /name="repositoryId"/);
});

test('GitHub connection page shows selected repository and unconfigured execution profile', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView
      installation={{
        accountLogin: 'xmodneo',
        accountType: 'User',
        installationId: 7001,
        status: 'active',
      }}
      selectedRepository={{
        defaultBranch: 'main',
        fullName: 'xmodneo/vigilo',
        id: 8101,
        isPrivate: false,
      }}
      repairRequestId="11111111-1111-4111-8111-111111111111"
      workspaceId="workspace-1"
    />,
  );

  assert.match(html, /Connected repository/);
  assert.match(html, /xmodneo\/vigilo/);
  assert.match(html, /Execution profile/);
  assert.match(html, /Not configured yet/);
  assert.match(html, /Detect execution profile/);
  assert.match(html, /action="\/api\/github\/repositories\/profile"/);
  assert.match(html, /Refresh repository access/);
});

test('selected repository renders a Ready allowlisted execution profile', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView
      executionProfile={{
        baseRevision: 'a'.repeat(40),
        build: { script: 'build', tool: 'npm' },
        install: { operation: 'ci', tool: 'npm' },
        nodeMajor: 24,
        packageManager: 'npm',
        profileIdentity: 'b'.repeat(64),
        profileVersion: 2,
        runtimeFamily: 'node',
        status: 'ready',
        test: { script: 'test', tool: 'npm' },
        testRunner: 'node-test',
        typecheck: { script: 'typecheck', tool: 'npm' },
      }}
      baseline={{
        baseRevision: 'a'.repeat(40), build: 'completed', cleanup: 'confirmed', install: 'completed',
        networkIsolation: 'confirmed', outcome: 'baseline_passed', test: 'completed', typecheck: 'completed',
      }}
      installation={{
        accountLogin: 'xmodneo',
        accountType: 'User',
        installationId: 7001,
        status: 'active',
      }}
      selectedRepository={{
        defaultBranch: 'main',
        fullName: 'xmodneo/vigilo',
        id: 8101,
        isPrivate: false,
      }}
      repairRequestId="11111111-1111-4111-8111-111111111111"
      workspaceId="workspace-1"
    />,
  );

  assert.match(html, /Ready/);
  assert.match(html, /Node.js 24/);
  assert.match(html, /npm ci/);
  assert.match(html, /npm run typecheck/);
  assert.match(html, /npm run build/);
  assert.match(html, /npm test/);
  assert.match(html, /Node built-in test runner/);
  assert.match(html, /Start repair/);
  assert.match(html, /action="\/api\/repair-runs"/);
  assert.match(html, /Execution evidence/);
  assert.match(html, /baseline_passed/);
  assert.match(html, /Network isolation.*confirmed/);
  assert.match(html, /Cleanup.*confirmed/);
  assert.match(html, /aaaaaaaaaaaa/);
  assert.doesNotMatch(html, /node --test|ghs_|package-lock.*content/i);
});

test('unsupported profile renders only its safe classification reason', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView
      executionProfile={{
        baseRevision: 'a'.repeat(40),
        profileVersion: 2,
        reason: 'conflicting_lockfiles',
        status: 'unsupported',
      }}
      installation={{
        accountLogin: 'xmodneo',
        accountType: 'User',
        installationId: 7001,
        status: 'active',
      }}
      selectedRepository={{
        defaultBranch: 'main',
        fullName: 'xmodneo/vigilo',
        id: 8101,
        isPrivate: false,
      }}
      repairRequestId="11111111-1111-4111-8111-111111111111"
      workspaceId="workspace-1"
    />,
  );
  assert.match(html, /Unsupported/);
  assert.match(html, /Competing package-manager lockfiles were found/);
  assert.match(html, /Recompute execution profile/);
});

test('repository page renders durable Repair Run state without exposing authority controls', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView
      executionProfile={{
        baseRevision: 'a'.repeat(40), build: null, install: { operation: 'ci', tool: 'npm' }, nodeMajor: 24,
        packageManager: 'npm', profileIdentity: 'b'.repeat(64), profileVersion: 2, runtimeFamily: 'node', status: 'ready',
        test: { script: 'test', tool: 'npm' }, testRunner: 'node-test', typecheck: null,
      }}
      installation={{ accountLogin: 'xmodneo', accountType: 'User', installationId: 7001, status: 'active' }}
      repairRequestId="11111111-1111-4111-8111-111111111111"
      repairRun={{
        id: 'run-1', state: 'ready_for_investigation', repositoryId: 8101, revision: 'a'.repeat(40), profileIdentity: 'b'.repeat(64),
        baseline: { evidenceId: 'baseline-1', outcome: 'baseline_passed' }, failure: null,
        createdAt: '2026-09-09T00:00:00.000Z', baselineStartedAt: '2026-09-09T00:00:01.000Z', completedAt: '2026-09-09T00:01:00.000Z', stateChangedAt: '2026-09-09T00:01:00.000Z',
      }}
      selectedRepository={{ defaultBranch: 'main', fullName: 'xmodneo/vigilo', id: 8101, isPrivate: false }}
      workspaceId="workspace-1"
    />,
  );
  assert.match(html, /Repair Run/); assert.match(html, /aaaaaaaaaaaa/); assert.match(html, /Baseline.*Passed/); assert.match(html, /ready for investigation/);
  assert.doesNotMatch(html, /name="(?:state|commit|profile|repository|workspace)/);
});
