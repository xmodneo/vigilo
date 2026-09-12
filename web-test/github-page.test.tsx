import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { GitHubConnectionView } from '../app/app/github/github-connection-view.js';
import { RepairRunStatus } from '../app/app/github/repair-run-status.js';
import { AiInvestigationStatus } from '../app/app/github/ai-investigation-status.js';

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

test('active Repair Run renders honest worker-owned progress and queued cancellation', () => {
  const common = {
    id: '11111111-1111-4111-8111-111111111111', repositoryId: 8101, revision: 'a'.repeat(40), profileIdentity: 'b'.repeat(64),
    baseline: null, failure: null, createdAt: '2026-09-09T00:00:00.000Z', completedAt: null, stateChangedAt: '2026-09-09T00:00:00.000Z',
  } as const;
  const queued = renderToStaticMarkup(<RepairRunStatus initialRun={{ ...common, state: 'created', baselineStartedAt: null }} />);
  assert.match(queued, /Waiting for worker/);
  assert.match(queued, /Cancel queued run/);
  assert.match(queued, /action="\/api\/repair-runs\/11111111-1111-4111-8111-111111111111\/cancel"/);
  assert.doesNotMatch(queued, /Start repair/);

  const running = renderToStaticMarkup(<RepairRunStatus initialRun={{ ...common, state: 'baseline_running', baselineStartedAt: '2026-09-09T00:00:01.000Z' }} />);
  assert.match(running, /Running baseline/);
  assert.doesNotMatch(running, /Cancel queued run|Start repair/);
});

test('ready investigation exposes only the bounded AI investigation start intent', () => {
  const html = renderToStaticMarkup(<AiInvestigationStatus investigationId="11111111-1111-4111-8111-111111111111" initialAiInvestigation={null} startRequestId="44444444-4444-4444-8444-444444444444" />);
  assert.match(html, /AI Investigation/); assert.match(html, /Start AI investigation/); assert.match(html, /action="\/api\/ai-investigations"/); assert.match(html, /name="investigationId"/); assert.match(html, /name="idempotencyKey" value="44444444-4444-4444-8444-444444444444"/);
  assert.doesNotMatch(html, /shell|write file|apply fix|create candidate|api key/i);
});

test('failed AI investigation offers a new execution while completed results do not', () => {
  const base = { id: '22222222-2222-4222-8222-222222222222', investigationId: '11111111-1111-4111-8111-111111111111', executionOrdinal: 1, revision: 'a'.repeat(40), provider: 'google', model: 'gemini-3.1-flash-lite', completionReason: null, conclusion: null, usage: { inputTokens: 0, outputTokens: 0, toolCallCount: 0, modelTurnCount: 0 } } as const;
  const failed = renderToStaticMarkup(<AiInvestigationStatus investigationId={base.investigationId} initialAiInvestigation={{ ...base, state: 'failed', failureCode: 'provider_quota_exhausted' }} startRequestId="44444444-4444-4444-8444-444444444444" />);
  assert.match(failed, /Previous execution 1/); assert.match(failed, /Provider quota exhausted/); assert.match(failed, /Retry AI investigation/); assert.match(failed, /name="idempotencyKey"/);
  const completed = renderToStaticMarkup(<AiInvestigationStatus investigationId={base.investigationId} initialAiInvestigation={{ ...base, state: 'completed', completionReason: 'budget_exhausted', conclusion: { status: 'insufficient_evidence', summary: 'Bounded.', suspectedFiles: [], evidence: [], proposedApproach: 'Review.', confidence: 'low' }, failureCode: null }} startRequestId="55555555-5555-4555-8555-555555555555" />);
  assert.doesNotMatch(completed, /Retry AI investigation|Start AI investigation/);
});

