export function GET(): Response {
  return Response.json({
    service: 'vigilo-web',
    status: 'alive',
    scope: 'process',
    readiness: '/api/health/readiness',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
