// SupaKernel Auth — GoTrue-compatible subset (contract §12, §30 L6).
// Portable auth.* state, PBKDF2/ES256 crypto (src/crypto/*), refresh rotation.

export { type ApiKeyPair, mintApiKeys, type ResolvedApiKey, resolveApiKey } from './apikeys.js'
export { type AuthConfig, type AuthPorts, DEFAULT_AUTH_CONFIG } from './config.js'
export {
  createWebCryptoPort,
  generateSigningKey,
  hashPassword,
  hmacSha256,
  JwtKeyring,
  needsRehash,
  SIGNING_ALG,
  type SigningKeyPair,
  sha256,
  timingSafeEqual,
  verifyPassword,
} from './crypto/index.js'
export { AuthDb } from './db.js'
export { AUTH_ERRORS, AuthError, type AuthErrorBody, authErrorBody } from './errors.js'
export { DEFAULT_RATE_LIMITS, RateLimiter } from './ratelimit.js'
export { createAuthHandler } from './routes.js'
export { AUTH_TABLES, authSchemaStatements, authTable } from './schema.js'
export {
  AuthService,
  type AuthSession,
  type AuthUser,
  type CreateAuthServiceOptions,
  canonicalEmail,
} from './service.js'
export {
  type IssuedTokens,
  issueSession,
  revokeSessions,
  rotateRefresh,
  sessionActive,
} from './session.js'
export { seededRandom, systemClock, webRandom } from './system.js'
export { hashToken, randomToken } from './tokens.js'
