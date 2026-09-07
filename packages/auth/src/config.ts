import type { ClockPort, MailPort, RandomPort } from '@supakernel/ports'

export interface AuthConfig {
  readonly projectRef: string
  readonly issuer: string
  readonly audience: string
  readonly accessTokenTtlSeconds: number
  readonly refreshGraceSeconds: number
  readonly autoConfirm: boolean
  readonly serverSecret: string
  readonly minPasswordLength: number
}

export const DEFAULT_AUTH_CONFIG: Omit<AuthConfig, 'projectRef' | 'issuer' | 'serverSecret'> = {
  audience: 'authenticated',
  accessTokenTtlSeconds: 3600,
  refreshGraceSeconds: 10,
  autoConfirm: true,
  minPasswordLength: 6,
}

export interface AuthPorts {
  readonly clock: ClockPort
  readonly random: RandomPort
  readonly mail: MailPort
}
