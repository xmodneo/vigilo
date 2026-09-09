import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    issuer: text('issuer').notNull(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('account_user_id_idx').on(table.userId),
    uniqueIndex('account_issuer_account_id_unique').on(table.issuer, table.accountId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const workspace = pgTable(
  'workspace',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('workspace_owner_user_id_unique').on(table.ownerUserId)],
);

export const githubInstallation = pgTable(
  'github_installation',
  {
    installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .unique()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    githubAccountId: bigint('github_account_id', { mode: 'number' }).notNull(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'github_installation_account_type_check',
      sql`${table.accountType} in ('User', 'Organization')`,
    ),
    check('github_installation_status_check', sql`${table.status} = 'active'`),
  ],
);

export const githubInstallationAttempt = pgTable(
  'github_installation_attempt',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    stateHash: text('state_hash').notNull().unique(),
    phase: text('phase').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }),
    codeVerifier: text('code_verifier'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('github_installation_attempt_workspace_id_idx').on(table.workspaceId),
    index('github_installation_attempt_session_id_idx').on(table.sessionId),
    index('github_installation_attempt_expires_at_idx').on(table.expiresAt),
    check(
      'github_installation_attempt_phase_check',
      sql`${table.phase} in ('installation', 'authorization')`,
    ),
  ],
);

export const repository = pgTable(
  'repository',
  {
    githubRepositoryId: bigint('github_repository_id', { mode: 'number' }).primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .unique()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' })
      .notNull()
      .references(() => githubInstallation.installationId, { onDelete: 'cascade' }),
    ownerId: bigint('owner_id', { mode: 'number' }).notNull(),
    ownerLogin: text('owner_login').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch'),
    isPrivate: boolean('is_private').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('repository_installation_id_idx').on(table.installationId)],
);

export const githubRepositoryAccessAttempt = pgTable(
  'github_repository_access_attempt',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' })
      .notNull()
      .references(() => githubInstallation.installationId, { onDelete: 'cascade' }),
    stateHash: text('state_hash').notNull().unique(),
    operation: text('operation').notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }),
    codeVerifier: text('code_verifier'),
    repositoriesJson: text('repositories_json'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('github_repository_access_attempt_workspace_id_idx').on(table.workspaceId),
    index('github_repository_access_attempt_session_id_idx').on(table.sessionId),
    index('github_repository_access_attempt_expires_at_idx').on(table.expiresAt),
    check(
      'github_repository_access_attempt_operation_check',
      sql`${table.operation} in ('list', 'select')`,
    ),
    check(
      'github_repository_access_attempt_repository_check',
      sql`(${table.operation} = 'list' and ${table.repositoryId} is null) or (${table.operation} = 'select' and ${table.repositoryId} is not null)`,
    ),
  ],
);

