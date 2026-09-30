export interface UserFacingPresentation {
  label: string;
  explanation: string;
  actionAvailable: boolean;
  primaryCta: string | null;
}

const workflowPresentations = {
  queued: { label: 'Queued', explanation: 'The request is stored and waiting for the worker.', actionAvailable: false, primaryCta: null },
  running_baseline: { label: 'Running baseline', explanation: 'Vigilo is measuring the frozen repository revision.', actionAvailable: false, primaryCta: null },
  baseline_failed: { label: 'Baseline failed', explanation: 'The baseline found a reproducible required check that did not pass.', actionAvailable: true, primaryCta: 'Prepare investigation' },
  baseline_unavailable: { label: 'Baseline unavailable', explanation: 'Vigilo could not establish trustworthy baseline evidence.', actionAvailable: false, primaryCta: null },
  ready_for_investigation: { label: 'Ready for investigation', explanation: 'The frozen baseline is trustworthy and bounded context can be prepared.', actionAvailable: true, primaryCta: 'Prepare investigation' },
  preparing_context: { label: 'Preparing context', explanation: 'Vigilo is building bounded, read-only repository context.', actionAvailable: false, primaryCta: null },
  context_ready: { label: 'Context ready', explanation: 'Bounded repository context is ready for an authorized AI investigation.', actionAvailable: true, primaryCta: 'Start AI investigation' },
  diagnosing: { label: 'Diagnosing', explanation: 'The bounded AI investigation is reviewing observed evidence.', actionAvailable: false, primaryCta: null },
  diagnosis_ready: { label: 'Diagnosis ready', explanation: 'Vigilo completed a bounded AI assessment for this exact investigation.', actionAvailable: true, primaryCta: 'Generate repair candidate' },
  no_diagnosis: { label: 'No diagnosis', explanation: 'The bounded investigation did not find enough evidence for a diagnosis.', actionAvailable: false, primaryCta: null },
  generating_repair: { label: 'Generating repair', explanation: 'Vigilo is preparing an exact candidate from the observed evidence.', actionAvailable: false, primaryCta: null },
  candidate_frozen: { label: 'Candidate frozen', explanation: 'The exact changed-file artifact is immutable and ready for fresh verification.', actionAvailable: true, primaryCta: 'Verify candidate' },
  verifying: { label: 'Verifying', explanation: 'A fresh verifier is checking the exact frozen candidate.', actionAvailable: false, primaryCta: null },
  verification_passed: { label: 'Verification passed', explanation: 'The exact frozen candidate passed fresh checks; objective evidence is evaluated separately.', actionAvailable: false, primaryCta: null },
  repair_failed_verification: { label: 'Repair failed verification', explanation: 'The candidate did not pass the required fresh checks.', actionAvailable: false, primaryCta: null },
  no_repair_proposed: { label: 'No repair proposed', explanation: 'The bounded generation completed without a safe repair proposal.', actionAvailable: false, primaryCta: null },
  attempt_limit_reached: { label: 'Attempt limit reached', explanation: 'The bounded repair loop used its permitted iterations without a verified repair.', actionAvailable: false, primaryCta: null },
  verified_ready_for_review: { label: 'Verified repair ready for review', explanation: 'The selected candidate passed fresh verification and its measurable objective.', actionAvailable: true, primaryCta: 'Review exact candidate' },
  review_required: { label: 'Review required', explanation: 'The result is ambiguous or unmeasured and requires reconciliation; it cannot be approved.', actionAvailable: false, primaryCta: null },
  approved: { label: 'Approved', explanation: 'A reviewer immutably approved the exact candidate and verification evidence.', actionAvailable: false, primaryCta: null },
  rejected: { label: 'Rejected', explanation: 'A reviewer immutably rejected this exact candidate.', actionAvailable: false, primaryCta: null },
  publication_unavailable: { label: 'Publication unavailable', explanation: 'The independent publication requirements are not satisfied.', actionAvailable: false, primaryCta: null },
  publishing: { label: 'Publishing draft PR', explanation: 'Vigilo is reconciling the exact branch, commit, and draft pull request.', actionAvailable: false, primaryCta: null },
  published: { label: 'Draft PR published', explanation: 'The exact approved candidate was published as a draft pull request.', actionAvailable: true, primaryCta: 'Open draft pull request' },
  publication_reconciliation: { label: 'Publication needs reconciliation', explanation: 'The remote publication outcome is ambiguous and no retry is available.', actionAvailable: false, primaryCta: null },
  operational_failure: { label: 'Operational failure', explanation: 'Vigilo stopped safely before it could establish a trustworthy result.', actionAvailable: false, primaryCta: null },
} as const satisfies Record<string, UserFacingPresentation>;

