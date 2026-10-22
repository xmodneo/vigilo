import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { ReviewedRetirementReceipt } from './reviewed-retirement.ts';
import type { HistoricalRetirementTarget } from './local-retirement.ts';

const MAX_FORM_BYTES = 1_024;
const SHA = /^[0-9a-f]{40}$/;
const CSRF = /^[0-9a-f]{64}$/;
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

export interface LocalRetirementPreview {
  runState: string;
  checkpointState: string;
  jobState: string;
  eligible: boolean;
}

export interface LocalRetirementConfiguration {
  enabled: boolean;
  nodeEnv: string | undefined;
  baseUrl: string;
  databaseUrl: string;
  releaseSha: string | undefined;
  operatorOrigin: string;
}

interface Dependencies {
  configuration: LocalRetirementConfiguration;
  target: HistoricalRetirementTarget;
  csrfSecret: Buffer;
  resolveContext(headers: Headers): Promise<AuthenticatedWorkspace | null>;
  preview(context: AuthenticatedWorkspace): Promise<LocalRetirementPreview>;
  retire(context: AuthenticatedWorkspace): Promise<ReviewedRetirementReceipt>;
}

function localOnly(configuration: LocalRetirementConfiguration, target: HistoricalRetirementTarget, request: Request, peerAddress: string | undefined): boolean {
  let database: URL;
  try { database = new URL(configuration.databaseUrl); } catch { return false; }
  if (!configuration.enabled || configuration.nodeEnv !== 'development' ||
      configuration.baseUrl !== 'http://localhost:3000' ||
      configuration.operatorOrigin !== 'http://localhost:3001' ||
      !configuration.releaseSha || !SHA.test(configuration.releaseSha) ||
      configuration.releaseSha === target.authorizedReleaseSha ||
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.hostname !== '127.0.0.1' || database.port !== '55432' || database.pathname !== '/vigilo' ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peerAddress ?? '')) return false;
  if (request.headers.get('host') !== 'localhost:3001' ||
      request.headers.has('x-forwarded-host') || request.headers.has('x-forwarded-for')) return false;
  try { return new URL(request.url).origin === configuration.operatorOrigin; } catch { return false; }
}

function html(value: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vigilo local retirement</title></head><body><main><h1>Vigilo local retirement</h1>${value}</main></body></html>`,
    { status, headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

function forbidden(code: 'post_origin_rejected' | 'post_site_rejected' | 'owner_mismatch'): Response {
  return html(`<p>Forbidden.</p><p>Local rejection code: ${code}</p>`, 403);
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function csrfToken(secret: Buffer, sessionId: string, target: HistoricalRetirementTarget): string {
  return createHmac('sha256', secret).update(`vigilo-local-retirement\0${sessionId}\0${target.repairRunId}\0${target.planIdentity}`).digest('hex');
}

async function parseConfirmation(request: Request): Promise<{ confirmation: string; csrf: string } | null> {
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
  if ([...form.keys()].sort().join(',') !== 'confirmation,csrf' ||
      form.getAll('confirmation').length !== 1 || form.getAll('csrf').length !== 1) return null;
  return { confirmation: form.get('confirmation') ?? '', csrf: form.get('csrf') ?? '' };
}

export function createLocalRetirementHandler(dependencies: Dependencies) {
  if (dependencies.csrfSecret.length < 32) throw new Error('local_retirement_csrf_secret_invalid');
  return async (request: Request, peerAddress: string | undefined): Promise<Response> => {
    if (!localOnly(dependencies.configuration, dependencies.target, request, peerAddress))
      return html('<p>Unavailable.</p>', 404);
    if (request.method !== 'GET' && request.method !== 'POST') return html('<p>Method unavailable.</p>', 405);
    if (request.method === 'POST') {
      const site = request.headers.get('sec-fetch-site');
      if (request.headers.get('origin') !== dependencies.configuration.operatorOrigin)
        return forbidden('post_origin_rejected');
      if (site !== null && site !== 'same-origin') return forbidden('post_site_rejected');
    }
    let context: AuthenticatedWorkspace | null;
    try { context = await dependencies.resolveContext(request.headers); }
    catch { return html('<p>Authentication unavailable.</p>', 503); }
    if (!context) return html('<p>Sign in to Vigilo first at <a href="http://localhost:3000/sign-in">localhost:3000/sign-in</a>, then return here.</p>', 401);
    if (context.workspace.id !== dependencies.target.workspaceId || context.workspace.ownerUserId !== context.user.id)
      return forbidden('owner_mismatch');

    if (request.method === 'GET') {
      let preview: LocalRetirementPreview;
      try { preview = await dependencies.preview(context); }
      catch { return html('<p>Exact historical target unavailable. No action was taken.</p>', 409); }
      const facts = `<p>Historical RepairRun: ${escape(dependencies.target.repairRunId)}</p>` +
        `<p>Stored plan identity: ${escape(dependencies.target.planIdentity)}</p>` +
        `<p>Frozen repository: ${dependencies.target.repositoryId}; revision: ${escape(dependencies.target.revision)}</p>` +
        `<p>Historical release: ${escape(dependencies.target.authorizedReleaseSha)}</p>` +
        `<p>Run: ${escape(preview.runState)}; checkpoint: ${escape(preview.checkpointState)}; old job: ${escape(preview.jobState)}</p>`;
      if (!preview.eligible) return html(`${facts}<p>Retirement is unavailable or already complete. No action was taken.</p>`);
      const token = csrfToken(dependencies.csrfSecret, context.sessionId, dependencies.target);
      return html(`${facts}<p><strong>Retirement is irreversible.</strong> Only the exact never-executed historical run will be cancelled. No baseline will run.</p>` +
        `<form method="post" action="/"><input type="hidden" name="csrf" value="${token}">` +
        '<label><input type="checkbox" name="confirmation" value="retire_exact_staged_run" required>' +
        ' I confirm retirement of this exact historical run.</label>' +
        '<button type="submit">Retire historical staged run</button></form>');
    }

    const form = await parseConfirmation(request);
    const expected = csrfToken(dependencies.csrfSecret, context.sessionId, dependencies.target);
    if (!form || form.confirmation !== 'retire_exact_staged_run' || !CSRF.test(form.csrf) ||
        !timingSafeEqual(Buffer.from(form.csrf, 'hex'), Buffer.from(expected, 'hex')))
      return html('<p>Confirmation invalid. No action was taken.</p>', 403);
    try {
      const receipt = await dependencies.retire(context);
      if (receipt.repairRunId !== dependencies.target.repairRunId || receipt.planIdentity !== dependencies.target.planIdentity ||
          receipt.baselineJobId !== dependencies.target.repairRunId || receipt.revokedGrantCount !== 6)
        return html('<p>Retirement outcome uncertain. Inspect durable state before any retry.</p>', 503);
      return html(receipt.result === 'already_retired'
        ? '<p>This exact historical run was already retired. No additional change was made.</p>'
        : '<p>The exact historical run was retired. Six grants were revoked.</p>');
    } catch {
      return html('<p>Retirement outcome uncertain. Inspect durable state before any retry.</p>', 503);
    }
  };
}
