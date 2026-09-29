import postgres from 'postgres';

import { readDatabaseEnvironment } from '../auth/environment.ts';
import { hashRateLimitSubject, parseTrustedProxyHops, resolveRateLimitSubject, type RateLimitAction } from './rate-limit.ts';

export interface RateLimitPolicy { action: RateLimitAction; limit: number; windowSeconds: number }

const policies: Record<RateLimitAction, Omit<RateLimitPolicy, 'action'>> = {
  auth: { limit: 10, windowSeconds: 15 * 60 },
  oauth_callback: { limit: 30, windowSeconds: 15 * 60 },
  repository_connect: { limit: 20, windowSeconds: 60 },
  repository_select: { limit: 20, windowSeconds: 60 },
  profile_detect: { limit: 10, windowSeconds: 60 },
  repair_start: { limit: 10, windowSeconds: 60 },
  workflow_start: { limit: 20, windowSeconds: 60 },
  human_review: { limit: 20, windowSeconds: 60 },
  publication: { limit: 10, windowSeconds: 60 },
  poll: { limit: 120, windowSeconds: 60 },
  health: { limit: 120, windowSeconds: 60 },
  readiness: { limit: 60, windowSeconds: 60 },
};

let rateLimitClient: ReturnType<typeof postgres> | undefined;

function client(): ReturnType<typeof postgres> {
  if (!rateLimitClient) rateLimitClient = postgres(readDatabaseEnvironment().databaseUrl, { max: 3, prepare: false, connect_timeout: 3 });
  return rateLimitClient;
}

export function classifyRateLimitAction(pathname: string, method: string): RateLimitAction {
  if (pathname === '/api/health/readiness') return 'readiness';
  if (pathname === '/api/health') return 'health';
  if (pathname.endsWith('/callback') || pathname.includes('/callback/')) return 'oauth_callback';
  if (pathname.startsWith('/api/auth/')) return 'auth';
  if (pathname.includes('/publications')) return method === 'GET' ? 'poll' : 'publication';
  if (pathname.includes('/human-review')) return method === 'GET' ? 'poll' : 'human_review';
  if (method === 'GET') return 'poll';
  if (pathname.includes('/repositories/selected')) return 'repository_select';
  if (pathname.includes('/repositories/profile')) return 'profile_detect';
  if (pathname.includes('/repositories') || pathname.includes('/installations')) return 'repository_connect';
  if (pathname === '/api/repair-runs') return 'repair_start';
  return 'workflow_start';
}

export async function consumeRateLimit(input: {
  action: RateLimitAction;
  subjectHash: string;
  database?: ReturnType<typeof postgres>;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const policy = policies[input.action];
  const database = input.database ?? client();
  if (input.subjectHash.endsWith('00')) {
    await database`
      delete from http_rate_limit_bucket where ctid in (
        select ctid from http_rate_limit_bucket where expires_at < statement_timestamp() order by expires_at limit 100
      )
    `;
  }
  const rows = await database<{ requestCount: number; retryAfterSeconds: number }[]>`
    insert into http_rate_limit_bucket (action, subject_hash, window_started_at, expires_at, request_count, updated_at)
    values (
      ${input.action}, ${input.subjectHash},
      to_timestamp(floor(extract(epoch from statement_timestamp()) / ${policy.windowSeconds}) * ${policy.windowSeconds}),
      to_timestamp(floor(extract(epoch from statement_timestamp()) / ${policy.windowSeconds}) * ${policy.windowSeconds}) + (${policy.windowSeconds} * interval '1 second'),
      1, statement_timestamp()
    )
    on conflict (action, subject_hash, window_started_at) do update
      set request_count = http_rate_limit_bucket.request_count + 1, updated_at = statement_timestamp()
      where http_rate_limit_bucket.request_count < ${policy.limit}
    returning request_count as "requestCount",
      greatest(1, ceil(extract(epoch from (expires_at - statement_timestamp()))))::int as "retryAfterSeconds"
  `;
  if (rows[0]) return { allowed: true, retryAfterSeconds: rows[0].retryAfterSeconds };
  const [blocked] = await database<{ retryAfterSeconds: number }[]>`
    select greatest(1, ceil(extract(epoch from (expires_at - statement_timestamp()))))::int as "retryAfterSeconds"
    from http_rate_limit_bucket where action = ${input.action} and subject_hash = ${input.subjectHash}
    order by window_started_at desc limit 1
  `;
  return { allowed: false, retryAfterSeconds: blocked?.retryAfterSeconds ?? policy.windowSeconds };
}

export async function rateLimitRequest(request: Request, options: { directAddress?: string; authenticatedSubject?: string } = {}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const production = process.env.NODE_ENV === 'production';
  const trustedProxyHops = parseTrustedProxyHops(process.env.VIGILO_TRUST_PROXY_HOPS);
  const subject = options.authenticatedSubject && /^user:[0-9a-z-]{1,128}$/i.test(options.authenticatedSubject)
    ? options.authenticatedSubject
    : resolveRateLimitSubject(request.headers, {
      production,
      ...(trustedProxyHops === undefined ? {} : { trustedProxyHops }),
      ...(!production ? { directAddress: options.directAddress ?? '127.0.0.1' } : {}),
    });
  const key = process.env.VIGILO_RATE_LIMIT_HMAC_KEY;
  if (!key) throw new Error('rate_limit_configuration_invalid');
  return consumeRateLimit({
    action: classifyRateLimitAction(new URL(request.url).pathname, request.method),
    subjectHash: hashRateLimitSubject(key, subject),
  });
}

export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json({ error: 'rate_limited' }, {
    status: 429,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': String(retryAfterSeconds) },
  });
}
