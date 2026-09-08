import {
  bigint,
  boolean,
  check,
  index,
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

export const authSchema = {
  account,
  githubInstallation,
  githubInstallationAttempt,
  githubRepositoryAccessAttempt,
  repository,
  session,
  user,
  verification,
  workspace,
};
