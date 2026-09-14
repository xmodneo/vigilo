import { randomUUID } from 'node:crypto';

import { and, eq, gt } from 'drizzle-orm';

import { aiCandidateGeneration, aiCandidateGenerationAttempt, aiInvestigation, executionProfile, investigation, investigationContextEvent, repairIntent, repositoryBaseline } from '../../db/schema.ts';
import type { InvestigationModelProvider, ModelProviderFailureCode, ToolName } from '../ai-investigations/types.ts';
import { ModelProviderError } from '../ai-investigations/types.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { InvestigationContextError, listPaths, readBaselineSummary, readTextFile, searchText } from '../investigations/context.ts';
import type { InvestigationSourceGateway } from '../investigations/types.ts';
import { AI_CANDIDATE_GENERATION_LIMITS, AI_CANDIDATE_GENERATION_PROTOCOL_VERSION, type AiCandidateGenerationModelResult } from './types.ts';
import { AI_CANDIDATE_PROPOSAL_FINALIZATION_INPUT, AI_CANDIDATE_PROPOSAL_INSTRUCTIONS, AI_CANDIDATE_PROPOSAL_PROVIDER_SCHEMA, AI_CANDIDATE_PROPOSAL_TOOLS, AiCandidateProposalValidationError, aiCandidateProposalToolOutput, buildAiCandidateProposalInput, parseAiCandidateProposal } from './protocol.ts';

export type AiCandidateGenerationErrorCode = 'candidate_generation_authority_mismatch' | 'candidate_generation_ownership_lost' | 'invalid_model_proposal' | 'schema_mismatch' | 'invalid_operation_shape' | 'invalid_path' | 'proposal_limit_exceeded' | 'fresh_observation_missing' | 'model_limit_exceeded' | 'model_protocol_error' | 'model_timeout' | 'unread_existing_file' | 'model_provider_mismatch' | 'model_provider_failed' | 'context_source_unavailable' | ModelProviderFailureCode;

export class AiCandidateGenerationError extends Error {
  constructor(public readonly code: AiCandidateGenerationErrorCode, public readonly retryAfterMs: number | null = null) { super(code); this.name = 'AiCandidateGenerationError'; }
}

export interface AiCandidateGenerationExecution {
  result: AiCandidateGenerationModelResult;
  usage: { inputTokens: number; outputTokens: number; toolCallCount: number; modelTurnCount: number };
}

interface RunInput {
  generationId: string;
  generationAttemptId: string;
  ownershipToken: string;
  aiInvestigationId: string;
  investigationId: string;
  workspaceId: string;
  baseCommitSha: string;
  profileIdentity: string;
  baselineId: string;
}

function boundedUsage(value: unknown, max: number): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), max) : 0; }

