import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { getAuth } from './lib/auth/server.ts';
import { rateLimitedResponse, rateLimitRequest } from './lib/operations/http-rate-limit.ts';

export async function proxy(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    let authenticatedSubject: string | undefined;
    if (!request.nextUrl.pathname.startsWith('/api/auth/')) {
      try {
        const session = await getAuth().api.getSession({ headers: request.headers });
        if (session?.user.id) authenticatedSubject = `user:${session.user.id}`;
      } catch { /* Anonymous and invalid sessions remain protected by IP. */ }
    }
    const decision = await rateLimitRequest(request, { ...(authenticatedSubject ? { authenticatedSubject } : {}) });
    if (!decision.allowed) return rateLimitedResponse(decision.retryAfterSeconds);
  } catch {
    return Response.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const headers = new Headers(request.headers);
  headers.set('x-vigilo-request-id', requestId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-vigilo-request-id', requestId);
  return response;
}

export const config = {
  matcher: ['/api/((?!health$).*)'],
};
