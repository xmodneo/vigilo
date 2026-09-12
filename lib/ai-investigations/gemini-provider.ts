import { GoogleGenAI, type Interactions } from '@google/genai';

import { ModelProviderError, type InvestigationModelProvider, type InvestigationModelSession, type ModelTurn } from './types.ts';
import { FINALIZATION_INPUT } from './protocol.ts';

interface GeminiInteractionsClient {
  create(
    request: Interactions.CreateModelInteractionParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Interactions.Interaction>;
}

const CALL_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_STRUCTURED_OUTPUT_BYTES = 32 * 1024;
const ALLOWED_RESPONSE_STEPS = new Set(['thought', 'function_call', 'model_output']);
const MAX_PROVIDER_ERROR_TEXT_BYTES = 32 * 1024;
const MAX_TRANSIENT_RETRY_AFTER_MS = 60_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function providerStatus(error: unknown): number | null {
  const value = record(error);
  for (const candidate of [value?.status, value?.statusCode]) if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
  return null;
}

function boundedProviderErrorText(error: unknown): string {
  const value = record(error);
  const nested = record(value?.error);
  const nestedError = record(nested?.error);
  const parts = [error instanceof Error ? error.message : null, value?.message, value?.body, nested?.message, nestedError?.message]
    .filter((part): part is string => typeof part === 'string');
  return parts.join('\n').slice(0, MAX_PROVIDER_ERROR_TEXT_BYTES);
}

function shortRetryAfter(error: unknown): number | null {
  const headers = record(error)?.headers;
  let value: string | null = null;
  if (headers instanceof Headers) value = headers.get('retry-after');
  else {
    const object = record(headers);
    const candidate = object?.['retry-after'] ?? object?.['Retry-After'];
    if (typeof candidate === 'string') value = candidate;
  }
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const milliseconds = Math.ceil(Number(value) * 1_000);
  return milliseconds >= 1_000 && milliseconds <= MAX_TRANSIENT_RETRY_AFTER_MS ? milliseconds : null;
}

export function classifyGeminiProviderError(error: unknown): ModelProviderError {
  const status = providerStatus(error);
  const text = boundedProviderErrorText(error);
  if (status === 429) {
    const freeTierRequestQuota = /generate_content_free_tier_requests/i.test(text);
    const dailyProjectAllowance = /generateRequestsPerDayPerProject|requests?[\s_/-]*per[\s_/-]*day|per[_-]?day|daily/i.test(text);
    if (freeTierRequestQuota && dailyProjectAllowance) return new ModelProviderError('provider_quota_exhausted');
    return new ModelProviderError('provider_rate_limited', shortRetryAfter(error));
  }
  if ([400, 401, 403, 404, 422].includes(status ?? -1)) return new ModelProviderError('provider_configuration_failed');
  return new ModelProviderError('provider_infrastructure_failed');
}

export function readModelApiKey(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.GEMINI_API_KEY;
  if (!value || value.trim().length < 20) throw new ModelProviderError('provider_configuration_failed');
  return value;
}

function parseFunctionCalls(steps: Interactions.Step[]): Array<{ callId: string; name: string; arguments: unknown }> {
  const calls = [];
  for (const step of steps) {
    if (!ALLOWED_RESPONSE_STEPS.has(step.type)) throw new Error('model_protocol_error');
    if (step.type !== 'function_call') continue;
    if (!CALL_ID.test(step.id) || typeof step.name !== 'string' || step.name.length > 128 || !step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)) {
      throw new Error('model_protocol_error');
    }
    calls.push({ callId: step.id, name: step.name, arguments: step.arguments });
  }
  return calls;
}

function parseStructuredOutput(output: string | undefined): unknown | null {
  if (!output || Buffer.byteLength(output, 'utf8') > MAX_STRUCTURED_OUTPUT_BYTES) return null;
  try { return JSON.parse(output); } catch { return null; }
}

export class GeminiInvestigationProvider implements InvestigationModelProvider {
  readonly providerId = 'google';

  constructor(
    apiKey: string,
    readonly modelId = 'gemini-3.1-flash-lite',
    private readonly client: GeminiInteractionsClient = new GoogleGenAI({ apiKey }).interactions,
  ) {}

  createSession(configuration: Parameters<InvestigationModelProvider['createSession']>[0]): InvestigationModelSession {
    const history: Interactions.Step[] = [
      { type: 'user_input', content: [{ type: 'text', text: configuration.initialInput }] },
    ];
    const callNames = new Map<string, string>();

    return {
      next: async ({ toolOutputs = [], finalization = false, signal }): Promise<ModelTurn> => {
        for (const output of toolOutputs) {
          const name = callNames.get(output.callId);
          if (!name) throw new Error('model_protocol_error');
          history.push({ type: 'function_result', call_id: output.callId, name, result: [{ type: 'text', text: output.output }] });
        }
        if (finalization) history.push({ type: 'user_input', content: [{ type: 'text', text: FINALIZATION_INPUT }] });

        let response: Interactions.Interaction;
        try {
          response = await this.client.create({
            model: this.modelId,
            input: [...history],
            system_instruction: configuration.instructions,
            tools: (finalization ? [] : configuration.tools).map((tool) => ({
              type: 'function' as const,
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
            generation_config: {
              thinking_level: 'medium',
              thinking_summaries: 'none',
              max_output_tokens: configuration.maxOutputTokens,
            },
            response_format: {
              type: 'text',
              mime_type: 'application/json',
              schema: configuration.conclusionSchema,
            },
            store: false,
          }, { signal });
        } catch (error) {
          throw classifyGeminiProviderError(error);
        }

        if (!Array.isArray(response.steps)) throw new Error('model_protocol_error');
        const calls = parseFunctionCalls(response.steps);
        const statusMatchesSteps =
          (response.status === 'requires_action' && calls.length > 0)
          || (response.status === 'completed' && calls.length === 0);
        if (!statusMatchesSteps) throw new Error('model_protocol_error');
        for (const call of calls) callNames.set(call.callId, call.name);

        // Stateless continuation requires the exact provider steps, including opaque
        // thought signatures. They remain transient in this in-memory session.
        history.push(...response.steps);
        const conclusion = calls.length === 0 ? parseStructuredOutput(response.output_text) : null;
        const usage = response.usage
          ? {
              ...(typeof response.usage.total_input_tokens === 'number' ? { inputTokens: response.usage.total_input_tokens } : {}),
              ...(typeof response.usage.total_output_tokens === 'number' ? { outputTokens: response.usage.total_output_tokens } : {}),
            }
          : undefined;
        return { toolCalls: calls, conclusion, ...(usage ? { usage } : {}) };
      },
    };
  }
}
