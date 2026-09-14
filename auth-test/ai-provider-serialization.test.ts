import assert from 'node:assert/strict';
import test from 'node:test';

import { GeminiInvestigationProvider } from '../lib/ai-investigations/gemini-provider.ts';
import { AI_CANDIDATE_PROPOSAL_FINALIZATION_INPUT, AI_CANDIDATE_PROPOSAL_INSTRUCTIONS, AI_CANDIDATE_PROPOSAL_PROVIDER_SCHEMA, AI_CANDIDATE_PROPOSAL_TOOLS, buildAiCandidateProposalInput } from '../lib/ai-candidate-generations/protocol.ts';
import { collectGeminiResponseSchemaKeywords, unsupportedGeminiResponseSchemaKeywords } from '../lib/ai-candidate-generations/gemini-schema.ts';
import { AI_CANDIDATE_GENERATION_LIMITS } from '../lib/ai-candidate-generations/types.ts';
import { buildInitialInput, CONCLUSION_SCHEMA, MODEL_INSTRUCTIONS, MODEL_TOOLS } from '../lib/ai-investigations/protocol.ts';
import { AI_LIMITS, AI_MODEL_ID } from '../lib/ai-investigations/types.ts';

type CapturedRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  nonSensitiveHeaderNames: string[];
  hasSensitiveCredentialHeader: boolean;
  hasOnlyFakeApiKeyHeader: boolean;
};

const FAKE_API_KEY = 'transport-test-key-not-a-real-credential';
const SENSITIVE_HEADER = /^(authorization|x-goog-api-key|api[-_]?key|cookie)$/i;

function completedInteraction(id: number): Response {
  return new Response(JSON.stringify({
    id: `transport-capture-${id}`,
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: '{}' }] }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function captureSerializedRequests(): Promise<{ requests: CapturedRequest[]; delegatedToRealFetch: number }> {
  const realFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  let delegatedToRealFetch = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headerNames = [...request.headers.keys()];
    const sensitiveHeaders = [...request.headers.entries()]
      .filter(([name]) => SENSITIVE_HEADER.test(name))
    const bodyText = await request.text();
    assert.doesNotMatch(bodyText, new RegExp(FAKE_API_KEY, 'u'));
    assert.equal(url.search.includes(FAKE_API_KEY), false);
    requests.push({
      method: request.method,
      path: url.pathname,
      body: JSON.parse(bodyText) as Record<string, unknown>,
      nonSensitiveHeaderNames: headerNames.filter((name) => !SENSITIVE_HEADER.test(name)).sort(),
      hasSensitiveCredentialHeader: headerNames.some((name) => SENSITIVE_HEADER.test(name)),
      hasOnlyFakeApiKeyHeader: sensitiveHeaders.length === 2
        && sensitiveHeaders.some(([name, value]) => name === 'x-goog-api-key' && value === FAKE_API_KEY)
        && sensitiveHeaders.every(([name, value]) => (name === 'x-goog-api-key' && value === FAKE_API_KEY) || (name === 'cookie' && value === '')),
    });
    return completedInteraction(requests.length);
  };

  try {
    const provider = new GeminiInvestigationProvider(FAKE_API_KEY, AI_MODEL_ID);
    const investigation = provider.createSession({
      instructions: MODEL_INSTRUCTIONS,
      initialInput: buildInitialInput({ objective: 'controlled test objective', baseCommitSha: 'a'.repeat(40), profile: {}, baseline: {}, context: {} }),
      tools: MODEL_TOOLS,
      conclusionSchema: CONCLUSION_SCHEMA,
      maxOutputTokens: AI_LIMITS.maxOutputTokens,
    });
    await investigation.next({ signal: new AbortController().signal });

    const candidate = provider.createSession({
      instructions: AI_CANDIDATE_PROPOSAL_INSTRUCTIONS,
      initialInput: buildAiCandidateProposalInput({ objective: 'controlled test objective', conclusion: {}, baseCommitSha: 'a'.repeat(40), profile: {}, baseline: {}, context: {} }),
      finalizationInput: AI_CANDIDATE_PROPOSAL_FINALIZATION_INPUT,
      tools: AI_CANDIDATE_PROPOSAL_TOOLS,
      conclusionSchema: AI_CANDIDATE_PROPOSAL_PROVIDER_SCHEMA,
      maxOutputTokens: AI_CANDIDATE_GENERATION_LIMITS.maxOutputTokens,
    });
    await candidate.next({ signal: new AbortController().signal });
    await candidate.next({ finalization: true, signal: new AbortController().signal });
  } finally {
    globalThis.fetch = realFetch;
  }

  return { requests, delegatedToRealFetch };
}