export const executionProfile = pgTable(
  'execution_profile',
  {
    githubRepositoryId: bigint('github_repository_id', { mode: 'number' })
      .primaryKey()
      .references(() => repository.githubRepositoryId, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' })
      .notNull()
      .references(() => githubInstallation.installationId, { onDelete: 'cascade' }),
    profileVersion: integer('profile_version').notNull(),
    profileIdentity: text('profile_identity').unique(),
    baseCommitSha: text('base_commit_sha').notNull(),
    runtimeFamily: text('runtime_family'),
    nodeMajor: integer('node_major'),
    packageManager: text('package_manager'),
    lockfileType: text('lockfile_type'),
    installOperation: text('install_operation'),
    typecheckScript: text('typecheck_script'),
    buildScript: text('build_script'),
    testScript: text('test_script'),
    testRunner: text('test_runner'),
    packageJsonBlobSha: text('package_json_blob_sha'),
    packageJsonContentSha256: text('package_json_content_sha256'),
    packageLockBlobSha: text('package_lock_blob_sha'),
    packageLockContentSha256: text('package_lock_content_sha256'),
    status: text('status').notNull(),
    unsupportedReason: text('unsupported_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('execution_profile_workspace_id_idx').on(table.workspaceId),
    index('execution_profile_installation_id_idx').on(table.installationId),
    check('execution_profile_version_check', sql`${table.profileVersion} = 2`),
    check('execution_profile_commit_sha_check', sql`${table.baseCommitSha} ~ '^[0-9a-f]{40}$'`),
    check(
      'execution_profile_status_check',
      sql`${table.status} in ('ready', 'unsupported')`,
    ),
    check(
      'execution_profile_ready_fields_check',
      sql`(
        ${table.status} = 'ready'
        and ${table.profileIdentity} ~ '^[0-9a-f]{64}$'
        and ${table.runtimeFamily} = 'node'
        and ${table.nodeMajor} = 24
        and ${table.packageManager} = 'npm'
        and ${table.lockfileType} = 'package-lock'
        and ${table.installOperation} = 'ci'
        and (${table.typecheckScript} is null or ${table.typecheckScript} = 'typecheck')
        and (${table.buildScript} is null or ${table.buildScript} = 'build')
        and ${table.testScript} = 'test'
        and ${table.testRunner} in ('node-test', 'vitest', 'jest')
        and ${table.packageJsonBlobSha} ~ '^[0-9a-f]{40}$'
        and ${table.packageJsonContentSha256} ~ '^[0-9a-f]{64}$'
        and ${table.packageLockBlobSha} ~ '^[0-9a-f]{40}$'
        and ${table.packageLockContentSha256} ~ '^[0-9a-f]{64}$'
        and ${table.unsupportedReason} is null
      ) or (
        ${table.status} = 'unsupported'
        and ${table.profileIdentity} is null
        and ${table.runtimeFamily} is null
        and ${table.nodeMajor} is null
        and ${table.packageManager} is null
        and ${table.lockfileType} is null
        and ${table.installOperation} is null
        and ${table.typecheckScript} is null
        and ${table.buildScript} is null
        and ${table.testScript} is null
        and ${table.testRunner} is null
        and ${table.packageJsonBlobSha} is null
        and ${table.packageJsonContentSha256} is null
        and ${table.packageLockBlobSha} is null
        and ${table.packageLockContentSha256} is null
        and ${table.unsupportedReason} in (
          'ambiguous_test_runner',
          'conflicting_lockfiles',
          'invalid_package_lock',
          'invalid_script_graph',
          'malformed_package_json',
          'missing_package_json',
          'missing_package_lock',
          'missing_test_script',
          'unsupported_monorepo',
          'unsupported_node_version',
          'unsupported_package_manager',
          'unsupported_test_runner'
        )
      )`,
    ),
  ],
);

export const repositoryBaseline = pgTable(
  'repository_baseline',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
    githubRepositoryId: bigint('github_repository_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    evidenceVersion: integer('evidence_version').notNull(),
    profileIdentity: text('profile_identity').notNull(),
    baseCommitSha: text('base_commit_sha').notNull(),
    archiveSha256: text('archive_sha256').notNull(),
    sandboxName: text('sandbox_name').notNull(),
    sandboxSessionId: text('sandbox_session_id'),
    sourceIdentityBefore: text('source_identity_before'),
    sourceIdentityAfter: text('source_identity_after'),
    sourceUnchanged: boolean('source_unchanged'),
    credentialsExposure: text('credentials_exposure').notNull(),
    networkPolicy: text('network_policy').notNull(),
    installStatus: text('install_status').notNull(),
    installExitCode: integer('install_exit_code'),
    installTimedOut: boolean('install_timed_out').notNull(),
    typecheckStatus: text('typecheck_status'),
    typecheckExitCode: integer('typecheck_exit_code'),
    typecheckTimedOut: boolean('typecheck_timed_out'),
    buildStatus: text('build_status'),
    buildExitCode: integer('build_exit_code'),
    buildTimedOut: boolean('build_timed_out'),
    testStatus: text('test_status').notNull(),
    testExitCode: integer('test_exit_code'),
    testTimedOut: boolean('test_timed_out').notNull(),
    executionOutcome: text('execution_outcome').notNull(),
    overallOutcome: text('overall_outcome').notNull(),
    cleanupStop: text('cleanup_stop').notNull(),
    cleanupDelete: text('cleanup_delete').notNull(),
    cleanupLookup: text('cleanup_lookup').notNull(),
    errorPhase: text('error_phase'),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (table) => [
    index('repository_baseline_workspace_id_idx').on(table.workspaceId),
    index('repository_baseline_repository_id_idx').on(table.githubRepositoryId),
    check('repository_baseline_version_check', sql`${table.evidenceVersion} = 1`),
    check('repository_baseline_commit_check', sql`${table.baseCommitSha} ~ '^[0-9a-f]{40}$'`),
    check('repository_baseline_hashes_check', sql`${table.profileIdentity} ~ '^[0-9a-f]{64}$' and ${table.archiveSha256} ~ '^[0-9a-f]{64}$' and (${table.sourceIdentityBefore} is null or ${table.sourceIdentityBefore} ~ '^[0-9a-f]{64}$') and (${table.sourceIdentityAfter} is null or ${table.sourceIdentityAfter} ~ '^[0-9a-f]{64}$')`),
    check('repository_baseline_credentials_check', sql`${table.credentialsExposure} in ('absent', 'present', 'not_checked')`),
    check('repository_baseline_network_check', sql`${table.networkPolicy} in ('deny-all', 'unconfirmed')`),
    check('repository_baseline_phase_status_check', sql`${table.installStatus} in ('not_run','completed','failed','timed_out') and (${table.typecheckStatus} is null or ${table.typecheckStatus} in ('not_run','completed','failed','timed_out')) and (${table.buildStatus} is null or ${table.buildStatus} in ('not_run','completed','failed','timed_out')) and ${table.testStatus} in ('not_run','completed','failed','timed_out')`),
    check('repository_baseline_outcome_check', sql`${table.executionOutcome} in ('baseline_passed','baseline_failed','installation_failed','typecheck_failed','build_failed','test_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed') and ${table.overallOutcome} in ('baseline_passed','baseline_failed','installation_failed','typecheck_failed','build_failed','test_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed')`),
    check('repository_baseline_clean_success_check', sql`${table.overallOutcome} <> 'baseline_passed' or (${table.executionOutcome} = 'baseline_passed' and ${table.credentialsExposure} = 'absent' and ${table.networkPolicy} = 'deny-all' and ${table.sourceIdentityBefore} = ${table.sourceIdentityAfter} and ${table.sourceUnchanged} is true and ${table.installStatus} = 'completed' and ${table.installExitCode} = 0 and ${table.installTimedOut} is false and (${table.typecheckStatus} is null or (${table.typecheckStatus} = 'completed' and ${table.typecheckExitCode} = 0 and ${table.typecheckTimedOut} is false)) and (${table.buildStatus} is null or (${table.buildStatus} = 'completed' and ${table.buildExitCode} = 0 and ${table.buildTimedOut} is false)) and ${table.testStatus} = 'completed' and ${table.testExitCode} = 0 and ${table.testTimedOut} is false and ${table.cleanupStop} = 'confirmed' and ${table.cleanupDelete} = 'confirmed' and ${table.cleanupLookup} = 'absent' and ${table.errorCode} is null)`),
    check('repository_baseline_duration_check', sql`${table.durationMs} >= 0`),
  ],
);

export const repairRun = pgTable(
  'repair_run',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
    githubRepositoryId: bigint('github_repository_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    profileIdentity: text('profile_identity').notNull(),
    baseCommitSha: text('base_commit_sha').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    state: text('state').notNull(),
    baselineId: text('baseline_id').unique().references(() => repositoryBaseline.id, { onDelete: 'restrict' }),
    baselineOutcome: text('baseline_outcome'),
    failureClassification: text('failure_classification'),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    baselineStartedAt: timestamp('baseline_started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('repair_run_workspace_idempotency_unique').on(table.workspaceId, table.idempotencyKey),
    uniqueIndex('repair_run_active_identity_unique')
      .on(table.workspaceId, table.githubRepositoryId, table.installationId, table.profileIdentity, table.baseCommitSha)
      .where(sql`${table.state} in ('created','baseline_running')`),
    index('repair_run_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('repair_run_repository_idx').on(table.githubRepositoryId),
    check('repair_run_commit_check', sql`${table.baseCommitSha} ~ '^[0-9a-f]{40}$'`),
    check('repair_run_profile_identity_check', sql`${table.profileIdentity} ~ '^[0-9a-f]{64}$'`),
    check('repair_run_idempotency_check', sql`${table.idempotencyKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
    check('repair_run_state_check', sql`${table.state} in ('created','baseline_running','ready_for_investigation','baseline_failed','infrastructure_failed','cancelled')`),
    check('repair_run_baseline_outcome_check', sql`${table.baselineOutcome} is null or ${table.baselineOutcome} in ('baseline_passed','baseline_failed','installation_failed','typecheck_failed','build_failed','test_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed')`),
    check('repair_run_failure_facts_check', sql`(${table.failureClassification} is null or ${table.failureClassification} in ('customer_baseline_failure','infrastructure_failure','cancelled')) and (${table.failureCode} is null or ${table.failureCode} ~ '^[a-z_]{1,64}$')`),
    check('repair_run_state_facts_check', sql`(
      ${table.state} = 'created' and ${table.baselineStartedAt} is null and ${table.completedAt} is null and ${table.baselineId} is null and ${table.baselineOutcome} is null
    ) or (
      ${table.state} = 'baseline_running' and ${table.baselineStartedAt} is not null and ${table.completedAt} is null and ${table.baselineId} is null and ${table.baselineOutcome} is null
    ) or (
      ${table.state} = 'ready_for_investigation' and ${table.baselineStartedAt} is not null and ${table.completedAt} is not null and ${table.baselineId} is not null and ${table.baselineOutcome} = 'baseline_passed' and ${table.failureClassification} is null and ${table.failureCode} is null
    ) or (
      ${table.state} = 'baseline_failed' and ${table.baselineStartedAt} is not null and ${table.completedAt} is not null and ${table.baselineId} is not null and ${table.baselineOutcome} in ('baseline_failed','typecheck_failed','build_failed','test_failed') and ${table.failureClassification} = 'customer_baseline_failure'
    ) or (
      ${table.state} = 'infrastructure_failed' and ${table.baselineStartedAt} is not null and ${table.completedAt} is not null and ${table.failureClassification} = 'infrastructure_failure' and ${table.failureCode} is not null
    ) or (
      ${table.state} = 'cancelled' and ${table.completedAt} is not null and ${table.failureClassification} = 'cancelled'
    )`),
  ],
);

export const repairRunEvent = pgTable(
  'repair_run_event',
  {
    id: text('id').primaryKey(),
    repairRunId: text('repair_run_id').notNull().references(() => repairRun.id, { onDelete: 'cascade' }),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    baselineOutcome: text('baseline_outcome'),
    failureClassification: text('failure_classification'),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('repair_run_event_run_created_idx').on(table.repairRunId, table.createdAt),
    check('repair_run_event_from_state_check', sql`${table.fromState} is null or ${table.fromState} in ('created','baseline_running','ready_for_investigation','baseline_failed','infrastructure_failed','cancelled')`),
    check('repair_run_event_to_state_check', sql`${table.toState} in ('created','baseline_running','ready_for_investigation','baseline_failed','infrastructure_failed','cancelled')`),
    check('repair_run_event_transition_check', sql`(${table.fromState} is null and ${table.toState} = 'created') or (${table.fromState} = 'created' and ${table.toState} in ('baseline_running','cancelled')) or (${table.fromState} = 'baseline_running' and ${table.toState} in ('ready_for_investigation','baseline_failed','infrastructure_failed','cancelled'))`),
    check('repair_run_event_outcome_check', sql`${table.baselineOutcome} is null or ${table.baselineOutcome} in ('baseline_passed','baseline_failed','installation_failed','typecheck_failed','build_failed','test_failed','timed_out','cancelled','infrastructure_failed','cleanup_failed')`),
    check('repair_run_event_failure_facts_check', sql`(${table.failureClassification} is null or ${table.failureClassification} in ('customer_baseline_failure','infrastructure_failure','cancelled')) and (${table.failureCode} is null or ${table.failureCode} ~ '^[a-z_]{1,64}$')`),
  ],
);

export const repairRunAttempt = pgTable(
  'repair_run_attempt',
  {
    id: text('id').primaryKey(),
    repairRunId: text('repair_run_id').notNull().references(() => repairRun.id, { onDelete: 'cascade' }),
    queueJobId: text('queue_job_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    expectedBaselineId: text('expected_baseline_id').notNull().unique(),
    ownershipToken: text('ownership_token').notNull(),
    state: text('state').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    baselineId: text('baseline_id').unique().references(() => repositoryBaseline.id, { onDelete: 'restrict' }),
    sandboxName: text('sandbox_name'),
    sandboxSessionId: text('sandbox_session_id'),
    cleanupStop: text('cleanup_stop'),
    cleanupDelete: text('cleanup_delete'),
    cleanupLookup: text('cleanup_lookup'),
    failureClassification: text('failure_classification'),
    failureCode: text('failure_code'),
  },
  (table) => [
    uniqueIndex('repair_run_attempt_number_unique').on(table.repairRunId, table.attemptNumber),
    uniqueIndex('repair_run_attempt_active_unique').on(table.repairRunId).where(sql`${table.state} = 'active'`),
    index('repair_run_attempt_run_idx').on(table.repairRunId, table.claimedAt),
    check('repair_run_attempt_id_check', sql`${table.id} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
    check('repair_run_attempt_job_check', sql`${table.queueJobId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
    check('repair_run_attempt_evidence_check', sql`${table.expectedBaselineId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
    check('repair_run_attempt_owner_check', sql`${table.ownershipToken} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
    check('repair_run_attempt_number_check', sql`${table.attemptNumber} between 1 and 3`),
    check('repair_run_attempt_state_check', sql`${table.state} in ('active','succeeded','customer_failed','retryable_failed','exhausted','abandoned')`),
    check('repair_run_attempt_lease_check', sql`(${table.state} = 'active' and ${table.leaseExpiresAt} is not null and ${table.finishedAt} is null) or (${table.state} <> 'active' and ${table.leaseExpiresAt} is null and ${table.finishedAt} is not null)`),
    check('repair_run_attempt_sandbox_check', sql`(${table.sandboxName} is null or ${table.sandboxName} ~ '^[a-z0-9][a-z0-9-]{0,99}$') and (${table.sandboxSessionId} is null or ${table.sandboxSessionId} ~ '^[A-Za-z0-9_-]{1,128}$')`),
    check('repair_run_attempt_cleanup_check', sql`(${table.cleanupStop} is null or ${table.cleanupStop} in ('confirmed','failed','not_needed')) and (${table.cleanupDelete} is null or ${table.cleanupDelete} in ('confirmed','failed','not_needed')) and (${table.cleanupLookup} is null or ${table.cleanupLookup} in ('absent','still_present','unconfirmed','unconfirmed_after_create_failure','not_run'))`),
    check('repair_run_attempt_failure_check', sql`(${table.failureClassification} is null or ${table.failureClassification} in ('customer_baseline_failure','infrastructure_failure','process_loss')) and (${table.failureCode} is null or ${table.failureCode} ~ '^[a-z_]{1,64}$')`),
  ],
);

export const authSchema = {
  account,
  executionProfile,
  githubInstallation,
  githubInstallationAttempt,
  githubRepositoryAccessAttempt,
  repository,
  repositoryBaseline,
  repairRun,
  repairRunAttempt,
  repairRunEvent,
  session,
  user,
  verification,
  workspace,
};
