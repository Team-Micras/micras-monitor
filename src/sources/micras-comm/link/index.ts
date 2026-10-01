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
} from '../transports/bluetooth/bluetooth-transport';
export { GattWriteQueue, type ChunkWriter } from '../transports/bluetooth/gatt-write-queue';
export {
  DEFAULT_CHUNK_SIZE,
  HM19_UART,
  type BluetoothDeviceLike,
  type BluetoothLike,
  type GattCharacteristicLike,
  type GattServerLike,
  type GattServiceLike,
  type UartService,
} from '../transports/bluetooth/bluetooth-types';
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
export { Emitter, type Listener, type Unsubscribe } from '@/core/emitter';
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
} from './epochs';
export {
  DEFAULT_LINK_BUDGET,
  LinkBudget,
  UART_BYTES_PER_SECOND,
  type BudgetEstimate,
  type LinkBudgetOptions,
} from '../streaming/bandwidth-estimator';
export type { CommandReply } from './messages';
export {
  MemorySchemaCache,
  SchemaAssembler,
  type PageOutcome,
  type SchemaCache,
  type SchemaEntry,
} from './schema';
export { Session, type SessionOptions } from './robot-link';
export {
  MIN_DEGRADED_RATE_HZ,
  planStreams,
  type PlanInput,
  type PlannedRate,
  type RateRequest,
  type StreamPlan,
} from '../streaming/fit-groups';
export {
  StreamPlanner,
  type PlannerSession,
  type StreamPlannerEvents,
  type StreamPlannerOptions,
} from '../streaming/stream-planner';
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
} from './link-events';
export { accessOf, valueTypeOf, variableOf } from '../value-types';
export {
  BaseTransport,
  type CloseReason,
  type Transport,
  type TransportState,
} from '../transports/transport';
export {
  TAKEN_OVER_CLOSE_CODE,
  TAKEN_OVER_REASON,
  WebSocketTransport,
  type WebSocketFactory,
  type WebSocketLike,
  type WebSocketTransportOptions,
} from '../transports/websocket-transport';
