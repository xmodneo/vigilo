import assert from 'node:assert/strict';
import test from 'node:test';

import {
  presentError,
  presentExecutionAvailability,
  presentLiveAcceptanceStatus,
  presentRepositoryEligibility,
  presentWorkflowStatus,
} from '../lib/presentation/policy.js';

test('canonical workflow presentation exposes safe user language and actions', () => {
  assert.deepEqual(presentWorkflowStatus('diagnosis_ready'), {
    label: 'Diagnosis ready',
    explanation: 'Vigilo completed a bounded AI assessment for this exact investigation.',
    actionAvailable: true,
    primaryCta: 'Generate repair candidate',
  });
  assert.equal(presentWorkflowStatus('published').label, 'Draft PR published');
  assert.equal(presentWorkflowStatus('review_required').label, 'Review required');
});

test('unknown workflow states fail closed as an operational failure', () => {
  for (const value of [undefined, null, '', 'made_up', 1, {}, []]) {
    const presentation = presentWorkflowStatus(value);
    assert.equal(presentation.label, 'Operational failure');
    assert.equal(presentation.actionAvailable, false);
    assert.equal(presentation.primaryCta, null);
  }
});

test('stable internal error codes map to safe recovery messages', () => {
  assert.match(presentError('private_repository_not_supported').message, /public repositories only/i);
  assert.match(presentError('execution_authority_missing').message, /not authorized/i);
  assert.match(presentError('live_acceptance_pending').message, /independent live acceptance remains pending/i);
  assert.match(presentError('rate_limited').message, /too many requests/i);

  const unknown = presentError('postgres password=secret provider body');
  assert.equal(unknown.message, 'Vigilo could not complete that request safely. Refresh and try again.');
  assert.equal(unknown.technicalCode, undefined);
  assert.doesNotMatch(JSON.stringify(unknown), /password|provider body/i);
});

test('repository and execution availability presentations use explicit allowlists', () => {
  assert.equal(presentRepositoryEligibility('eligible_for_inspection').label, 'Eligible for inspection');
  assert.equal(presentRepositoryEligibility('private_unsupported').label, 'Private — not supported in this beta');
  assert.equal(presentRepositoryEligibility('unexpected').actionAvailable, false);

  assert.equal(presentExecutionAvailability('available').actionAvailable, true);
  assert.match(presentExecutionAvailability('available').explanation, /not a provider billing guarantee/i);
  assert.equal(presentExecutionAvailability('no_authority').actionAvailable, false);
  assert.match(presentExecutionAvailability('no_authority').explanation, /External execution is not authorized/);
  assert.equal(presentExecutionAvailability('unexpected').actionAvailable, false);
  assert.equal(presentLiveAcceptanceStatus('passed'), 'Passed');
  assert.equal(presentLiveAcceptanceStatus('revoked'), 'Revoked');
  assert.equal(presentLiveAcceptanceStatus('made_up'), 'Unavailable');
});
