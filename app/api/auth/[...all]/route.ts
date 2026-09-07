import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '../../../../lib/auth/server';

function handlers() {
  return toNextJsHandler(getAuth());
}

export function GET(request: Request): Promise<Response> {
  return handlers().GET(request);
}

export function POST(request: Request): Promise<Response> {
  return handlers().POST(request);
}
