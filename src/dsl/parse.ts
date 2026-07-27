import { load, dump } from 'js-yaml';
import { GestureSchema, type GestureDef } from './schema.js';

export function parseGesture(yamlText: string): GestureDef {
  const raw: unknown = load(yamlText);
  const result = GestureSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    const name = (raw as { name?: unknown } | null)?.name;
    throw new Error(`invalid gesture definition${name ? ` '${String(name)}'` : ''}:\n${detail}`);
  }
  return result.data;
}

// Deterministic serialization: no YAML anchors and no undefined keys, so a
// round-trip is byte-identical and diffs stay readable.
export function serializeGesture(def: GestureDef): string {
  return dump(stripUndefined(def), { noRefs: true, lineWidth: 100, sortKeys: false });
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}
