import { createHash } from 'node:crypto';

import { candidatePath, candidatePathKey, CANDIDATE_LIMITS } from './policy.ts';
import type { FrozenCandidateFile } from './types.ts';

const HASH = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

export class CandidateArtifactError extends Error {
  constructor(public readonly code: 'candidate_artifact_invalid') {
    super(code);
    this.name = 'CandidateArtifactError';
  }
}

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function computeCandidateIdentity(input: {
  formatVersion: 1;
  githubRepositoryId: number;
  baseCommitSha: string;
  profileIdentity: string;
  files: FrozenCandidateFile[];
}): string {
  if (!Number.isSafeInteger(input.githubRepositoryId) || input.githubRepositoryId < 1 || !GIT_SHA.test(input.baseCommitSha) || !HASH.test(input.profileIdentity) || input.files.length < 1 || input.files.length > CANDIDATE_LIMITS.maxChangedFiles) throw new CandidateArtifactError('candidate_artifact_invalid');
  const seen = new Set<string>();
  const pathKeys: string[] = [];
  let totalResultBytes = 0;
  const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path)).map((file) => {
    let path: string;
    try { path = candidatePath(file.path); } catch { throw new CandidateArtifactError('candidate_artifact_invalid'); }
    const pathKey = candidatePathKey(path);
    if (seen.has(pathKey) || pathKeys.some((other) => pathKey.startsWith(`${other}/`) || other.startsWith(`${pathKey}/`)) || !['add', 'modify', 'delete'].includes(file.operation)) throw new CandidateArtifactError('candidate_artifact_invalid');
    seen.add(pathKey);
    pathKeys.push(pathKey);
    const hasBase = file.operation !== 'add';
    const hasResult = file.operation !== 'delete';
    if ((hasBase && (!file.baseBlobSha || !GIT_SHA.test(file.baseBlobSha) || !file.baseContentSha256 || !HASH.test(file.baseContentSha256))) || (!hasBase && (file.baseBlobSha !== null || file.baseContentSha256 !== null))) throw new CandidateArtifactError('candidate_artifact_invalid');
    if (hasResult) {
      if (file.resultingContent === null || !file.resultContentSha256 || !HASH.test(file.resultContentSha256)) throw new CandidateArtifactError('candidate_artifact_invalid');
      const bytes = Buffer.from(file.resultingContent, 'utf8');
      if (bytes.byteLength < 1 || bytes.byteLength > CANDIDATE_LIMITS.maxFileBytes || bytes.byteLength !== file.resultByteLength || sha256(bytes) !== file.resultContentSha256 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(file.resultingContent)) throw new CandidateArtifactError('candidate_artifact_invalid');
      totalResultBytes += bytes.byteLength;
      if (totalResultBytes > CANDIDATE_LIMITS.maxTotalResultBytes) throw new CandidateArtifactError('candidate_artifact_invalid');
    } else if (file.resultingContent !== null || file.resultContentSha256 !== null || file.resultByteLength !== 0) throw new CandidateArtifactError('candidate_artifact_invalid');
    return {
      path,
      operation: file.operation,
      base: hasBase ? { presence: 'present', blobSha: file.baseBlobSha, contentSha256: file.baseContentSha256 } : { presence: 'absent' },
      result: hasResult ? { presence: 'present', contentSha256: file.resultContentSha256, byteLength: file.resultByteLength } : { presence: 'absent', byteLength: 0 },
    };
  });
  return sha256(JSON.stringify({ formatVersion: input.formatVersion, githubRepositoryId: input.githubRepositoryId, baseCommitSha: input.baseCommitSha, profileIdentity: input.profileIdentity, files }));
}
