/**
 * The link to a robot: transports that carry bytes, the {@link RobotLink} that speaks the protocol
 * over them, and the stream planner that fits its groups.
 *
 * It depends only on `wire/`, `src/core` and no framework, so the source, the scripts and the
 * tests all drive the same link.
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
  CreditLedger,
  DEFAULT_CUMULATIVE,
  isMetered,
  wireSize,
  type CumulativeCreditOptions,
  type CreditGrant,
  type CreditPolicy,
} from './credit';
export { Emitter, type Listener, type Unsubscribe } from '@/core/emitter';
export { RobotError, LinkError, TimeoutError, type LinkErrorReason } from './errors';
export {
  EpochRegistry,
  OpenEpoch,
  toGroupLayouts,
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
  DEFAULT_BANDWIDTH_ESTIMATOR,
  BandwidthEstimator,
  UART_BYTES_PER_SECOND,
  type BudgetEstimate,
  type BandwidthEstimatorOptions,
} from '../streaming/bandwidth-estimator';
export type { CommandReply } from './messages';
export {
  MemorySchemaCache,
  SchemaAssembler,
  type PageOutcome,
  type SchemaCache,
  type SchemaEntry,
} from './schema';
export { RobotLink, type RobotLinkOptions } from './robot-link';
export {
  MIN_DEGRADED_RATE_HZ,
  fitGroups,
  type PlanInput,
  type PlannedRate,
  type RateRequest,
  type StreamPlan,
} from '../streaming/fit-groups';
export {
  StreamPlanner,
  type PlannerLink,
  type StreamPlannerEvents,
  type StreamPlannerOptions,
} from '../streaming/stream-planner';
export {
  DEFAULT_TIMING,
  type DroppedEvent,
  type EpochEndEvent,
  type GroupsResult,
  type HandshakeReason,
  type LinkCounters,
  type LogEvent,
  type ProtocolErrorEvent,
  type ReadResult,
  type RobotInfo,
  type SampleEvent,
  type SchemaReady,
  type LinkEvents,
  type LinkState,
  type LinkTiming,
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