export async function runAiCandidateGeneration(database: VigiloDatabase, gateway: InvestigationSourceGateway, configuration: GitHubAppConfiguration, provider: InvestigationModelProvider, input: RunInput, options: { signal?: AbortSignal; randomId?: () => string; timeoutMs?: number } = {}): Promise<AiCandidateGenerationExecution> {
  const [authority] = await database.select({ generation: aiCandidateGeneration, source: aiInvestigation, parent: investigation, intent: repairIntent, profile: executionProfile, baseline: repositoryBaseline })
    .from(aiCandidateGeneration).innerJoin(aiInvestigation, eq(aiInvestigation.id, aiCandidateGeneration.aiInvestigationId)).innerJoin(investigation, eq(investigation.id, aiCandidateGeneration.investigationId)).innerJoin(repairIntent, eq(repairIntent.id, investigation.repairIntentId)).innerJoin(executionProfile, and(eq(executionProfile.githubRepositoryId, investigation.githubRepositoryId), eq(executionProfile.workspaceId, investigation.workspaceId))).innerJoin(repositoryBaseline, eq(repositoryBaseline.id, investigation.baselineId))
    .where(and(eq(aiCandidateGeneration.id, input.generationId), eq(aiCandidateGeneration.workspaceId, input.workspaceId))).limit(1);
  if (!authority || authority.generation.protocolVersion !== AI_CANDIDATE_GENERATION_PROTOCOL_VERSION || authority.generation.aiInvestigationId !== input.aiInvestigationId || authority.generation.investigationId !== input.investigationId || authority.generation.baseCommitSha !== input.baseCommitSha || authority.generation.profileIdentity !== input.profileIdentity || authority.generation.baselineId !== input.baselineId || authority.generation.state !== 'generating' || authority.source.state !== 'completed' || authority.source.conclusionStatus !== 'diagnosis_found' || authority.parent.state !== 'ready' || authority.profile.status !== 'ready' || authority.parent.baseCommitSha !== input.baseCommitSha || authority.profile.baseCommitSha !== input.baseCommitSha || authority.baseline.baseCommitSha !== input.baseCommitSha || authority.parent.profileIdentity !== input.profileIdentity || authority.profile.profileIdentity !== input.profileIdentity || authority.baseline.profileIdentity !== input.profileIdentity) throw new AiCandidateGenerationError('candidate_generation_authority_mismatch');

  const conclusion = { status: authority.source.conclusionStatus, summary: authority.source.summary, suspectedFiles: authority.source.suspectedFiles, evidence: authority.source.evidenceReferences, proposedApproach: authority.source.proposedApproach, confidence: authority.source.confidence };
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort('model_timeout'), options.timeoutMs ?? AI_CANDIDATE_GENERATION_LIMITS.timeoutMs); const externalAbort = () => controller.abort(options.signal?.reason); options.signal?.addEventListener('abort', externalAbort, { once: true });
  const session = provider.createSession({
    instructions: AI_CANDIDATE_PROPOSAL_INSTRUCTIONS,
    initialInput: buildAiCandidateProposalInput({ objective: authority.intent.objective, conclusion, baseCommitSha: input.baseCommitSha, profile: { runtimeFamily: authority.profile.runtimeFamily, nodeMajor: authority.profile.nodeMajor, packageManager: authority.profile.packageManager, testRunner: authority.profile.testRunner, commands: [authority.profile.installOperation, authority.profile.typecheckScript, authority.profile.buildScript, authority.profile.testScript].filter(Boolean) }, baseline: { id: authority.baseline.id, executionOutcome: authority.baseline.executionOutcome, overallOutcome: authority.baseline.overallOutcome }, context: { maxOperations: authority.parent.maxOperations, maxCumulativeBytes: authority.parent.maxCumulativeBytes, maxGenerationContextBytes: AI_CANDIDATE_GENERATION_LIMITS.maxContextResultBytes } }),
    finalizationInput: AI_CANDIDATE_PROPOSAL_FINALIZATION_INPUT,
    tools: AI_CANDIDATE_PROPOSAL_TOOLS, conclusionSchema: AI_CANDIDATE_PROPOSAL_PROVIDER_SCHEMA, maxOutputTokens: AI_CANDIDATE_GENERATION_LIMITS.maxOutputTokens,
  });
  const perTool: Record<ToolName, number> = { listPaths: 0, readTextFile: 0, searchText: 0, readBaselineSummary: 0 };
  const operationTools: Record<string, ToolName> = { list_paths: 'listPaths', read_text_file: 'readTextFile', search_text: 'searchText', read_baseline_summary: 'readBaselineSummary' };
  const priorOperations = await database.select({ operation: investigationContextEvent.operation }).from(investigationContextEvent).where(eq(investigationContextEvent.aiCandidateGenerationId, input.generationId));
  for (const operation of priorOperations) {
    const name = operationTools[operation.operation];
    if (name) perTool[name] += 1;
  }
  const observedFiles = new Map<string, string>();
  const aiAudit = { aiCandidateGenerationId: input.generationId, aiCandidateGenerationAttemptId: input.generationAttemptId, ownershipToken: input.ownershipToken };
  const workspaceAuthority = { workspace: { id: input.workspaceId } }; const randomId = options.randomId ?? randomUUID;
  let outputs: Array<{ callId: string; output: string }> | undefined;
  let inputTokens = authority.generation.inputTokens;
  let outputTokens = authority.generation.outputTokens;
  let calls = authority.generation.toolCallCount;
  let turns = authority.generation.modelTurnCount;
  const usage = () => ({ inputTokens, outputTokens, toolCallCount: calls, modelTurnCount: turns });
  const assertOwnership = async () => {
    const [owned] = await database.select({ id: aiCandidateGenerationAttempt.id }).from(aiCandidateGenerationAttempt).innerJoin(aiCandidateGeneration, and(eq(aiCandidateGeneration.id, aiCandidateGenerationAttempt.generationId), eq(aiCandidateGeneration.state, 'generating'))).where(and(eq(aiCandidateGenerationAttempt.id, input.generationAttemptId), eq(aiCandidateGenerationAttempt.generationId, input.generationId), eq(aiCandidateGenerationAttempt.ownershipToken, input.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, new Date()))).limit(1);
    if (!owned) throw new AiCandidateGenerationError('candidate_generation_ownership_lost');
  };
  const persistUsage = async () => {
    await database.transaction(async (transaction) => {
      const [owned] = await transaction.select({ id: aiCandidateGenerationAttempt.id }).from(aiCandidateGenerationAttempt).innerJoin(aiCandidateGeneration, and(eq(aiCandidateGeneration.id, aiCandidateGenerationAttempt.generationId), eq(aiCandidateGeneration.state, 'generating'))).where(and(eq(aiCandidateGenerationAttempt.id, input.generationAttemptId), eq(aiCandidateGenerationAttempt.generationId, input.generationId), eq(aiCandidateGenerationAttempt.ownershipToken, input.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, new Date()))).for('update').limit(1);
      if (!owned) throw new AiCandidateGenerationError('candidate_generation_ownership_lost');
      const [updated] = await transaction.update(aiCandidateGeneration).set({ ...usage(), updatedAt: new Date() }).where(and(eq(aiCandidateGeneration.id, input.generationId), eq(aiCandidateGeneration.state, 'generating'))).returning({ id: aiCandidateGeneration.id });
      if (!updated) throw new AiCandidateGenerationError('candidate_generation_ownership_lost');
    });
  };
  const validateResult = (turn: { toolCalls: Array<unknown>; conclusion: unknown | null }, finalization: boolean): AiCandidateGenerationModelResult => {
    if (turn.toolCalls.length !== 0) throw new AiCandidateGenerationError(finalization ? 'model_limit_exceeded' : 'model_protocol_error');
    let result;
    try { result = parseAiCandidateProposal(turn.conclusion); } catch (error) { throw new AiCandidateGenerationError(error instanceof AiCandidateProposalValidationError ? error.code : 'invalid_model_proposal'); }
    if (result.status === 'insufficient_evidence') return result;
    return {
      status: 'proposal_ready',
      proposal: {
        files: result.proposal.files.map((file) => {
          if (file.operation === 'add') return { ...file, expectedBaseIdentity: null };
          const expectedBaseIdentity = observedFiles.get(file.path);
          if (!expectedBaseIdentity) throw new AiCandidateGenerationError('fresh_observation_missing');
          return { ...file, expectedBaseIdentity };
        }),
      },
    };
  };
  const request = async (finalization: boolean) => {
    if (controller.signal.aborted) throw new AiCandidateGenerationError('model_timeout');
    await assertOwnership();
    turns += 1;
    await persistUsage();
    let turn;
    try { turn = await session.next({ ...(outputs ? { toolOutputs: outputs } : {}), ...(finalization ? { finalization: true } : {}), signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted) throw new AiCandidateGenerationError('model_timeout');
      if (error instanceof ModelProviderError) throw new AiCandidateGenerationError(error.code, error.retryAfterMs);
      if (error instanceof Error && error.message === 'model_protocol_error') throw new AiCandidateGenerationError(finalization ? 'model_limit_exceeded' : 'model_protocol_error');
      throw new AiCandidateGenerationError('model_protocol_error');
    }
    inputTokens += boundedUsage(turn.usage?.inputTokens, 1_000_000 - inputTokens);
    outputTokens += boundedUsage(turn.usage?.outputTokens, 100_000 - outputTokens);
    await persistUsage();
    return turn;
  };
  const finalize = async (): Promise<AiCandidateGenerationExecution> => {
    if (turns + AI_CANDIDATE_GENERATION_LIMITS.reservedFinalizationTurns > AI_CANDIDATE_GENERATION_LIMITS.maxModelTurns) throw new AiCandidateGenerationError('model_limit_exceeded');
    const turn = await request(true);
    return { result: validateResult(turn, true), usage: usage() };
  };
  try {
    while (turns < AI_CANDIDATE_GENERATION_LIMITS.maxToolBearingTurns) {
      const turn = await request(false);
      if (turn.toolCalls.length === 0) {
        return { result: validateResult(turn, false), usage: usage() };
      }
      if (turn.conclusion !== null || turn.toolCalls.length !== 1) throw new AiCandidateGenerationError('model_protocol_error');
      if (calls >= AI_CANDIDATE_GENERATION_LIMITS.maxToolCalls) {
        const call = turn.toolCalls[0]!;
        outputs = [{ callId: call.callId, output: aiCandidateProposalToolOutput(randomId(), { error: 'candidate_generation_tool_budget_exhausted' }) }];
        return finalize();
      }
      const call = turn.toolCalls[0]!;
      if (!['listPaths', 'readTextFile', 'searchText', 'readBaselineSummary'].includes(call.name)) throw new AiCandidateGenerationError('model_protocol_error');
      const name = call.name as ToolName; perTool[name] += 1;
      if (perTool[name] > AI_CANDIDATE_GENERATION_LIMITS.perTool[name]) {
        outputs = [{ callId: call.callId, output: aiCandidateProposalToolOutput(randomId(), { error: 'candidate_generation_tool_budget_exhausted' }) }];
        return finalize();
      }
      calls += 1; await persistUsage(); const operationId = randomId();
      try {
        let output: unknown;
        if (name === 'listPaths') { if (JSON.stringify(call.arguments) !== '{}') throw new AiCandidateGenerationError('model_protocol_error'); output = await listPaths(database, workspaceAuthority, input.investigationId, operationId, undefined, aiAudit); }
        else if (name === 'readTextFile') { if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) || Object.keys(call.arguments).length !== 1 || typeof (call.arguments as { path?: unknown }).path !== 'string') throw new AiCandidateGenerationError('model_protocol_error'); output = await readTextFile(database, workspaceAuthority, gateway, configuration, input.investigationId, operationId, (call.arguments as { path: string }).path, aiAudit); const file = output as { path: string; blobSha: string }; observedFiles.set(file.path, file.blobSha); }
        else if (name === 'searchText') { if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) || Object.keys(call.arguments).length !== 1 || typeof (call.arguments as { query?: unknown }).query !== 'string') throw new AiCandidateGenerationError('model_protocol_error'); output = await searchText(database, workspaceAuthority, gateway, configuration, input.investigationId, operationId, (call.arguments as { query: string }).query, aiAudit); }
        else { if (JSON.stringify(call.arguments) !== '{}') throw new AiCandidateGenerationError('model_protocol_error'); output = await readBaselineSummary(database, workspaceAuthority, input.investigationId, operationId, aiAudit); }
        outputs = [{ callId: call.callId, output: aiCandidateProposalToolOutput(operationId, output) }];
      } catch (error) {
        if (error instanceof AiCandidateGenerationError) throw error;
        if (error instanceof InvestigationContextError && error.code === 'context_budget_exhausted') {
          outputs = [{ callId: call.callId, output: aiCandidateProposalToolOutput(operationId, { error: 'context_budget_exhausted' }) }];
          return finalize();
        }
        if (error instanceof InvestigationContextError && ['invalid_context_request', 'context_operation_replayed'].includes(error.code)) throw new AiCandidateGenerationError('candidate_generation_ownership_lost');
        if (error instanceof InvestigationContextError && ['investigation_not_found', 'investigation_not_ready'].includes(error.code)) throw new AiCandidateGenerationError('candidate_generation_authority_mismatch');
        if (error instanceof InvestigationContextError && ['context_source_unavailable', 'content_identity_mismatch'].includes(error.code)) throw new AiCandidateGenerationError('context_source_unavailable');
        if (error instanceof InvestigationContextError) {
          outputs = [{ callId: call.callId, output: aiCandidateProposalToolOutput(operationId, { error: error.code }) }];
          continue;
        }
        throw new AiCandidateGenerationError('model_provider_failed');
      }
    }
    return finalize();
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', externalAbort); }
}