test('Gemini 2.22.0 serializes the Task 4.1 and Task 4.2 protocol boundary without external transport', async () => {
  const { requests, delegatedToRealFetch } = await captureSerializedRequests();
  assert.equal(delegatedToRealFetch, 0);
  assert.equal(requests.length, 3);

  const task41 = requests[0];
  const task42Investigation = requests[1];
  const task42Finalization = requests[2];
  if (!task41 || !task42Investigation || !task42Finalization) throw new Error('expected exactly three captured requests');
  assert.deepEqual(requests.map((request) => ({ method: request.method, path: request.path })), [
    { method: 'POST', path: '/v1beta/interactions' },
    { method: 'POST', path: '/v1beta/interactions' },
    { method: 'POST', path: '/v1beta/interactions' },
  ]);

  for (const request of requests) {
    assert.equal(request.body.model, AI_MODEL_ID);
    assert.equal(typeof request.body.system_instruction, 'string');
    assert.equal(request.body.store, false);
    assert.equal(Object.hasOwn(request.body, 'previous_interaction_id'), false);
    assert.equal(Object.hasOwn(request.body, 'stream'), false);
    assert.deepEqual(request.body.generation_config, {
      thinking_level: 'medium', thinking_summaries: 'none',
      max_output_tokens: request === task41 ? AI_LIMITS.maxOutputTokens : AI_CANDIDATE_GENERATION_LIMITS.maxOutputTokens,
    });
    assert.deepEqual((request.body.response_format as { type: string; mime_type: string }).type, 'text');
    assert.deepEqual((request.body.response_format as { type: string; mime_type: string }).mime_type, 'application/json');
    assert.deepEqual(request.nonSensitiveHeaderNames, ['accept', 'content-type', 'user-agent', 'x-goog-api-client']);
    assert.equal(request.hasSensitiveCredentialHeader, true);
    assert.equal(request.hasOnlyFakeApiKeyHeader, true);
  }

  assert.deepEqual((task41.body.tools as Array<{ name: string }>).map((tool) => tool.name), MODEL_TOOLS.map((tool) => tool.name));
  assert.deepEqual((task42Investigation.body.tools as Array<{ name: string }>).map((tool) => tool.name), AI_CANDIDATE_PROPOSAL_TOOLS.map((tool) => tool.name));
  assert.deepEqual(task42Finalization.body.tools, []);
  assert.equal(Array.isArray(task41.body.input), true);
  assert.equal(Array.isArray(task42Investigation.body.input), true);
  assert.equal(Array.isArray(task42Finalization.body.input), true);
  assert.equal((task42Finalization.body.input as Array<{ type: string }>).at(-1)?.type, 'user_input');
  assert.match(JSON.stringify(task42Finalization.body.input), /only one JSON object/);

  const task42Schema = (task42Investigation.body.response_format as { schema: unknown }).schema;
  const task42FinalizationSchema = (task42Finalization.body.response_format as { schema: unknown }).schema;
  assert.deepEqual(task42Schema, AI_CANDIDATE_PROPOSAL_PROVIDER_SCHEMA);
  assert.deepEqual(task42FinalizationSchema, AI_CANDIDATE_PROPOSAL_PROVIDER_SCHEMA);
  assert.deepEqual(unsupportedGeminiResponseSchemaKeywords(task42Schema), []);
  assert.deepEqual(collectGeminiResponseSchemaKeywords(task42Schema), ['additionalProperties', 'description', 'enum', 'items', 'maxItems', 'minItems', 'properties', 'required', 'type']);
  const task42Root = task42Schema as { additionalProperties: boolean; properties: { status: { enum: readonly string[] }; files: { minItems: number; maxItems: number; items: { additionalProperties: boolean; required: readonly string[] } } }; required: readonly string[] };
  assert.deepEqual(task42Root.properties.status.enum, ['proposal_ready', 'insufficient_evidence']);
  assert.equal(task42Root.additionalProperties, false);
  assert.deepEqual(task42Root.required, ['status', 'files']);
  assert.equal(task42Root.properties.files.minItems, 0);
  assert.equal(task42Root.properties.files.maxItems, 4);
  assert.deepEqual(task42Root.properties.files.items.required, ['path', 'operation', 'resultingContent']);
  assert.equal(task42Root.properties.files.items.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(task42Schema), /"(?:anyOf|oneOf|const|minLength|maxLength|pattern)"\s*:/);
});
