import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import {
  candidateVerification,
  executionProfile,
  investigation,
  repairCandidate,
  repairRun,
  repositoryBaseline,
} from '../../db/schema.ts';
import type { SandboxLifecycleObserver } from '../../src/sandbox-boundary.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { selfCheckRepairCandidateForWorkspace } from '../repair-candidates/flow.ts';
import { frozenBaselineProfile } from '../repository-baselines/authority.ts';
import { acquireExactRepositoryArchive } from '../repository-baselines/flow.ts';
import { runFrozenCandidateVerification } from './runner.ts';
import { trustworthyComparableBaseline } from './classification.ts';
import type { CandidateVerificationEvidence, CandidateVerificationGateway } from './types.ts';

export class CandidateVerificationPreparationError extends Error {
  constructor(public readonly code: 'candidate_artifact_invalid' | 'verification_authority_mismatch' | 'verification_source_unavailable') {
    super(code);
    this.name = 'CandidateVerificationPreparationError';
  }
}

function matchingAuthority(values: Array<{ workspaceId: string; githubRepositoryId: number; installationId: number; baseCommitSha: string; profileIdentity: string }>): boolean {
  const [expected, ...rest] = values;
  return Boolean(expected) && rest.every((value) => value.workspaceId === expected!.workspaceId && value.githubRepositoryId === expected!.githubRepositoryId &&
    value.installationId === expected!.installationId && value.baseCommitSha === expected!.baseCommitSha && value.profileIdentity === expected!.profileIdentity);
}

export async function executeCandidateVerification(
  database: VigiloDatabase,
  gateway: CandidateVerificationGateway,
  configuration: GitHubAppConfiguration,
  input: { verificationId: string; attemptId: string; evidenceId: string },
  options: { cancellation?: AbortSignal; clock?: () => Date; runner?: typeof runFrozenCandidateVerification; sandboxObserver?: SandboxLifecycleObserver } = {},
): Promise<CandidateVerificationEvidence> {
  const [verification] = await database.select().from(candidateVerification).where(eq(candidateVerification.id, input.verificationId)).limit(1);
  if (!verification) throw new CandidateVerificationPreparationError('verification_authority_mismatch');
  const [[candidate], [current], [run], [baseline], [profile]] = await Promise.all([
    database.select().from(repairCandidate).where(eq(repairCandidate.id, verification.candidateId)).limit(1),
    database.select().from(investigation).where(eq(investigation.id, verification.investigationId)).limit(1),
    database.select().from(repairRun).where(eq(repairRun.id, verification.repairRunId)).limit(1),
    database.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, verification.baselineId)).limit(1),
    database.select().from(executionProfile).where(and(eq(executionProfile.githubRepositoryId, verification.githubRepositoryId), eq(executionProfile.profileIdentity, verification.profileIdentity))).limit(1),
  ]);
  if (!candidate || !current || !run || !baseline || !profile || !profile.profileIdentity || candidate.state !== 'frozen' ||
      candidate.id !== verification.candidateId || candidate.investigationId !== verification.investigationId ||
      candidate.repairRunId !== verification.repairRunId || current.id !== verification.investigationId ||
      current.repairRunId !== verification.repairRunId || current.baselineId !== verification.baselineId ||
      run.id !== verification.repairRunId || run.baselineId !== verification.baselineId || baseline.id !== verification.baselineId ||
      candidate.candidateIdentity !== verification.candidateIdentity ||
      !trustworthyComparableBaseline(baseline) ||
      !matchingAuthority([verification, candidate, current, run, baseline, { ...profile, profileIdentity: profile.profileIdentity }])) {
    throw new CandidateVerificationPreparationError('verification_authority_mismatch');
  }
  let artifact;
  try { artifact = await selfCheckRepairCandidateForWorkspace(database, verification.workspaceId, candidate.id); }
  catch { throw new CandidateVerificationPreparationError('candidate_artifact_invalid'); }
  if (artifact.candidateIdentity !== verification.candidateIdentity) throw new CandidateVerificationPreparationError('candidate_artifact_invalid');
  let frozenProfile;
  try { frozenProfile = frozenBaselineProfile(profile); }
  catch { throw new CandidateVerificationPreparationError('verification_authority_mismatch'); }

  let archive: Buffer;
  try {
    archive = await acquireExactRepositoryArchive(gateway, configuration, verification);
  } catch {
    throw new CandidateVerificationPreparationError('verification_source_unavailable');
  }
  const clock = options.clock ?? (() => new Date());
  return (options.runner ?? runFrozenCandidateVerification)({
    verificationId: verification.id, attemptId: input.attemptId, evidenceId: input.evidenceId,
    candidateId: candidate.id, candidateIdentity: artifact.candidateIdentity, workspaceId: verification.workspaceId,
    githubRepositoryId: verification.githubRepositoryId, installationId: verification.installationId,
    baseCommitSha: verification.baseCommitSha, profileIdentity: frozenProfile.profileIdentity,
    baselineId: verification.baselineId, baselineSandbox: { name: baseline.sandboxName, sessionId: baseline.sandboxSessionId },
    baselineOutcome: baseline.overallOutcome, profile: frozenProfile, files: artifact.files, archive,
    archiveSha256: createHash('sha256').update(archive).digest('hex'), startedAt: clock(),
  }, options.cancellation, clock, options.sandboxObserver);
}
