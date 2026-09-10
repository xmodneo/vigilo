import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import type { TransactionalCandidateVerificationQueue } from '../repair-runs/queue.ts';
import { CandidateVerificationError, getCandidateVerification, startCandidateVerification } from './flow.ts';
import type { CandidateVerificationResult } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noStore = { 'Cache-Control': 'private, no-store' };

interface Dependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  queue: TransactionalCandidateVerificationQueue;
  resolveContext(headers: Headers): Promise<AuthenticatedWorkspace>;
}

export function publicCandidateVerification(value: CandidateVerificationResult | null) {
  if (!value) return null;
  return {
    id: value.id, candidateId: value.candidateId, state: value.state,
    revision: value.baseCommitSha, candidateIdentity: value.candidateIdentity,
    artifactIntegrity: value.candidateArtifactIntegrity,
    regressionChecks: value.verificationContract,
    baselineComparison: value.baselineComparison,
    repairObjectiveEvidence: value.repairObjectiveEvidence,
    executionOutcome: value.executionOutcome,
    failingPhase: value.failingPhase,
    networkIsolation: value.networkIsolation,
    cleanup: value.cleanup,
    evidenceId: value.evidenceId, failureCode: value.failureCode,
    createdAt: value.createdAt.toISOString(), completedAt: value.completedAt?.toISOString() ?? null,
  };
}

function redirect(baseUrl: string, path: string) {
  return new Response(null, { status: 303, headers: { ...noStore, Location: new URL(path, baseUrl).toString() } });
}

export function createCandidateVerificationHandlers(dependencies: Dependencies) {
  return {
    async start(request: Request) {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const context = await dependencies.resolveContext(request.headers);
        const contentType = request.headers.get('content-type') ?? '';
        const length = Number(request.headers.get('content-length') ?? '0');
        if (!contentType.startsWith('application/x-www-form-urlencoded') || !Number.isSafeInteger(length) || length > 1024) throw new CandidateVerificationError('candidate_not_found');
        const form = await request.formData();
        if ([...form.keys()].some((key) => key !== 'candidateId' && key !== 'intent') || form.getAll('candidateId').length !== 1 || form.getAll('intent').length > 1) throw new CandidateVerificationError('candidate_not_found');
        const candidateId = form.get('candidateId');
        const intent = form.get('intent');
        if (typeof candidateId !== 'string' || !UUID.test(candidateId)) throw new CandidateVerificationError('candidate_not_found');
        if (intent !== null && intent !== 'reverify') throw new CandidateVerificationError('candidate_not_found');
        const value = await startCandidateVerification(dependencies.database, context, candidateId, dependencies.queue, { reverify: intent === 'reverify' });
        return redirect(dependencies.configuration.baseUrl, `/app/github?verification=${encodeURIComponent(value.id)}`);
      } catch (error) {
        if (error instanceof AccessDeniedError) return redirect(dependencies.configuration.baseUrl, '/sign-in');
        const code = error instanceof CandidateVerificationError ? error.code : 'candidate_verification_unavailable';
        return redirect(dependencies.configuration.baseUrl, `/app/github?error=${encodeURIComponent(code)}`);
      }
    },
    async read(request: Request, verificationId: string) {
      try {
        if (!UUID.test(verificationId)) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
        const value = await getCandidateVerification(dependencies.database, await dependencies.resolveContext(request.headers), verificationId);
        if (!value) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
        return Response.json({ candidateVerification: publicCandidateVerification(value) }, { headers: noStore });
      } catch (error) {
        return Response.json({ error: error instanceof AccessDeniedError ? 'unauthorized' : 'candidate_verification_unavailable' }, { status: error instanceof AccessDeniedError ? 401 : 502, headers: noStore });
      }
    },
  };
}
