import { randomUUID } from 'node:crypto';

import { and, eq, gt } from 'drizzle-orm';

import { aiInvestigation, aiInvestigationAttempt, executionProfile, investigation, repairIntent, repositoryBaseline } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { InvestigationContextError, listPaths, readBaselineSummary, readTextFile, searchText } from '../investigations/context.ts';
import type { InvestigationSourceGateway } from '../investigations/types.ts';
import { buildInitialInput, CONCLUSION_SCHEMA, encodeToolOutput, MODEL_INSTRUCTIONS, MODEL_TOOLS, parseConclusion, parseToolArguments } from './protocol.ts';
import { AI_LIMITS, ModelProviderError, type InvestigationConclusion, type InvestigationModelProvider, type ModelProviderFailureCode, type ToolName } from './types.ts';

export type AiAgentErrorCode =
  | 'ai_authority_mismatch'
  | 'ai_investigation_ownership_lost'
  | 'model_protocol_error'
  | 'model_limit_exceeded'
  | 'model_timeout'
  | 'fabricated_evidence_reference'
  | 'unobserved_suspected_file'
  | 'model_provider_failed'
  | 'model_provider_mismatch'
  | ModelProviderFailureCode;

export class AiAgentError extends Error {
  constructor(public readonly code: AiAgentErrorCode, public readonly retryAfterMs: number | null = null) {
    super(code);
    this.name = 'AiAgentError';
  }
}

export interface AiAgentExecution {
  completionReason: 'model_conclusion' | 'budget_exhausted';
  conclusion: InvestigationConclusion;
  usage: { inputTokens: number; outputTokens: number; toolCallCount: number; modelTurnCount: number };
}

interface RunInput {
  aiInvestigationId: string;
  aiInvestigationAttemptId: string;
  ownershipToken: string;
  investigationId: string;
  workspaceId: string;
  baseCommitSha: string;
  profileIdentity: string;
  baselineId: string;
}

function boundedUsage(value: unknown, max: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), max) : 0;
}

