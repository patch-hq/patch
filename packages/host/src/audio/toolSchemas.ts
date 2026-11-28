// A tool's JSON Schema in each voice provider's own dialect. The tools' own
// schemas (an MCP server's, or built here) are the one source; each provider
// takes the part of JSON Schema it understands.

import type { ToolSchema } from './voiceAgent.js';

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first non-null type of a `type` that may be a list, and whether null was allowed. */
function typeOf(schema: Json): { type: string | undefined; nullable: boolean } {
  const t = schema['type'];
  if (Array.isArray(t)) {
    const real = t.filter((x): x is string => typeof x === 'string' && x !== 'null');
    return { type: real[0], nullable: t.includes('null') };
  }
  return { type: typeof t === 'string' ? t : undefined, nullable: false };
}

/** Gemini's schema subset: upper-case types, no `$schema`, `additionalProperties` or unions. */
export function geminiSchema(schema: ToolSchema): Json {
  const { type, nullable } = typeOf(schema);
  const out: Json = {};
  if (type) out['type'] = type.toUpperCase();
  if (nullable) out['nullable'] = true;
  if (typeof schema['description'] === 'string') out['description'] = schema['description'];
  if (Array.isArray(schema['enum'])) out['enum'] = schema['enum'].map(String);
  if (isRecord(schema['properties'])) {
    out['properties'] = Object.fromEntries(
      Object.entries(schema['properties']).map(([k, v]) => [k, isRecord(v) ? geminiSchema(v) : {}]),
    );
  }
  if (Array.isArray(schema['required']) && schema['required'].length > 0)
    out['required'] = schema['required'];
  if (isRecord(schema['items'])) out['items'] = geminiSchema(schema['items']);
  for (const k of ['minimum', 'maximum', 'format'] as const)
    if (schema[k] !== undefined && (k !== 'format' || type === 'string')) out[k] = schema[k];
  return out;
}

/** OpenAI Realtime takes JSON Schema as it is. */
export function openaiSchema(schema: ToolSchema): Json {
  const { $schema: _unused, ...rest } = schema as Json;
  return rest;
}

/**
 * ElevenLabs' client-tool parameters: every property must say what it is, so
 * a property with no description is described by its name.
 */
export function elevenSchema(schema: ToolSchema): Json {
  const props = isRecord(schema['properties']) ? schema['properties'] : {};
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(props).map(([k, v]) => {
        const p = isRecord(v) ? { ...v } : {};
        delete p['$schema'];
        if (typeof p['description'] !== 'string' || p['description'] === '') p['description'] = k;
        return [k, p];
      }),
    ),
    required: Array.isArray(schema['required']) ? schema['required'] : [],
  };
}
