import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import nextConfig, { createSecurityHeaders } from '../next.config.js';

const require = createRequire(import.meta.url);
const { tryToParsePath } = require('next/dist/lib/try-to-parse-path.js') as typeof import('next/dist/lib/try-to-parse-path.js');

async function securityHeadersFor(pathname: string) {
  const configured = await nextConfig.headers?.() ?? [];
  return configured.flatMap((route) => {
    const parsed = tryToParsePath(route.source);
    assert.equal(parsed.error, undefined);
    assert.ok(parsed.regexStr);
    return new RegExp(parsed.regexStr).test(pathname) ? route.headers : [];
  });
}

function cspValues(headers: Array<{ key: string; value: string }>) {
  return headers.filter((header) => header.key.toLowerCase() === 'content-security-policy').map((header) => header.value);
}

function formActionSources(csp: string) {
  const directive = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('form-action '));
  assert.ok(directive);
  return directive.split(/\s+/).slice(1);
}

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
  assert.equal(cspValues(await securityHeadersFor('/')).length, 1);

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
  const csp = headersByName(createSecurityHeaders({ production: true, baseUrl: 'https://vigilo.example' })).get('content-security-policy') ?? '';
  assert.match(csp, /form-action 'self'/);
  assert.doesNotMatch(csp, /navigate-to/);
  for (const pathname of ['/sign-in', '/api/auth/callback/github', '/api/github/repositories/authorize']) {
    assert.deepEqual(formActionSources(cspValues(await securityHeadersFor(pathname))[0] ?? ''), ["'self'"]);
  }
});

test('GitHub repository page has one effective CSP allowing only self and the exact GitHub HTTPS origin for forms', async () => {
  for (const pathname of ['/app/github', '/app/github/']) {
    const headers = await securityHeadersFor(pathname);
    const policies = cspValues(headers);
    assert.equal(policies.length, 1, `${pathname} must not receive an intersecting CSP`);
    assert.deepEqual(formActionSources(policies[0] ?? ''), ["'self'", 'https://github.com']);
    assert.doesNotMatch(policies[0] ?? '', /form-action[^;]*\*/);
    assert.deepEqual(
      headers.filter((header) => header.key.toLowerCase() !== 'content-security-policy'),
      createSecurityHeaders({ production: false, baseUrl: 'http://localhost:3000' })
        .filter((header) => header.key.toLowerCase() !== 'content-security-policy'),
    );
  }

  const githubPolicy = cspValues(await securityHeadersFor('/app/github'))[0] ?? '';
  const otherPolicy = cspValues(await securityHeadersFor('/app'))[0] ?? '';
  assert.equal(githubPolicy.replace("form-action 'self' https://github.com", "form-action 'self'"), otherPolicy);
  const productionEnvironment = { production: true, baseUrl: 'https://vigilo.example' };
  const productionGithubPolicy = cspValues(createSecurityHeaders(productionEnvironment, { allowGitHubOAuthFormAction: true }))[0] ?? '';
  const productionDefaultPolicy = cspValues(createSecurityHeaders(productionEnvironment))[0] ?? '';
  assert.deepEqual(formActionSources(productionGithubPolicy), ["'self'", 'https://github.com']);
  assert.equal(productionGithubPolicy.replace("form-action 'self' https://github.com", "form-action 'self'"), productionDefaultPolicy);
  for (const pathname of ['/', '/app', '/app/github/other', '/sign-in', '/api/auth/callback/github']) {
    const policies = cspValues(await securityHeadersFor(pathname));
    assert.equal(policies.length, 1);
    assert.deepEqual(formActionSources(policies[0] ?? ''), ["'self'"]);
  }
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
  assert.match(readme, /0025_repository-selection-history\.sql` has been applied to the positively\s+identified persistent local Vigilo development database, whose ledger has 26\s+consistent entries/i);
  assert.match(readme, /local development database currently selects the\s+public `xmodneo\/vigilo-acceptance-fixture` repository and has one ready\s+fixture execution profile/i);
  assert.match(readme, /No fixture RepairRun, baseline, source checkpoint,\s+execution grant, reservation, or acceptance has been created; M7\.7 live\s+acceptance has not started/i);
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
