/**
 * What the micras-comm source and the scripts use of the robot link, in one place: the transports
 * that carry bytes, the {@link RobotLink} that speaks `micras_comm` over them, and the stream
 * planner that fits its groups.
 *
 * None of it depends on more than `wire/`, the rest of this source and `src/core`, nor on any
 * framework, so the source, the scripts and the tests all drive the same link.
 *
 * @module
 */

export {
  BandwidthEstimator,
  DEFAULT_BANDWIDTH_ESTIMATOR,
  UART_BYTES_PER_SECOND,
  type BandwidthEstimatorOptions,
  type BudgetEstimate,
} from '../streaming/bandwidth-estimator';
export {
  fitGroups,
  MIN_DEGRADED_RATE_HZ,
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
  BluetoothTransport,
  type BluetoothTransportOptions,
} from '../transports/bluetooth/bluetooth-transport';
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
export { GattWriteQueue, type ChunkWriter } from '../transports/bluetooth/gatt-write-queue';
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
export { accessOf, valueTypeOf, variableOf } from '../value-types';
export { Backoff, DEFAULT_BACKOFF, type BackoffOptions } from './retry';
export { DEFAULT_WRAP_SLACK_US, TimestampUnwrapper } from './clock';
export {
  CreditLedger,
  DEFAULT_CREDIT_LEDGER,
  type CreditGrant,
  type CreditLedgerOptions,
} from './credit';
export {
  EpochRegistry,
  OpenEpoch,
  sharedEpochIds,
  type Epoch,
  type EpochEndReason,
  type EpochIdSource,
  type EpochListener,
  type SampleValue,
} from './epochs';
export { LinkError, RobotError, TimeoutError, type LinkErrorReason } from './errors';
export {
  DEFAULT_TIMING,
  type DroppedEvent,
  type EpochEndEvent,
  type GroupsResult,
  type HandshakeReason,
  type LinkCounters,
  type LinkEvents,
  type LinkState,
  type LinkTiming,
  type LogEvent,
  type ProtocolErrorEvent,
  type ReadResult,
  type RobotInfo,
  type SampleEvent,
  type SchemaReady,
  type TimelineEvent,
  type ValueEvent,
  type WriteEvent,
  type WriteResult,
} from './link-events';
export type { CommandReply } from './messages';
export { RobotLink, type RobotLinkOptions } from './robot-link';
export type { GroupRequest } from './group-configurator';
export {
  MemorySchemaCache,
  SchemaAssembler,
  type PageOutcome,
  type SchemaCache,
  type SchemaEntry,
} from './schema';
export { Emitter, type Listener, type Unsubscribe } from '@/core/emitter';
