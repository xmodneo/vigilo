import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export type RateLimitAction = 'auth' | 'oauth_callback' | 'repository_connect' | 'repository_select' |
  'profile_detect' | 'repair_start' | 'workflow_start' | 'human_review' | 'publication' |
  'poll' | 'health' | 'readiness';

export function parseTrustedProxyHops(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-8]$/.test(value)) throw new Error('proxy_attribution_unavailable');
  return Number(value);
}

export function resolveRateLimitSubject(
  headers: Headers,
  options: { production: boolean; trustedProxyHops?: number; directAddress?: string },
): string {
  const forwarded = headers.get('x-forwarded-for');
  if (options.trustedProxyHops !== undefined) {
    if (!Number.isSafeInteger(options.trustedProxyHops) || options.trustedProxyHops < 1 || options.trustedProxyHops > 8 || !forwarded) {
      throw new Error('proxy_attribution_unavailable');
    }
    const chain = forwarded.split(',').map((value) => value.trim());
    const index = chain.length - options.trustedProxyHops;
    const address = chain[index];
    if (!address || !isIP(address)) throw new Error('proxy_attribution_unavailable');
    return `ip:${address}`;
  }
  if (options.production) throw new Error('proxy_attribution_unavailable');
  if (!options.directAddress || !isIP(options.directAddress)) throw new Error('proxy_attribution_unavailable');
  return `ip:${options.directAddress}`;
}

export function hashRateLimitSubject(secret: string, subject: string): string {
  if (Buffer.byteLength(secret) < 32) throw new Error('rate_limit_configuration_invalid');
  return createHmac('sha256', secret).update(subject).digest('hex');
}