export type WorkflowPresentationStatus = keyof typeof workflowPresentations;

export function presentWorkflowStatus(status: unknown): UserFacingPresentation {
  return typeof status === 'string' && status in workflowPresentations
    ? workflowPresentations[status as WorkflowPresentationStatus]
    : workflowPresentations.operational_failure;
}

const errorMessages = {
  private_repository_not_supported: 'Vigilo currently supports public repositories only. Choose a public repository to continue.',
  installation_unavailable: 'The GitHub App installation could not be verified. Refresh the connection and try again.',
  connection_failed: 'The GitHub connection could not be completed. Refresh and try again.',
  installation_required: 'Connect the GitHub App before choosing a repository.',
  repository_access_changed: 'Repository access changed. Refresh access before continuing.',
  repository_access_lost: 'Vigilo no longer has the required repository access. Refresh the GitHub App installation.',
  repository_access_unavailable: 'Repository access could not be verified. Refresh and try again.',
  repository_access_failed: 'Repository access could not be refreshed. Verify the GitHub App installation and try again.',
  provider_failure: 'The configured provider could not complete the operation. Existing history remains available.',
  provider_quota_exhausted: 'The configured provider quota is exhausted. Existing history remains available.',
  provider_rate_limited: 'The configured provider rate limit was reached. Wait before retrying.',
  provider_infrastructure_failed: 'The configured provider is temporarily unavailable. Existing history remains available.',
  provider_configuration_failed: 'The configured provider is unavailable because its server configuration is invalid.',
  profile_unavailable: 'Repository eligibility has not been established. Check eligibility again.',
  profile_detection_unavailable: 'Vigilo could not check repository eligibility. Refresh and try again.',
  profile_detection_failed: 'Vigilo could not check repository eligibility. Refresh and try again.',
  baseline_unavailable: 'Trustworthy baseline evidence is unavailable, so the repair cannot continue.',
  source_unavailable: 'The frozen repository source could not be read safely. Refresh access before retrying.',
  objective_not_measured: 'The technical objective was not measured, so this result cannot be approved.',
  execution_authority_missing: 'External execution is not authorized. Existing repair history remains available.',
  execution_authority_expired: 'External execution authority expired. A new server-side authorization is required.',
  execution_authority_mismatch: 'External execution authority is invalid for this operation. No provider work was started.',
  execution_budget_exhausted: 'The authorized execution limit has been reached. Existing repair history remains available.',
  external_concurrency_unavailable: 'External execution capacity is currently in use. Refresh after the active operation finishes.',
  human_review_ineligible: 'This result does not have the exact verified evidence required for human approval.',
  repair_loop_not_verified: 'No terminal verified Repair Loop artifact is available for approval.',
  candidate_invalid: 'The frozen candidate failed its deterministic identity self-check.',
  verification_not_passed: 'The exact selected verification did not pass the required checks.',
  evidence_invalid: 'The selected verification evidence is incomplete, untrusted, or inconsistent.',
  authority_mismatch: 'The selected artifacts do not share one exact authority chain.',
  review_subject_stale: 'The review evidence changed before submission. Refresh and review the exact current candidate.',
  active_conflict: 'Another bounded operation is still active for this repair. Wait for it to finish.',
  live_acceptance_pending: 'Draft publication is unavailable while independent live acceptance remains pending.',
  rate_limited: 'Too many requests were made. Wait briefly and try again.',
  rate_limit_unavailable: 'Request safety controls are unavailable, so the operation was not accepted.',
  unauthorized: 'Sign in to continue.',
  forbidden: 'You do not have authority to perform this action.',
  ambiguous_test_runner: 'Multiple test runners were detected.',
  conflicting_lockfiles: 'Competing package-manager lockfiles were found.',
  invalid_package_lock: 'package-lock.json could not be validated.',
  invalid_script_graph: 'The test script delegation graph is unsafe or ambiguous.',
  malformed_package_json: 'package.json could not be validated.',
  missing_package_json: 'A root package.json is required.',
  missing_package_lock: 'A committed root package-lock.json is required.',
  missing_test_script: 'A root test script is required.',
  unsupported_monorepo: 'Workspaces and monorepo layouts are not supported in Vigilo V1.',
  unsupported_node_version: 'The repository must support Node.js 24.',
  unsupported_package_manager: 'The repository must use npm.',
  unsupported_test_runner: 'Use Node test, Vitest, or Jest for Vigilo V1.',
} as const;

