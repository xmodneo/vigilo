const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|privatekey|apikey|databaseurl|prompt|source|content|commandoutput)/i;
const SENSITIVE_VALUE = /(bearer\s+[a-z0-9._~+/=-]{12,}|AIza[0-9A-Za-z_-]{20,}|(?:gh[psuor]_|github_pat_)[a-z0-9_]{10,}|sk-[a-z0-9_-]{16,}|-----BEGIN [^-]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s]+)/i;
const MAX_DEPTH = 5;
const MAX_ARRAY = 20;
const MAX_STRING_BYTES = 2_048;

function boundedString(value: string): string {
  if (SENSITIVE_VALUE.test(value)) return '[REDACTED]';
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_STRING_BYTES) return value;
  return bytes.subarray(0, MAX_STRING_BYTES).toString('utf8') + '[TRUNCATED]';
}

export function redactLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return boundedString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return '[UNSUPPORTED]';
  if (seen.has(value)) return '[CIRCULAR]';
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  seen.add(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < Math.min(value.length, MAX_ARRAY); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      output.push(descriptor && 'value' in descriptor ? redactLogValue(descriptor.value, depth + 1, seen) : '[ACCESSOR]');
    }
    return output;
  }
  if (value instanceof Error) return { code: 'operation_failed' };
  const output: Record<string, unknown> = {};
  let entries: Array<[string, PropertyDescriptor]>;
  try { entries = Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 40); }
  catch { return '[UNREADABLE]'; }
  for (const [key, descriptor] of entries) {
    output[key] = SENSITIVE_KEY.test(key.replace(/[^a-z0-9]/gi, ''))
      ? '[REDACTED]'
      : 'value' in descriptor ? redactLogValue(descriptor.value, depth + 1, seen) : '[ACCESSOR]';
  }
  return output;
}

export interface OperationalLogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  service: 'vigilo-web' | 'vigilo-worker' | 'vigilo-migrator' | 'vigilo-operation';
  releaseSha?: string;
  requestId?: string;
  entryPoint?: string;
  workspaceId?: string;
  repairRunId?: string;
  jobType?: string;
  jobId?: string;
  attemptOrdinal?: number;
  operationCategory?: string;
  providerId?: string;
  failureCode?: string;
  durationMs?: number;
}

export function writeOperationalLog(event: OperationalLogEvent, sink: (line: string) => void = console.log): void {
  const levels = new Set(['debug', 'info', 'warn', 'error']);
  const services = new Set(['vigilo-web', 'vigilo-worker', 'vigilo-migrator', 'vigilo-operation']);
  const token = (value: unknown, maximum = 128) => typeof value === 'string' && value.length <= maximum && /^[a-zA-Z0-9_.:@/-]+$/.test(value) ? value : undefined;
  const output: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: levels.has(event.level) ? event.level : 'error',
    event: token(event.event, 80) ?? 'invalid_log_event',
    service: services.has(event.service) ? event.service : 'vigilo-operation',
  };
  const strings: Array<keyof OperationalLogEvent> = ['requestId', 'entryPoint', 'workspaceId', 'repairRunId', 'jobType', 'jobId', 'operationCategory', 'providerId', 'failureCode'];
  for (const key of strings) {
    const value = token(event[key]);
    if (value !== undefined) output[key] = value;
  }
  if (typeof event.releaseSha === 'string' && /^[0-9a-f]{40}$/.test(event.releaseSha)) output.releaseSha = event.releaseSha;
  if (Number.isSafeInteger(event.attemptOrdinal) && Number(event.attemptOrdinal) >= 0) output.attemptOrdinal = event.attemptOrdinal;
  if (Number.isFinite(event.durationMs) && Number(event.durationMs) >= 0) output.durationMs = event.durationMs;
  sink(JSON.stringify(redactLogValue(output)));
}
