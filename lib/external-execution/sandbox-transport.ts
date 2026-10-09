import { ExternalExecutionAuthorityError } from './types.ts';

export type SandboxTransportBinding = { name: string; projectId: string; teamId: string; sessionId?: string | null };
export type SandboxTransportKind = 'create' | 'cleanup' | 'business';

// This capability is captured once per permit, never reconstructed from a URL
// supplied by the SDK. Recovery bindings are derived from durable attempt rows.
export class SandboxTransportPolicy {
  private sessionId: string | null;
  constructor(readonly binding: SandboxTransportBinding, readonly recovery: boolean, private readonly limits: { runtimeMs: number; vcpus: number }) {
    this.binding = Object.freeze({ ...binding });
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(binding.name) || !binding.projectId || !binding.teamId) this.deny();
    this.sessionId = this.binding.sessionId ?? null;
  }
  private deny(): never { throw new ExternalExecutionAuthorityError('execution_authority_mismatch'); }

  classify(input: string | URL | Request, init?: RequestInit): SandboxTransportKind {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin !== 'https://vercel.com' || url.username || url.password || url.hash
      || url.searchParams.getAll('teamId').length !== 1 || url.searchParams.get('teamId') !== this.binding.teamId) this.deny();
    const namePath = `/api/v2/sandboxes/${encodeURIComponent(this.binding.name)}`;
    if (url.pathname === '/api/v3/sandboxes' && method === 'POST') {
      if (this.recovery || [...url.searchParams.keys()].some((key) => key !== 'teamId')
        || typeof init?.body !== 'string' || Buffer.byteLength(init.body) > 64 * 1024) this.deny();
      let body: Record<string, unknown>;
      try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { return this.deny(); }
      if (body?.name !== this.binding.name || body.projectId !== this.binding.projectId
        || body.runtime !== undefined || body.image !== 'vercel/sandbox/node:24' || body.persistent !== false
        || body.timeout !== this.limits.runtimeMs || (body.resources as { vcpus?: unknown } | undefined)?.vcpus !== this.limits.vcpus
        || body.source !== undefined || body.env !== undefined || (body.ports !== undefined && (!Array.isArray(body.ports) || body.ports.length))) this.deny();
      return 'create';
    }
    if (url.pathname === namePath && ['GET', 'DELETE'].includes(method)) {
      if (url.searchParams.getAll('projectId').length !== 1 || url.searchParams.get('projectId') !== this.binding.projectId
        || (method === 'GET' && (url.searchParams.getAll('resume').length !== 1 || url.searchParams.get('resume') !== 'false'))
        || [...url.searchParams.keys()].some((key) => !['teamId', 'projectId', ...(method === 'GET' ? ['resume'] : ['deleteOrphanSnapshots'])].includes(key))) this.deny();
      return 'cleanup';
    }
    const sessionPath = this.sessionId ? `/api/v2/sandboxes/sessions/${encodeURIComponent(this.sessionId)}` : null;
    if (sessionPath && url.pathname === `${sessionPath}/stop` && method === 'POST' && [...url.searchParams.keys()].every((key) => key === 'teamId')) return 'cleanup';
    // Allow only the installed SDK operations used by V1, not an arbitrary
    // session prefix. Unknown/encoded mutations cannot alias a lifecycle route.
    if (!this.recovery && sessionPath && url.pathname.startsWith(`${sessionPath}/`)) {
      const suffix = url.pathname.slice(sessionPath.length + 1);
      const command = /^cmd\/[A-Za-z0-9_-]{1,128}$/;
      const commandLogs = /^cmd\/[A-Za-z0-9_-]{1,128}\/logs$/;
      const commandKill = /^cmd\/[A-Za-z0-9_-]{1,128}\/kill$/;
      const queryKeys = [...url.searchParams.keys()];
      const commandRead = method === 'GET' && command.test(suffix)
        && queryKeys.every((key) => key === 'teamId' || key === 'wait')
        && (!url.searchParams.has('wait') || url.searchParams.getAll('wait').length === 1 && url.searchParams.get('wait') === 'true');
      const ordinary = queryKeys.every((key) => key === 'teamId') && (
        method === 'POST' && (['cmd', 'fs/mkdir', 'fs/write', 'fs/read', 'network-policy'].includes(suffix) || commandKill.test(suffix))
        || method === 'GET' && commandLogs.test(suffix));
      if (commandRead || ordinary) return 'business';
    }
    return this.deny();
  }

  confirm(identity: { name: string; sessionId: string }): void {
    if (identity.name !== this.binding.name || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.sessionId)
      || (this.sessionId && this.sessionId !== identity.sessionId)) this.deny();
    this.sessionId = identity.sessionId;
  }

  async observeLookup(response: Response): Promise<void> {
    if (!response.ok) return;
    // Only resource metadata is inspected; never commands, files or credentials.
    const reader = response.clone().body?.getReader();
    if (!reader) this.deny();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength; if (bytes > 128 * 1024) this.deny(); chunks.push(item.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sandbox?: { name?: string; currentSessionId?: string }; session?: { id?: string } };
      if (value.sandbox?.name !== this.binding.name || value.sandbox.currentSessionId !== value.session?.id || !value.session?.id) this.deny();
      this.confirm({ name: value.sandbox.name, sessionId: value.session.id });
    } catch { this.deny(); } finally { void reader.cancel().catch(() => undefined); }
  }
}
