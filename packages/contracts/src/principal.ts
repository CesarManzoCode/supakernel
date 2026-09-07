import type { Json } from './json.js'

/**
 * The authenticated identity of a request. Every field is derived only from verified
 * credentials (contract §6.1, §6.4): a value controlled by the client never creates a claim.
 */
export interface Principal {
  readonly kind: 'anonymous' | 'user' | 'service'
  readonly subjectId: string | null
  readonly tenantId: string
  /** `anon` / `authenticated` / `service_role`, or a project-defined role name (contract §8). */
  readonly role: 'anon' | 'authenticated' | 'service_role' | string
  readonly sessionId: string | null
  readonly claims: Readonly<Record<string, Json>>
  readonly credentialSource: 'none' | 'jwt' | 'secret_key' | 'management_token'
}

/** `service_role` may bypass RLS only when the credential is a secret key (contract §9.2). */
export function isPrivilegedService(principal: Principal): boolean {
  return (
    principal.kind === 'service' &&
    principal.role === 'service_role' &&
    principal.credentialSource === 'secret_key'
  )
}

export function anonymousPrincipal(tenantId: string): Principal {
  return {
    kind: 'anonymous',
    subjectId: null,
    tenantId,
    role: 'anon',
    sessionId: null,
    claims: Object.freeze({}),
    credentialSource: 'none',
  }
}