export async function runAiInvestigation(
  database: VigiloDatabase,
  gateway: InvestigationSourceGateway,
  configuration: GitHubAppConfiguration,
  provider: InvestigationModelProvider,
  input: RunInput,
  options: { signal?: AbortSignal; randomId?: () => string; timeoutMs?: number } = {},
): Promise<AiAgentExecution> {
  const [authority] = await database.select({ current: investigation, intent: repairIntent, profile: executionProfile, baseline: repositoryBaseline })
    .from(investigation)
    .innerJoin(repairIntent, eq(repairIntent.id, investigation.repairIntentId))
    .innerJoin(executionProfile, and(eq(executionProfile.githubRepositoryId, investigation.githubRepositoryId), eq(executionProfile.workspaceId, investigation.workspaceId)))
    .innerJoin(repositoryBaseline, eq(repositoryBaseline.id, investigation.baselineId))
    .where(and(eq(investigation.id, input.investigationId), eq(investigation.workspaceId, input.workspaceId))).limit(1);
  if (!authority || authority.current.state !== 'ready' || authority.current.baseCommitSha !== input.baseCommitSha || authority.current.profileIdentity !== input.profileIdentity || authority.current.baselineId !== input.baselineId || authority.profile.baseCommitSha !== input.baseCommitSha || authority.profile.profileIdentity !== input.profileIdentity || authority.baseline.baseCommitSha !== input.baseCommitSha || authority.baseline.profileIdentity !== input.profileIdentity) throw new AiAgentError('ai_authority_mismatch');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('model_timeout'), options.timeoutMs ?? AI_LIMITS.timeoutMs);
  const externalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  const session = provider.createSession({
    instructions: MODEL_INSTRUCTIONS,
    initialInput: buildInitialInput({
      objective: authority.intent.objective,
      baseCommitSha: authority.current.baseCommitSha,
      profile: { runtimeFamily: authority.profile.runtimeFamily, nodeMajor: authority.profile.nodeMajor, packageManager: authority.profile.packageManager, testRunner: authority.profile.testRunner, commands: [authority.profile.installOperation, authority.profile.typecheckScript, authority.profile.buildScript, authority.profile.testScript].filter(Boolean) },
      baseline: { id: authority.baseline.id, executionOutcome: authority.baseline.executionOutcome, overallOutcome: authority.baseline.overallOutcome },
      context: { version: authority.current.contextBudgetVersion, maxOperations: authority.current.maxOperations, maxCumulativeBytes: authority.current.maxCumulativeBytes, aiMaxContextResultBytes: AI_LIMITS.maxContextResultBytes, indexedPathCount: authority.current.indexedPathCount, treeTruncated: authority.current.treeTruncated },
    }),
    tools: MODEL_TOOLS,
    conclusionSchema: CONCLUSION_SCHEMA,
    maxOutputTokens: AI_LIMITS.maxOutputTokens,
  });
  const perTool: Record<ToolName, number> = { listPaths: 0, readTextFile: 0, searchText: 0, readBaselineSummary: 0 };
  const observed = new Map<string, { kind: 'baseline' | 'file' | 'search'; paths: string[] }>();
  let outputs: Array<{ callId: string; output: string }> | undefined;
  let inputTokens = 0; let outputTokens = 0; let calls = 0; let turns = 0;
  const randomId = options.randomId ?? randomUUID;
  const workspaceAuthority = { workspace: { id: input.workspaceId } };
  const aiAudit = { aiInvestigationId: input.aiInvestigationId, aiInvestigationAttemptId: input.aiInvestigationAttemptId, ownershipToken: input.ownershipToken };
  const usage = () => ({ inputTokens, outputTokens, toolCallCount: calls, modelTurnCount: turns });
  const assertOwnership = async () => {
    const [owned] = await database.select({ id: aiInvestigationAttempt.id }).from(aiInvestigationAttempt).innerJoin(aiInvestigation, and(
      eq(aiInvestigation.id, aiInvestigationAttempt.aiInvestigationId),
      eq(aiInvestigation.state, 'investigating'),
    )).where(and(
      eq(aiInvestigationAttempt.id, input.aiInvestigationAttemptId),
      eq(aiInvestigationAttempt.aiInvestigationId, input.aiInvestigationId),
      eq(aiInvestigationAttempt.ownershipToken, input.ownershipToken),
      eq(aiInvestigationAttempt.state, 'active'),
      gt(aiInvestigationAttempt.leaseExpiresAt, new Date()),
    )).limit(1);
    if (!owned) throw new AiAgentError('ai_investigation_ownership_lost');
  };
  const validateConclusion = (turn: { toolCalls: Array<unknown>; conclusion: unknown | null }, finalization: boolean): InvestigationConclusion => {
    if (turn.toolCalls.length !== 0) throw new AiAgentError(finalization ? 'model_limit_exceeded' : 'model_protocol_error');
    let conclusion: InvestigationConclusion;
    try { conclusion = parseConclusion(turn.conclusion); }
    catch { throw new AiAgentError(finalization ? 'model_limit_exceeded' : 'model_protocol_error'); }
    for (const evidence of conclusion.evidence) {
      const fact = observed.get(evidence.reference);
      if (!fact || fact.kind !== evidence.kind) throw new AiAgentError('fabricated_evidence_reference');
    }
    const observedPaths = new Set([...observed.values()].flatMap((fact) => fact.paths));
    if (conclusion.suspectedFiles.some((file) => !observedPaths.has(file.path))) throw new AiAgentError('unobserved_suspected_file');
    return conclusion;
  };
  const request = async (finalization: boolean) => {
    if (controller.signal.aborted) throw new AiAgentError('model_timeout');
    await assertOwnership();
    let turn;
    try { turn = await session.next({ ...(outputs ? { toolOutputs: outputs } : {}), ...(finalization ? { finalization: true } : {}), signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted) throw new AiAgentError('model_timeout');
      if (error instanceof ModelProviderError) throw new AiAgentError(error.code, error.retryAfterMs);
      if (error instanceof Error && error.message === 'model_protocol_error') throw new AiAgentError(finalization ? 'model_limit_exceeded' : 'model_protocol_error');
      throw new AiAgentError('provider_infrastructure_failed');
    }
    turns += 1;
    inputTokens += boundedUsage(turn.usage?.inputTokens, 1_000_000 - inputTokens);
    outputTokens += boundedUsage(turn.usage?.outputTokens, 100_000 - outputTokens);
    return turn;
  };
  const finalize = async (): Promise<AiAgentExecution> => {
    if (turns + AI_LIMITS.reservedFinalizationTurns > AI_LIMITS.maxModelTurns) throw new AiAgentError('model_limit_exceeded');
    const turn = await request(true);
    const conclusion = validateConclusion(turn, true);
    return { completionReason: 'budget_exhausted', conclusion, usage: usage() };
  };
  try {
    while (turns < AI_LIMITS.maxToolBearingTurns) {
      const turn = await request(false);
      if (turn.toolCalls.length === 0) {
        const conclusion = validateConclusion(turn, false);
        return { completionReason: 'model_conclusion', conclusion, usage: usage() };
      }
      if (turn.conclusion !== null || turn.toolCalls.length !== 1) throw new AiAgentError('model_protocol_error');
      if (calls >= AI_LIMITS.maxToolCalls) {
        const call = turn.toolCalls[0]!;
        outputs = [{ callId: call.callId, output: encodeToolOutput(randomId(), { error: 'investigation_tool_budget_exhausted' }) }];
        return finalize();
      }
      const call = turn.toolCalls[0]!;
      let parsed;
      try { parsed = parseToolArguments(call.name, call.arguments); } catch { throw new AiAgentError('model_protocol_error'); }
      perTool[parsed.name] += 1;
      if (perTool[parsed.name] > AI_LIMITS.perTool[parsed.name]) {
        outputs = [{ callId: call.callId, output: encodeToolOutput(randomId(), { error: 'investigation_tool_budget_exhausted' }) }];
        return finalize();
      }
      calls += 1;
      const operationId = randomId();
      try {
        let result: unknown; let kind: 'baseline' | 'file' | 'search' | null = null; let paths: string[] = [];
        if (parsed.name === 'listPaths') result = await listPaths(database, workspaceAuthority, input.investigationId, operationId, undefined, aiAudit);
        else if (parsed.name === 'readTextFile') { result = await readTextFile(database, workspaceAuthority, gateway, configuration, input.investigationId, operationId, parsed.arguments.path, aiAudit); kind = 'file'; paths = [parsed.arguments.path]; }
        else if (parsed.name === 'searchText') { result = await searchText(database, workspaceAuthority, gateway, configuration, input.investigationId, operationId, parsed.arguments.query, aiAudit); kind = 'search'; paths = result && typeof result === 'object' && 'matches' in result ? (result as { matches: Array<{ path: string }> }).matches.map((match) => match.path) : []; }
        else { result = await readBaselineSummary(database, workspaceAuthority, input.investigationId, operationId, aiAudit); kind = 'baseline'; }
        if (controller.signal.aborted) throw new AiAgentError('model_timeout');
        if (kind) observed.set(operationId, { kind, paths });
        outputs = [{ callId: call.callId, output: encodeToolOutput(operationId, result) }];
      } catch (error) {
        if (controller.signal.aborted) throw new AiAgentError('model_timeout');
        if (error instanceof InvestigationContextError && error.code === 'context_budget_exhausted') {
          outputs = [{ callId: call.callId, output: encodeToolOutput(operationId, { error: 'context_budget_exhausted' }) }];
          return finalize();
        }
        if (error instanceof InvestigationContextError && error.code === 'invalid_context_request') throw new AiAgentError('ai_investigation_ownership_lost');
        const code = error instanceof InvestigationContextError ? error.code : 'context_tool_failed';
        outputs = [{ callId: call.callId, output: encodeToolOutput(operationId, { error: code }) }];
      }
    }
    return finalize();
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', externalAbort);
  }
}
