import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import nextConfig, { createSecurityHeaders } from '../next.config.js';

test('development logs omit identity and GitHub App callback URLs', () => {
  const logging = nextConfig.logging;

  assert.equal(typeof logging, 'object');
  assert.notEqual(logging, null);

  if (typeof logging !== 'object' || logging === null) {
    return;
  }

  const incomingRequests = logging.incomingRequests;

  assert.equal(typeof incomingRequests, 'object');
  assert.notEqual(incomingRequests, null);

  if (typeof incomingRequests !== 'object' || incomingRequests === null) {
    return;
  }

  const ignoredRequests = incomingRequests.ignore ?? [];

  assert.equal(
    ignoredRequests.some((pattern) =>
      pattern.test('/api/auth/callback/github?code=temporary&state=temporary'),
    ),
    true,
  );
  for (const callbackPath of [
    '/api/github/installations/setup?installation_id=7001&state=temporary',
    '/api/github/installations/callback?code=temporary&state=temporary',
  ]) {
    assert.equal(
      ignoredRequests.some((pattern) => pattern.test(callbackPath)),
      true,
    );
  }
  assert.equal(ignoredRequests.some((pattern) => pattern.test('/api/health')), false);
});

function headersByName(headers: ReturnType<typeof createSecurityHeaders>) {
  return new Map(headers.map((header) => [header.key.toLowerCase(), header.value]));
}

test('global response headers provide a restrictive Next-compatible security baseline', async () => {
  const configured = await nextConfig.headers?.();
  assert.ok(configured);
  assert.equal(configured.length, 1);
  assert.equal(configured[0]?.source, '/:path*');

  const headers = headersByName(createSecurityHeaders({ production: false, baseUrl: 'http://localhost:3000' }));
  const csp = headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
  assert.match(csp, /connect-src 'self' ws: wss:/);
  assert.doesNotMatch(csp, /default-src \*/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');
  assert.equal(headers.has('strict-transport-security'), false);
});

test('production HTTPS enables HSTS without development-only CSP allowances', () => {
  const secure = headersByName(createSecurityHeaders({ production: true, baseUrl: 'https://vigilo.example' }));
  assert.equal(secure.get('strict-transport-security'), 'max-age=31536000');
  assert.match(secure.get('content-security-policy') ?? '', /upgrade-insecure-requests/);
  assert.doesNotMatch(secure.get('content-security-policy') ?? '', /'unsafe-eval'/);

  const localProduction = headersByName(createSecurityHeaders({ production: true, baseUrl: 'http://localhost:3000' }));
  assert.equal(localProduction.has('strict-transport-security'), false);
  assert.doesNotMatch(localProduction.get('content-security-policy') ?? '', /upgrade-insecure-requests/);
});

test('security headers apply to OAuth callbacks, application pages, and API routes without blocking same-origin forms', async () => {
  const configured = await nextConfig.headers?.();
  assert.equal(configured?.[0]?.source, '/:path*');
  const csp = headersByName(createSecurityHeaders({ production: true, baseUrl: 'https://vigilo.example' })).get('content-security-policy') ?? '';
  assert.match(csp, /form-action 'self'/);
  assert.doesNotMatch(csp, /navigate-to/);
});

test('release documentation keeps local migration facts separate from production readiness', async () => {
  const readme = await readFile('README.md', 'utf8');
  assert.match(readme, /0021_repair-publication\.sql[\s\S]*positively identified[\s\S]*local development database/i);
  assert.match(readme, /Arbitrary\s+deployments must independently verify and apply their own migration ledger/i);
  assert.match(readme, /Managed SaaS production readiness has not been established/i);
  assert.match(readme, /Task 4\.3 live acceptance remains pending/i);
  assert.match(readme, /production publication[\s\S]*cannot reach a GitHub write/i);
});

test('README presents the truthful controlled-beta contract', async () => {
  const readme = await readFile('README.md', 'utf8');
  assert.match(readme, /eligible public, single-package Node\.js 24\/npm repositories/i);
  assert.match(readme, /does not automatically merge or deploy/i);
  assert.match(readme, /0023_operational-readiness\.sql` has been applied to the positively\s+identified local development database/i);
  assert.match(readme, /Task 4\.3 live acceptance remains pending/i);
  assert.match(readme, /publication remains hard-closed with `live_acceptance_pending`/i);
  assert.match(readme, /Application budgets[\s\S]*do not guarantee a provider bill or dollar amount/i);
  assert.match(readme, /Managed SaaS production readiness has not been\s+established/i);
});

test('release accessibility styles preserve keyboard focus and narrow-screen content', async () => {
  const css = await readFile('app/globals.css', 'utf8');
  assert.match(css, /a:focus-visible,[\s\S]*button:focus-visible,[\s\S]*textarea:focus-visible,[\s\S]*summary:focus-visible[\s\S]*outline:/);
  assert.match(css, /\.repository-panel pre[\s\S]*overflow: auto/);
  assert.match(css, /\.repository-panel code,[\s\S]*\.workspace-card code[\s\S]*overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 32rem\)[\s\S]*\.repository-list li,[\s\S]*\.workspace-header[\s\S]*flex-direction: column/);
});
