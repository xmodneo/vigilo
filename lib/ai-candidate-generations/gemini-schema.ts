const GEMINI_RESPONSE_SCHEMA_KEYWORDS = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description',
  'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum',
  'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function visit(value: unknown, keywords: Set<string>): void {
  const schema = record(value);
  if (!schema) return;
  for (const [key, child] of Object.entries(schema)) {
    keywords.add(key);
    if (key === 'properties' || key === '$defs') {
      const definitions = record(child);
      if (definitions) for (const definition of Object.values(definitions)) visit(definition, keywords);
    } else if (key === 'additionalProperties' || key === 'items') {
      visit(child, keywords);
    } else if (key === 'prefixItems' || key === 'anyOf' || key === 'oneOf') {
      if (Array.isArray(child)) for (const branch of child) visit(branch, keywords);
    }
  }
}

export function collectGeminiResponseSchemaKeywords(schema: unknown): string[] {
  const keywords = new Set<string>();
  visit(schema, keywords);
  return [...keywords].sort();
}

export function unsupportedGeminiResponseSchemaKeywords(schema: unknown): string[] {
  return collectGeminiResponseSchemaKeywords(schema).filter((keyword) => !GEMINI_RESPONSE_SCHEMA_KEYWORDS.has(keyword));
}
