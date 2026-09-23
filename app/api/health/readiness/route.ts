export function GET(): Response {
  return Response.json({
    service: 'vigilo-web',
    status: 'not_ready',
    reason: 'readiness_checks_not_implemented',
    checks: {
      database: 'not_checked',
      migrations: 'not_checked',
      worker: 'not_checked',
      externalProviders: 'not_checked',
    },
  }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
