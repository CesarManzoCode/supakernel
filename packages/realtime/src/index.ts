// SupaKernel Realtime — postgres_changes subset (contract §15, §30 L8).
// Phoenix codec + connection state machine + outbox dispatcher. Transport-agnostic:
// nothing here imports a WebSocket implementation.

export {
  type ConnectionConfig,
  type OutboxEvent,
  type Outgoing,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_EVENTS,
  RealtimeConnection,
} from './connection.js'
export { type DispatcherOptions, OutboxDispatcher } from './dispatcher.js'
export { type ChangeFilter, matchesFilter, parseFilter } from './filter.js'
export {
  outboxSchemaStatements,
  outboxTable,
  outboxTriggerStatements,
} from './outbox.js'
export {
  decodeFrame,
  encodeFrame,
  PHX,
  type PhoenixFrame,
  reply,
  systemFrame,
} from './phoenix-codec.js'
