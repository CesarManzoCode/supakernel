import { createHash } from 'node:crypto'
import { canonicalJson, type Json, type PortableType, type SchemaIR } from '@supakernel/contracts'

const OPENAPI_TYPE: Record<PortableType, { type: string; format?: string }> = {
  bool: { type: 'boolean' },
  int32: { type: 'integer', format: 'int32' },
  int64: { type: 'string', format: 'int64' },
  float64: { type: 'number', format: 'double' },
  decimal: { type: 'string', format: 'decimal' },
  text: { type: 'string' },
  uuid: { type: 'string', format: 'uuid' },
  date: { type: 'string', format: 'date' },
  timestamp: { type: 'string', format: 'date-time' },
  timestamptz: { type: 'string', format: 'date-time' },
  json: { type: 'object' },
  bytes: { type: 'string', format: 'byte' },
  enum: { type: 'string' },
}

/**
 * Generate the OpenAPI document for `GET /rest/v1/` from the *deployed* `SchemaIR`
 * (contract §11.1) — never a mock. The `ETag` is a hash of the schema so a client can cache it.
 */
export function generateOpenApi(schema: SchemaIR): { document: Json; etag: string } {
  const schemas: Record<string, Json> = {}
  const paths: Record<string, Json> = {}

  for (const table of schema.tables) {
    const properties: Record<string, Json> = {}
    const required: string[] = []
    for (const col of table.columns) {
      const base = OPENAPI_TYPE[col.type]
      const prop: Record<string, Json> = { ...base }
      if (col.type === 'enum' && col.enumLabels) prop.enum = [...col.enumLabels]
      properties[col.name] = col.nullable ? { ...prop, nullable: true } : prop
      if (!col.nullable && col.default === null && !col.generated) required.push(col.name)
    }
    schemas[table.name] = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    }

    const ref = { $ref: `#/components/schemas/${table.name}` }
    paths[`/${table.name}`] = {
      get: {
        tags: [table.name],
        parameters: [
          { name: 'select', in: 'query', schema: { type: 'string' } },
          { name: 'order', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'array', items: ref } } },
          },
        },
      },
      post: {
        tags: [table.name],
        requestBody: {
          content: {
            'application/json': { schema: { oneOf: [ref, { type: 'array', items: ref }] } },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
      patch: {
        tags: [table.name],
        requestBody: { content: { 'application/json': { schema: ref } } },
        responses: { '200': { description: 'OK' }, '204': { description: 'No Content' } },
      },
      delete: {
        tags: [table.name],
        responses: { '200': { description: 'OK' }, '204': { description: 'No Content' } },
      },
    }
  }

  const document: Json = {
    openapi: '3.0.3',
    info: {
      title: 'SupaKernel Data',
      version: '1.0.0',
      description: 'PostgREST-compatible subset (contract §11)',
    },
    servers: [{ url: '/rest/v1' }],
    paths,
    components: { schemas },
  }
  const etag = `"${createHash('sha256').update(canonicalJson(document)).digest('hex').slice(0, 32)}"`
  return { document, etag }
}
