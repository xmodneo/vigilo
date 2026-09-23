import type { NextConfig } from 'next';

interface SecurityHeaderEnvironment {
  production: boolean;
  baseUrl: string | undefined;
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

export function createSecurityHeaders(environment: SecurityHeaderEnvironment): Array<{ key: string; value: string }> {
  const secureProduction = environment.production && isHttpsUrl(environment.baseUrl);
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-inline'${environment.production ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${environment.production ? '' : ' ws: wss:'}`,
    "media-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(secureProduction ? ['upgrade-insecure-requests'] : []),
  ];
  const headers = [
    { key: 'Content-Security-Policy', value: directives.join('; ') },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()' },
  ];
  if (secureProduction) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000' });
  return headers;
}

const nextConfig: NextConfig = {
  agentRules: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: createSecurityHeaders({ production: process.env.NODE_ENV === 'production', baseUrl: process.env.BETTER_AUTH_URL }),
    }];
  },
  logging: {
    incomingRequests: {
      ignore: [
        /^\/api\/auth\/callback(?:\/|$)/,
        /^\/api\/github\/installations\/(?:setup|callback)(?:\?|$)/,
      ],
    },
  },
};

export default nextConfig;
