export function GET(): Response {
  return Response.json({
    service: 'vigilo-web',
    status: 'ok',
    milestone: '2.1',
  });
}