test('completed AI investigation renders structured text safely without authority controls', () => {
  const html = renderToStaticMarkup(<AiInvestigationStatus investigationId="11111111-1111-4111-8111-111111111111" startRequestId="44444444-4444-4444-8444-444444444444" initialAiInvestigation={{
    id: '22222222-2222-4222-8222-222222222222', investigationId: '11111111-1111-4111-8111-111111111111', executionOrdinal: 1, state: 'completed', revision: 'a'.repeat(40), provider: 'google', model: 'gemini-3.1-flash-lite', completionReason: 'model_conclusion',
    conclusion: { status: 'diagnosis_found', summary: '<script>unsafe()</script>', suspectedFiles: [{ path: 'src/shipping.ts', reason: 'Threshold check.' }], evidence: [{ kind: 'file', reference: '33333333-3333-4333-8333-333333333333' }], proposedApproach: 'Review the comparison.', confidence: 'high' },
    usage: { inputTokens: 10, outputTokens: 5, toolCallCount: 1, modelTurnCount: 2 }, failureCode: null,
  }} />);
  assert.match(html, /Diagnosis/); assert.match(html, /Suspected files/); assert.match(html, /Evidence consulted/); assert.match(html, /Proposed approach/); assert.match(html, /Confidence/); assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|Apply fix|Verify|Approve|Publish|name="(?:workspace|commit|repository|state)"/);
});

