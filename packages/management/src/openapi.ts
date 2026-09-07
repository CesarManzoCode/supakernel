import type { Json } from '@supakernel/contracts'

/**
 * The SupaKernel `/_system` OpenAPI document (contract §16). It describes the Management subset
 * and the system endpoints — a separate document from the vendor `/v1` compatibility spec.
 * Deterministic: `scripts/generate-management-api.mts` runs `openapi-typescript` on this.
 */
export const MANAGEMENT_OPENAPI: Json = {
  openapi: '3.0.3',
  info: {
    title: 'SupaKernel Management API',
    version: '1.0.0',
    description:
      'Allowlisted Management subset (contract §16). Not the full Supabase Management API.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/v1/projects': {
      get: { summary: 'List projects', responses: { '200': ref('ProjectList') } },
    },
    '/v1/projects/{ref}': {
      get: {
        summary: 'Get a project',
        parameters: [pathParam('ref')],
        responses: { '200': ref('Project'), '404': { description: 'Not found' } },
      },
    },
    '/v1/projects/{ref}/api-keys': {
      get: {
        summary: 'List API keys (values redacted)',
        parameters: [pathParam('ref')],
        responses: { '200': ref('ApiKeyList') },
      },
    },
    '/v1/projects/{ref}/database/query': {
      post: {
        summary: 'Run a single SQL statement (disabled by default; loopback only)',
        parameters: [pathParam('ref')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string' },
                  parameters: { type: 'array', items: {} },
                  read_only: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Rows' },
          '400': { description: 'Rejected' },
          '403': { description: 'Disabled / not authorized' },
        },
      },
    },
    '/v1/projects/{ref}/database/migrations': {
      get: {
        summary: 'List migrations',
        parameters: [pathParam('ref')],
        responses: { '200': ref('MigrationList') },
      },
      post: {
        summary: 'Apply a migration',
        parameters: [pathParam('ref')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'query'],
                properties: { name: { type: 'string' }, query: { type: 'string' } },
              },
            },
          },
        },
        responses: { '201': { description: 'Applied' } },
      },
    },
    '/v1/projects/{ref}/types/typescript': {
      get: {
        summary: 'Generate TypeScript types from the deployed schema',
        parameters: [pathParam('ref')],
        responses: {
          '200': {
            description: 'TS source',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { types: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
    '/_system/health': { get: { summary: 'Health', responses: { '200': ref('Health') } } },
    '/_system/openapi': {
      get: { summary: 'This document', responses: { '200': { description: 'OpenAPI' } } },
    },
    '/.well-known/supakernel-capabilities': {
      get: { summary: 'Effective capability matrix', responses: { '200': ref('Capabilities') } },
    },
  },
  components: {
    schemas: {
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ref: { type: 'string' },
          name: { type: 'string' },
          region: { type: 'string' },
          status: { type: 'string' },
          database: {
            type: 'object',
            properties: { host: { type: 'string' }, version: { type: 'string' } },
          },
          created_at: { type: 'string' },
        },
      },
      ProjectList: { description: 'OK', content: jsonArrayOf('Project') },
      ApiKey: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          api_key: { type: 'string' },
          type: { type: 'string' },
        },
      },
      ApiKeyList: { description: 'OK', content: jsonArrayOf('ApiKey') },
      Migration: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          name: { type: 'string' },
          applied_at: { type: 'string' },
        },
      },
      MigrationList: { description: 'OK', content: jsonArrayOf('Migration') },
      Health: {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { healthy: { type: 'boolean' }, services: { type: 'object' } },
            },
          },
        },
      },
      Capabilities: {
        description: 'OK',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    },
  },
}

function ref(name: string): Json {
  return { $ref: `#/components/schemas/${name}` }
}
function pathParam(name: string): Json {
  return { name, in: 'path', required: true, schema: { type: 'string' } }
}
function jsonArrayOf(schema: string): Json {
  return {
    'application/json': {
      schema: { type: 'array', items: { $ref: `#/components/schemas/${schema}` } },
    },
  }
}
