/**
 * The link to a robot: transports that carry bytes, and the session that speaks the protocol
 * over them.
 *
 * It depends only on `src/protocol` and on no framework, so the application, the tools and the
 * tests all drive the same session.
 *
 * @module
 */

export { Backoff, DEFAULT_BACKOFF, type BackoffOptions } from './backoff';
export {
  BluetoothTransport,
  type BluetoothTransportOptions,
} from './bluetooth/bluetooth-transport';
export { GattWriteQueue, type ChunkWriter } from './bluetooth/gatt-write-queue';
export {
  DEFAULT_CHUNK_SIZE,
  HM19_UART,
  type BluetoothDeviceLike,
  type BluetoothLike,
  type GattCharacteristicLike,
  type GattServerLike,
  type GattServiceLike,
  type UartService,
} from './bluetooth/web-bluetooth';
export { DEFAULT_WRAP_SLACK_US, TimestampUnwrapper } from './clock';
export {
  CumulativeCredit,
  DEFAULT_CUMULATIVE,
  isMetered,
  wireSize,
  type CumulativeCreditOptions,
  type CreditGrant,
  type CreditPolicy,
} from './credit';
export { Emitter, type Listener, type Unsubscribe } from './emitter';
export { RobotError, SessionError, TimeoutError, type SessionErrorReason } from './errors';
export {
  EpochRegistry,
  OpenEpoch,
  planGroups,
  SAMPLE_HEADER_SIZE,
  sharedEpochIds,
  type Epoch,
  type EpochEndReason,
  type EpochIdSource,
  type EpochListener,
  type GroupLayout,
  type GroupRequest,
  type SampleValue,
} from './groups';
export {
  DEFAULT_LINK_BUDGET,
  LinkBudget,
  UART_BYTES_PER_SECOND,
  type BudgetEstimate,
  type LinkBudgetOptions,
} from './link-budget';
export type { CommandReply } from './messages';
export {
  MemorySchemaCache,
  SchemaAssembler,
  type PageOutcome,
  type SchemaCache,
  type SchemaEntry,
} from './schema';
export { Session, type SessionOptions } from './session';
export {
  MIN_DEGRADED_RATE_HZ,
  planStreams,
  type PlanInput,
  type PlannedRate,
  type RateRequest,
  type StreamPlan,
} from './stream-plan';
export {
  StreamPlanner,
  type PlannerSession,
  type StreamPlannerEvents,
  type StreamPlannerOptions,
} from './stream-planner';
export {
  DEFAULT_TIMING,
  type DroppedEvent,
  type EpochEndEvent,
  type GroupsResult,
  type HandshakeReason,
  type LinkStats,
  type LogEvent,
  type ProtocolErrorEvent,
  type ReadResult,
  type RobotInfo,
  type SampleEvent,
  type SchemaReady,
  type SessionEvents,
  type SessionState,
  type SessionTiming,
  type TimelineEvent,
  type ValueEvent,
  type WriteEvent,
  type WriteResult,
} from './session-types';
export { accessOf, valueTypeOf, variableOf } from './value-types';
export { BaseTransport, type CloseReason, type Transport, type TransportState } from './transport';
export {
  WebSocketTransport,
  type WebSocketFactory,
  type WebSocketLike,
  type WebSocketTransportOptions,
} from './websocket-transport';