export type SafeErrorCode = keyof typeof errorMessages;

export function normalizeSafeErrorCode(code: unknown): SafeErrorCode | undefined {
  return typeof code === 'string' && code in errorMessages ? code as SafeErrorCode : undefined;
}

export function presentError(code: unknown): { message: string; technicalCode?: SafeErrorCode } {
  const technicalCode = normalizeSafeErrorCode(code);
  if (technicalCode) {
    return { message: errorMessages[technicalCode], technicalCode };
  }
  return { message: 'Vigilo could not complete that request safely. Refresh and try again.' };
}

const repositoryPresentations = {
  eligible_for_inspection: { label: 'Eligible for inspection', explanation: 'The repository matches the checked V1 profile.', actionAvailable: true, primaryCta: 'Select repository' },
  not_checked: { label: 'Eligibility not checked', explanation: 'Select this public repository to check its exact frozen revision.', actionAvailable: true, primaryCta: 'Select and check eligibility' },
  unsupported: { label: 'Unsupported', explanation: 'The checked repository does not meet the V1 execution contract.', actionAvailable: true, primaryCta: 'Check eligibility again' },
  private_unsupported: { label: 'Private — not supported in this beta', explanation: 'Vigilo will not inspect source or start work for this repository.', actionAvailable: false, primaryCta: null },
  access_stale: { label: 'Access stale — refresh required', explanation: 'Repository access must be verified again before any action.', actionAvailable: false, primaryCta: 'Refresh access' },
} as const satisfies Record<string, UserFacingPresentation>;

export type RepositoryEligibility = keyof typeof repositoryPresentations;

export function presentRepositoryEligibility(status: unknown): UserFacingPresentation {
  return typeof status === 'string' && status in repositoryPresentations
    ? repositoryPresentations[status as RepositoryEligibility]
    : repositoryPresentations.access_stale;
}

const executionPresentations = {
  available: { label: 'External execution authorized', explanation: 'Execution is bounded by Vigilo’s server-side limits. These limits are not a provider billing guarantee.', actionAvailable: true, primaryCta: null },
  no_authority: { label: 'External execution unavailable', explanation: 'External execution is not authorized. You can inspect existing repair history, but starting provider-backed work is unavailable.', actionAvailable: false, primaryCta: null },
  invalid_or_expired: { label: 'External execution unavailable', explanation: 'Execution authority is expired or invalid. Existing repair history remains available.', actionAvailable: false, primaryCta: null },
  exhausted: { label: 'Execution limit reached', explanation: 'The authorized execution budget is exhausted. Existing repair history remains available.', actionAvailable: false, primaryCta: null },
  capacity_unavailable: { label: 'External capacity unavailable', explanation: 'Authorized external capacity is currently in use. Refresh after the active operation finishes.', actionAvailable: false, primaryCta: null },
  operational_unavailable: { label: 'Execution service unavailable', explanation: 'Operational readiness is not established. Existing history remains viewable, but provider-backed work is unavailable.', actionAvailable: false, primaryCta: null },
  unknown: { label: 'External execution unavailable', explanation: 'Execution availability could not be verified safely. Existing repair history remains available.', actionAvailable: false, primaryCta: null },
} as const satisfies Record<string, UserFacingPresentation>;

export type ExecutionAvailabilityStatus = keyof typeof executionPresentations;

export function presentExecutionAvailability(status: unknown): UserFacingPresentation {
  return typeof status === 'string' && status in executionPresentations
    ? executionPresentations[status as ExecutionAvailabilityStatus]
    : executionPresentations.unknown;
}

export function presentLiveAcceptanceStatus(status: unknown): string {
  if (status === 'passed') return 'Passed';
  if (status === 'pending') return 'Pending';
  if (status === 'revoked') return 'Revoked';
  if (status === 'failed') return 'Failed';
  return 'Unavailable';
}
