/**
 * A session connected over a real WebSocket to a simulated robot on a free port, with everything
 * it emits recorded, for the tests that drive the two against each other.
 *
 * @module
 */

import {
  Session,
  WebSocketTransport,
  type Epoch,
  type GroupRequest,
  type HandshakeReason,
  type LogEvent,
  type ProtocolErrorEvent,
  type SampleEvent,
  type SchemaReady,
  type SessionOptions,
  type SessionState,
  type SessionTiming,
  type WriteEvent,
} from '../src/link';
import {
  startSimulatedRobot,
  type SimulatedRobot,
  type SimulatedRobotOptions,
} from './simulated-robot/server';

/** Timeouts short enough for a test over a local socket. */
export const TEST_TIMING: Partial<SessionTiming> = {
  helloTimeoutMs: 500,
  schemaTimeoutMs: 300,
  requestTimeoutMs: 300,
  pingIntervalMs: 200,
  silenceTimeoutMs: 1000,
  minStallMs: 500,
  statsIntervalMs: 200,
};

/** Everything a session emitted. */
export class Recording {
  readonly states: SessionState[] = [];
  readonly schemas: SchemaReady[] = [];
  readonly epochs: Epoch[] = [];
  readonly samples: SampleEvent[] = [];
  readonly dropped = new Map<number, number>();
  readonly writes: WriteEvent[] = [];
  readonly logs: LogEvent[] = [];
  readonly protocolErrors: ProtocolErrorEvent[] = [];

  constructor(session: Session) {
    session.on('state', (state) => this.states.push(state));
    session.on('schema', (schema) => this.schemas.push(schema));
    session.on('epoch', (epoch) => this.epochs.push(epoch));
    session.on('sample', (sample) => this.samples.push(sample));
    session.on('dropped', ({ epoch, count }) =>
      this.dropped.set(epoch, (this.dropped.get(epoch) ?? 0) + count)
    );
    session.on('write', (write) => this.writes.push(write));
    session.on('log', (log) => this.logs.push(log));
    session.on('protocolError', (error) => this.protocolErrors.push(error));
  }

  /** Why each handshake started, in order. */
  get handshakeReasons(): HandshakeReason[] {
    return this.states.flatMap((state) =>
      state.kind === 'handshaking' && state.attempt === 1 ? [state.reason] : []
    );
  }

  /** The samples of one epoch. */
  samplesOf(epoch: number): SampleEvent[] {
    return this.samples.filter((sample) => sample.epoch === epoch);
  }

  /** Samples dropped over every epoch. */
  get totalDropped(): number {
    return [...this.dropped.values()].reduce((total, count) => total + count, 0);
  }
}

/** A session talking to a simulated robot of its own. */
export interface Harness {
  readonly robot: SimulatedRobot;
  readonly session: Session;
  readonly recording: Recording;

  /** The id of a variable of the robot, by name. */
  readonly id: (name: string) => number;

  /** Close the session and stop the robot. */
  readonly close: () => Promise<void>;
}

/**
 * Start a robot, connect a session to it and wait until the session is ready.
 *
 * @param faults What to do to the link.
 * @param options How to build the session; the test timing by default.
 */
export async function connect(
  faults: Partial<SimulatedRobotOptions> = {},
  options: SessionOptions = {}
): Promise<Harness> {
  const robot = await startSimulatedRobot({ ...faults, port: 0 });
  const session = new Session(new WebSocketTransport(`ws://127.0.0.1:${robot.port}`), {
    timing: TEST_TIMING,
    ...options,
  });
  const recording = new Recording(session);

  session.open();
  await waitFor(() => session.state.kind === 'streaming', 5000, 'the session to stream');

  return {
    robot,
    session,
    recording,
    id: (name) => variableId(session, name),
    close: async () => {
      session.close();
      await robot.close();
    },
  };
}

function variableId(session: Session, name: string): number {
  const entry = session.schema?.find((candidate) => candidate.name === name);

  if (!entry) {
    throw new Error(`No variable named ${name}`);
  }

  return entry.id;
}

/**
 * Wait until a condition holds.
 *
 * @param condition Checked every 10 ms.
 * @param timeoutMs How long to wait before failing.
 * @param what What is being waited for, for the failure message.
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  what = 'a condition'
): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }

    await delay(10);
  }
}

/**
 * Apply a layout and return its epochs, failing if a later layout superseded it.
 *
 * @param session The session to apply it on.
 * @param requests One request per group.
 */
export async function applyGroups(
  session: Session,
  requests: readonly GroupRequest[]
): Promise<readonly Epoch[]> {
  const result = await session.setGroups(requests);

  if (result.status !== 'applied') {
    throw new Error('The layout was superseded');
  }

  return result.epochs;
}

/** Let time pass. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
