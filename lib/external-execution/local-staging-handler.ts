import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { normalizeRepairObjective } from '../repair-runs/intent.ts';
import { buildReviewedStagingPlan, type ReviewedStagingActor, type ReviewedStagingInput } from './reviewed-plan.ts';
import type { ReviewedStagingReceipt } from './reviewed-staging.ts';

const FIXTURE_REPOSITORY_ID = 1411517943;
const FIXTURE_REVISION = '3575b04ff48cf07f9f52b5b3f8cf529520619307';
const FIXTURE_MANIFEST = '6429fda80481a0ad3330ffc233dc449e44c6041762eab2dab88a3a479416f3ea';
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_FORM_BYTES = 1024;
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

export interface LocalStagingArtifact {
  actor: ReviewedStagingActor;
  plan: ReviewedStagingInput;
  approvedPlanIdentity: string;
}

export interface LocalStagingConfiguration {
  enabled: boolean;
  nodeEnv: string | undefined;
  baseUrl: string;
  operatorOrigin: string;
  databaseUrl: string;
  releaseSha: string | undefined;
  providerAccounts: ReviewedStagingInput['providerAccounts'];
  objectiveHash: string;
}

interface Dependencies {
  configuration: LocalStagingConfiguration;
  artifact: LocalStagingArtifact;
  csrfSecret: Buffer;
  now?: () => Date;
  resolveContext(headers: Headers): Promise<AuthenticatedWorkspace | null>;
  stage(context: AuthenticatedWorkspace, plan: ReviewedStagingInput, approvedPlanIdentity: string): Promise<ReviewedStagingReceipt>;
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

/** The artifact is a local, non-secret snapshot. HTTP fields can never replace it. */
export function validateLocalStagingArtifact(
  artifact: LocalStagingArtifact, configuration: LocalStagingConfiguration, now = new Date(),
) {
  if (!exactKeys(artifact, ['actor', 'plan', 'approvedPlanIdentity']) ||
      !exactKeys(artifact.actor, ['workspaceId', 'reviewerUserId']) ||
      !SHA.test(configuration.releaseSha ?? '') || !HASH.test(configuration.objectiveHash) ||
      artifact.plan.githubRepositoryId !== FIXTURE_REPOSITORY_ID ||
      artifact.plan.baseCommitSha !== FIXTURE_REVISION ||
      artifact.plan.expectedSourceIdentity !== FIXTURE_MANIFEST ||
      artifact.plan.authorizedReleaseSha !== configuration.releaseSha ||
      artifact.plan.providerAccounts.googleProjectId !== configuration.providerAccounts.googleProjectId ||
      artifact.plan.providerAccounts.vercelTeamId !== configuration.providerAccounts.vercelTeamId ||
      artifact.plan.providerAccounts.vercelProjectId !== configuration.providerAccounts.vercelProjectId ||
      normalizeRepairObjective(artifact.plan.objective).objectiveHash !== configuration.objectiveHash)
    throw new Error('local_staging_plan_invalid');
  const reviewed = buildReviewedStagingPlan(artifact.actor, artifact.plan, now);
  const google = reviewed.operationGrants.filter((grant) => grant.providerId === 'google');
  const vercel = reviewed.operationGrants.filter((grant) => grant.providerId === 'vercel');
  if (reviewed.planIdentity !== artifact.approvedPlanIdentity || reviewed.operationGrants.length !== 5 ||
      google.length !== 2 || google.some((grant) => grant.modelId !== 'gemini-3.1-flash-lite') ||
      google.reduce((total, grant) => total + grant.maxLogicalRequests, 0) !== 5 ||
      reviewed.accountGrant.maxSandboxIdentities !== 2 || reviewed.accountGrant.maxSandboxRuntimeMs !== 1_200_000 ||
      reviewed.accountGrant.maxConcurrentExternalOperations !== 1 ||
      vercel.length !== 2 || vercel.some((grant) => grant.maxSandboxIdentities !== 1 ||
        grant.sandboxResourceClass !== 'vcpu_1' || grant.maxSandboxRuntimeMs !== 600_000))
    throw new Error('local_staging_plan_invalid');
  return reviewed;
}

function localOnly(configuration: LocalStagingConfiguration, request: Request, peerAddress: string | undefined): boolean {
  let database: URL;
  try { database = new URL(configuration.databaseUrl); } catch { return false; }
  if (!configuration.enabled || configuration.nodeEnv !== 'development' ||
      configuration.baseUrl !== 'http://localhost:3000' ||
      configuration.operatorOrigin !== 'http://localhost:3002' ||
      !SHA.test(configuration.releaseSha ?? '') ||
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.hostname !== '127.0.0.1' || database.port !== '55432' || database.pathname !== '/vigilo' ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peerAddress ?? '')) return false;
  if (request.headers.get('host') !== 'localhost:3002' ||
      request.headers.has('x-forwarded-host') || request.headers.has('x-forwarded-for')) return false;
  try { return new URL(request.url).origin === configuration.operatorOrigin; } catch { return false; }
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function html(value: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vigilo local reviewed staging</title></head><body><main><h1>Vigilo local reviewed staging</h1>${value}</main></body></html>`,
    { status, headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

function csrfToken(secret: Buffer, sessionId: string, artifact: LocalStagingArtifact): string {
  return createHmac('sha256', secret).update(`vigilo-local-staging\0${sessionId}\0${artifact.plan.repairRunId}\0${artifact.approvedPlanIdentity}`).digest('hex');
}

async function parseConfirmation(request: Request): Promise<{ confirmation: string; csrf: string; planIdentity: string } | null> {
  if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return null;
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_FORM_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FORM_BYTES) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
  } catch { return null; }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if ([...form.keys()].sort().join(',') !== 'confirmation,csrf,planIdentity' ||
      form.getAll('confirmation').length !== 1 || form.getAll('csrf').length !== 1 ||
      form.getAll('planIdentity').length !== 1) return null;
  return { confirmation: form.get('confirmation') ?? '', csrf: form.get('csrf') ?? '', planIdentity: form.get('planIdentity') ?? '' };
}

export function createLocalStagingHandler(dependencies: Dependencies) {
  if (dependencies.csrfSecret.length < 32) throw new Error('local_staging_csrf_secret_invalid');
  const artifact = structuredClone(dependencies.artifact);
  validateLocalStagingArtifact(artifact, dependencies.configuration, dependencies.now?.());
  let attempted = false;
  return async (request: Request, peerAddress: string | undefined): Promise<Response> => {
    if (!localOnly(dependencies.configuration, request, peerAddress)) return html('<p>Unavailable.</p>', 404);
    if (request.method !== 'GET' && request.method !== 'POST') return html('<p>Method unavailable.</p>', 405);
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== dependencies.configuration.operatorOrigin) return html('<p>Forbidden.</p>', 403);
      const site = request.headers.get('sec-fetch-site');
      if (site !== null && site !== 'same-origin') return html('<p>Forbidden.</p>', 403);
    }
    let context: AuthenticatedWorkspace | null;
    try { context = await dependencies.resolveContext(request.headers); }
    catch { return html('<p>Authentication unavailable.</p>', 503); }
    if (!context) return html('<p>Sign in to Vigilo at localhost:3000, then return here.</p>', 401);
    if (context.workspace.id !== artifact.actor.workspaceId ||
        context.user.id !== artifact.actor.reviewerUserId || context.workspace.ownerUserId !== context.user.id)
      return html('<p>Forbidden.</p>', 403);
    let reviewed: ReturnType<typeof buildReviewedStagingPlan>;
    try { reviewed = validateLocalStagingArtifact(artifact, dependencies.configuration, dependencies.now?.()); }
    catch { return html('<p>Exact reviewed plan unavailable or expired. No action was taken.</p>', 409); }
    if (request.method === 'GET') {
      const snapshot = JSON.stringify({ actor: artifact.actor, plan: artifact.plan,
        approvedPlanIdentity: reviewed.planIdentity,
        accountGrant: reviewed.accountGrant, operationGrants: reviewed.operationGrants }, null, 2);
      const csrf = csrfToken(dependencies.csrfSecret, context.sessionId, artifact);
      return html(`<p>Review this complete non-secret plan before any separately authorized submission.</p><pre>${escape(snapshot)}</pre>` +
        `<form method="post" action="/"><input type="hidden" name="csrf" value="${csrf}">` +
        `<input type="hidden" name="planIdentity" value="${reviewed.planIdentity}">` +
        '<label><input type="checkbox" name="confirmation" value="stage_exact_reviewed_plan" required>' +
        ' I confirm staging of this exact reviewed plan.</label>' +
        '<button type="submit">Stage exact reviewed plan</button></form>');
    }
    const form = await parseConfirmation(request);
    const expected = csrfToken(dependencies.csrfSecret, context.sessionId, artifact);
    if (!form || form.confirmation !== 'stage_exact_reviewed_plan' || form.planIdentity !== reviewed.planIdentity ||
        !HASH.test(form.csrf) || !timingSafeEqual(Buffer.from(form.csrf, 'hex'), Buffer.from(expected, 'hex')))
      return html('<p>Confirmation invalid. No action was taken.</p>', 403);
    if (attempted) return html('<p>Submission already attempted. Inspect durable state before retrying.</p>', 409);
    attempted = true;
    try {
      const receipt = await dependencies.stage(context, artifact.plan, reviewed.planIdentity);
      if (receipt.repairRunId !== artifact.plan.repairRunId || receipt.planIdentity !== reviewed.planIdentity ||
          receipt.baselineJobId !== artifact.plan.repairRunId || receipt.operationGrantIds.length !== 5)
        return html('<p>Staging outcome uncertain. Inspect durable state.</p>', 503);
      return html('<p>The exact reviewed plan was staged. No worker was started.</p>');
    } catch { return html('<p>Staging outcome uncertain. Inspect durable state before any retry.</p>', 503); }
  };
}
