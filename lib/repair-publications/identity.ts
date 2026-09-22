import { createHash } from 'node:crypto';

import { canonicalRecord } from '../repair-loops/canonical.ts';
import type { ApprovedHumanReviewAuthority } from '../human-reviews/types.ts';

export const sha256Text = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function publicationBranch(decisionIdentity: string): string {
  if (!/^[0-9a-f]{64}$/.test(decisionIdentity)) throw new Error('publication_authority_mismatch');
  return `vigilo/repair/${sha256Text(`vigilo-publication-branch-v1\0${decisionIdentity}`)}`;
}

export function computePublicationIntentIdentity(input: {
  publicationId: string;
  authority: ApprovedHumanReviewAuthority;
  repairIntentId: string;
  repairObjectiveHash: string;
  requestedByUserId: string;
  targetBranch: string;
  pullRequestTitle: string;
  pullRequestBodyHash: string;
}): string {
  return canonicalRecord({ version: 1, ...input }, 16 * 1024).hash;
}

export function computePreparedPublicationIdentity(input: {
  publicationIntentIdentity: string;
  targetBaseBranch: string;
  expectedBaseTreeSha: string;
  expectedTreeSha: string;
  expectedCommitSha: string;
}): string {
  return canonicalRecord({ version: 1, ...input }, 4 * 1024).hash;
}

function boundedExcerpt(value: string, maximumBytes: number): string {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maximumBytes) break;
    result += character;
  }
  return result;
}

function safeDisplay(value: string): string {
  return value.replace(/[\u0080-\u009f]|\p{Cf}/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16).padStart(4, '0')}}`);
}

function plainTitle(value: string): string {
  const singleLine = safeDisplay(value).replace(/\s+/g, ' ').trim();
  return boundedExcerpt(singleLine, 160) || 'Approved repair';
}

function indented(value: string): string {
  return safeDisplay(value).split('\n').map((line) => `    ${line}`).join('\n');
}

export function buildPullRequestMetadata(input: {
  publicationId: string;
  objective: string;
  objectiveHash: string;
  candidateIdentity: string;
  decisionIdentity: string;
  verificationId: string;
  evidenceId: string;
  evidenceIdentity: string;
  changedFiles: Array<{ path: string; operation: 'add' | 'modify' | 'delete' }>;
}): { title: string; body: string; bodyHash: string } {
  if (!/^[0-9a-f-]{36}$/.test(input.publicationId) || !/^[0-9a-f]{64}$/.test(input.objectiveHash) || input.changedFiles.length < 1 || input.changedFiles.length > 16) throw new Error('publication_authority_mismatch');
  const objective = boundedExcerpt(input.objective, 1_024);
  const fileLines = [...input.changedFiles].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `    ${file.operation} ${file.path}`).join('\n');
  const marker = `<!-- vigilo-publication:v1:${input.publicationId} -->`;
  const title = `Draft: Vigilo repair — ${plainTitle(input.objective)}`;
  const body = [
    marker,
    '# DRAFT — human review required',
    '',
    'This pull request publishes one immutable, human-approved Vigilo candidate. It is not an authorization to merge or deploy.',
    '',
    '## Repair objective (untrusted text, displayed literally)',
    '',
    indented(objective),
    '',
    `Objective SHA-256: ${input.objectiveHash}`,
    '',
    '## Exact changed files',
    '',
    fileLines,
    '',
    '## Verified authority',
    '',
    `Candidate identity: ${input.candidateIdentity}`,
    `Human decision identity: ${input.decisionIdentity}`,
    `Verification: ${input.verificationId}`,
    `Evidence: ${input.evidenceId}`,
    `Evidence identity: ${input.evidenceIdentity}`,
    '',
    'Verification established the configured deterministic baseline-recovery contract for this exact candidate. This description includes no claim of deployment, production validation, or any live acceptance beyond the independently enforced publication gate.',
    '',
  ].join('\n');
  if (title.length > 256 || Buffer.byteLength(body, 'utf8') > 16_384) throw new Error('publication_metadata_invalid');
  return { title, body, bodyHash: sha256Text(body) };
}
