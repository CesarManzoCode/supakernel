import type { PortableType, SchemaIR } from '@supakernel/contracts'

const TS_TYPE: Record<PortableType, string> = {
  bool: 'boolean',
  int32: 'number',
  int64: 'string',
  float64: 'number',
  decimal: 'string',
  text: 'string',
  uuid: 'string',
  date: 'string',
  timestamp: 'string',
  timestamptz: 'string',
  json: 'Json',
  bytes: 'string',
  enum: 'string',
}

/**
 * Generate the `Database` TypeScript type from the deployed `SchemaIR` (contract §16,
 * `GET /v1/projects/:ref/types/typescript`). Deterministic — tables and columns in schema order.
 */
export function generateTypescriptTypes(schema: SchemaIR): string {
  const lines: string[] = []
  lines.push(
    'export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]',
  )
  lines.push('')
  lines.push('export interface Database {')
  lines.push('  public: {')
  lines.push('    Tables: {')
  for (const table of schema.tables) {
    lines.push(`      ${table.name}: {`)
    for (const shape of ['Row', 'Insert', 'Update'] as const) {
      lines.push(`        ${shape}: {`)
      for (const col of table.columns) {
        const base =
          col.type === 'enum' && col.enumLabels
            ? col.enumLabels.map((l) => JSON.stringify(l)).join(' | ')
            : TS_TYPE[col.type]
        const optional =
          shape === 'Update' ||
          (shape === 'Insert' && (col.nullable || col.default !== null || col.generated))
        const nullable = col.nullable ? ' | null' : ''
        lines.push(`          ${col.name}${optional ? '?' : ''}: ${base}${nullable}`)
      }
      lines.push('        }')
    }
    lines.push('      }')
  }
  lines.push('    }')
  lines.push('    Views: { [_ in never]: never }')
  lines.push('    Functions: { [_ in never]: never }')
  lines.push('    Enums: { [_ in never]: never }')
  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}
