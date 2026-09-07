/**
 * Branded identifier types. A brand is a compile-time-only tag: at runtime these are plain
 * strings, but the type system refuses to mix a `RequestId` with a `ProjectRef`.
 */
declare const brand: unique symbol

export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type RequestId = Brand<string, 'RequestId'>
export type ProjectRef = Brand<string, 'ProjectRef'>
export type TenantId = Brand<string, 'TenantId'>
export type SubjectId = Brand<string, 'SubjectId'>
export type SessionId = Brand<string, 'SessionId'>
export type PolicyId = Brand<string, 'PolicyId'>
export type OperationId = Brand<string, 'OperationId'>
export type ScenarioId = Brand<string, 'ScenarioId'>
export type Seed = Brand<string, 'Seed'>
export type Fingerprint = Brand<string, 'Fingerprint'>
export type SchemaHash = Brand<string, 'SchemaHash'>

export const asRequestId = (value: string): RequestId => value as RequestId
export const asProjectRef = (value: string): ProjectRef => value as ProjectRef
export const asTenantId = (value: string): TenantId => value as TenantId
export const asSubjectId = (value: string): SubjectId => value as SubjectId
export const asSessionId = (value: string): SessionId => value as SessionId
export const asPolicyId = (value: string): PolicyId => value as PolicyId
export const asOperationId = (value: string): OperationId => value as OperationId
export const asScenarioId = (value: string): ScenarioId => value as ScenarioId
export const asSeed = (value: string): Seed => value as Seed
export const asFingerprint = (value: string): Fingerprint => value as Fingerprint
export const asSchemaHash = (value: string): SchemaHash => value as SchemaHash

export type Family = 'postgres' | 'sqlite'
export type RuntimeId = 'node' | 'bun' | 'deno' | 'workers' | 'browser' | 'lambda'

export const FAMILIES: readonly Family[] = ['postgres', 'sqlite']
export const RUNTIME_IDS: readonly RuntimeId[] = [
  'node',
  'bun',
  'deno',
  'workers',
  'browser',
  'lambda',
]