test('eligible Repair Run renders its objective and bounded investigation status', () => {
  const repairRun = {
    id: '11111111-1111-4111-8111-111111111111', state: 'ready_for_investigation' as const, repositoryId: 8101,
    revision: 'a'.repeat(40), profileIdentity: 'b'.repeat(64), repairObjective: 'Inspect durable Repair Runs.',
    baseline: { evidenceId: 'baseline-1', outcome: 'baseline_passed' }, failure: null,
    createdAt: '2026-09-09T00:00:00.000Z', baselineStartedAt: '2026-09-09T00:00:01.000Z', completedAt: '2026-09-09T00:01:00.000Z', stateChangedAt: '2026-09-09T00:01:00.000Z',
  };
  const common = {
    executionProfile: {
      baseRevision: 'a'.repeat(40), build: null, install: { operation: 'ci' as const, tool: 'npm' as const }, nodeMajor: 24,
      packageManager: 'npm', profileIdentity: 'b'.repeat(64), profileVersion: 2 as const, runtimeFamily: 'node', status: 'ready' as const,
      test: { script: 'test' as const, tool: 'npm' as const }, testRunner: 'node-test', typecheck: null,
    },
    installation: { accountLogin: 'xmodneo', accountType: 'User', installationId: 7001, status: 'active' },
    investigationRequestId: '22222222-2222-4222-8222-222222222222', repairRequestId: '11111111-1111-4111-8111-111111111111', repairRun,
    selectedRepository: { defaultBranch: 'main', fullName: 'xmodneo/vigilo', id: 8101, isPrivate: false }, workspaceId: 'workspace-1',
  };
  const eligible = renderToStaticMarkup(<GitHubConnectionView {...common} />);
  assert.match(eligible, /Inspect durable Repair Runs/); assert.match(eligible, /Prepare investigation/);
  assert.match(eligible, /action="\/api\/repair-runs\/11111111-1111-4111-8111-111111111111\/investigation"/);
  const prepared = renderToStaticMarkup(<GitHubConnectionView {...common} investigation={{
    id: '33333333-3333-4333-8333-333333333333', repairRunId: repairRun.id, repairObjective: repairRun.repairObjective,
    state: 'ready', revision: repairRun.revision, profileIdentity: repairRun.profileIdentity, baselineAvailable: true,
    treeSha: 'c'.repeat(40), indexedPathCount: 42, excludedPathCount: 3, treeTruncated: false,
    contextBudget: { version: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50 },
    failureCode: null, createdAt: repairRun.createdAt, completedAt: repairRun.completedAt, updatedAt: repairRun.completedAt!,
  }} />);
  assert.match(prepared, /Bounded repository context/); assert.match(prepared, /Paths indexed.*42/); assert.match(prepared, /Baseline evidence.*Available/);
  assert.match(prepared, /Repair Candidate/); assert.match(prepared, /No repair candidate yet/);
  assert.doesNotMatch(prepared, /Prepare investigation/);

  const frozen = renderToStaticMarkup(<GitHubConnectionView {...common} investigation={{
    id: '33333333-3333-4333-8333-333333333333', repairRunId: repairRun.id, repairObjective: repairRun.repairObjective,
    state: 'ready', revision: repairRun.revision, profileIdentity: repairRun.profileIdentity, baselineAvailable: true,
    treeSha: 'c'.repeat(40), indexedPathCount: 42, excludedPathCount: 3, treeTruncated: false,
    contextBudget: { version: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50 },
    failureCode: null, createdAt: repairRun.createdAt, completedAt: repairRun.completedAt, updatedAt: repairRun.completedAt!,
  }} repairCandidate={{
    id: '44444444-4444-4444-8444-444444444444', investigationId: '33333333-3333-4333-8333-333333333333', ordinal: 1,
    state: 'frozen', candidateIdentity: 'd'.repeat(64), changedFileCount: 1, totalResultBytes: 48, rejectionCode: null,
    createdAt: repairRun.createdAt, completedAt: repairRun.completedAt,
  }} />);
  assert.match(frozen, /Attempt.*1/); assert.match(frozen, /Status.*frozen/); assert.match(frozen, /Files changed.*1/); assert.match(frozen, /dddddddddddd/);
  assert.match(frozen, /action="\/api\/candidate-verifications"/); assert.match(frozen, /Verify candidate/);
  assert.doesNotMatch(frozen, /api\/repair-candidates|Approve candidate|Publish candidate|Edit candidate/);

  const verified = renderToStaticMarkup(<GitHubConnectionView {...common} investigation={{
    id: '33333333-3333-4333-8333-333333333333', repairRunId: repairRun.id, repairObjective: repairRun.repairObjective,
    state: 'ready', revision: repairRun.revision, profileIdentity: repairRun.profileIdentity, baselineAvailable: true,
    treeSha: 'c'.repeat(40), indexedPathCount: 42, excludedPathCount: 3, treeTruncated: false,
    contextBudget: { version: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50 },
    failureCode: null, createdAt: repairRun.createdAt, completedAt: repairRun.completedAt, updatedAt: repairRun.completedAt!,
  }} repairCandidate={{
    id: '44444444-4444-4444-8444-444444444444', investigationId: '33333333-3333-4333-8333-333333333333', ordinal: 1,
    state: 'frozen', candidateIdentity: 'd'.repeat(64), changedFileCount: 1, totalResultBytes: 48, rejectionCode: null,
    createdAt: repairRun.createdAt, completedAt: repairRun.completedAt,
  }} candidateVerification={{
    id: '55555555-5555-4555-8555-555555555555', candidateId: '44444444-4444-4444-8444-444444444444', state: 'completed',
    revision: repairRun.revision, candidateIdentity: 'd'.repeat(64), artifactIntegrity: 'valid', regressionChecks: 'checks_failed',
    baselineComparison: 'regression_detected', repairObjectiveEvidence: 'not_measured', evidenceId: '66666666-6666-4666-8666-666666666666',
    executionOutcome: 'test_failed', failingPhase: 'test', networkIsolation: 'confirmed', cleanup: 'confirmed', failureCode: null,
    createdAt: repairRun.createdAt, completedAt: repairRun.completedAt,
  }} />);
  assert.match(verified, /Candidate verification/); assert.match(verified, /Artifact integrity.*Passed/); assert.match(verified, /Regression checks.*Failed/);
  assert.match(verified, /Baseline comparison.*regression detected/); assert.match(verified, /Repair objective proof.*Not measured/);
  assert.match(verified, /Execution outcome.*test failed/); assert.match(verified, /Failing phase.*Tests/);
  assert.match(verified, /Network isolation.*confirmed/); assert.match(verified, /Cleanup.*confirmed/); assert.match(verified, /Verify candidate again/);
  assert.doesNotMatch(verified, /Approve|Publish|Create PR/);
});
