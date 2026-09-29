/**
 * The sessions of the app: recording the live one, the saved ones, recovering a recording a
 * dead tab left behind, and opening a saved one to look at.
 *
 * The live session is the live store, always in memory, fed by the link. REC writes it to a
 * session file, the whole of it first and then as it grows, every 5 s at least; stopping ends
 * the file, and reset forgets the live history. A saved session opens read only, into a store of
 * its own that loads its blocks back from the file; the link and the live store carry on
 * underneath, and REC keeps recording, until the app goes back to live.
 *
 * @module
 */

import { decodeAccess } from '@/protocol';
import {
  decodeRecordingHeader,
  encodeRecordingHeader,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  SavedRecording,
  SessionRecorder,
  TelemetryStore,
  type RecorderStats,
  type RecordingBlocks,
  type RecordingFile,
  type RecordingHeader,
  type RecordingSummary,
  type RecordingVariable,
  type Scheduler,
  type TelemetryEvent,
} from '@/telemetry';

import type { RobotVariable } from '../ports';
import {
  sessionId,
  type SessionInfo,
  type SessionLibrary,
  type SessionLocks,
  type SessionRecovery,
  type StorageEstimate,
} from './session-library';

/** What a recording's header says of the robot, taken when REC starts. */
export interface RobotDescription {
  /** The robot's name, if it said it. */
  readonly name: string | null;
  /** Whatever else the link knows of it. */
  readonly robot: RecordingHeader['robot'];
  /** Its schema. */
  readonly schema: readonly RecordingVariable[];
}

/** How to set up the sessions. */
export interface SessionManagerOptions {
  /** The live store, which REC records. */
  readonly store: TelemetryStore;
  readonly library: SessionLibrary;
  readonly locks: SessionLocks;
  /** The robot as it is now, for the header of a new recording. */
  readonly describe: () => RobotDescription;
  /** When the stores of opened sessions tell their readers about changes. */
  readonly scheduler: Scheduler;
  /**
   * The memory cap of an opened session's store. By default it shares the live store's cap: it
   * gets what the live history leaves of it when it opens, and never less than an eighth of it.
   */
  readonly viewCapBytes?: number;
  /** Wall time in milliseconds; `Date.now` by default. */
  readonly now?: () => number;
  /** A monotonic clock in milliseconds, for timings; `performance.now` by default. */
  readonly clock?: () => number;
}

/** The recording under way. */
export interface LiveRecording {
  readonly session: SessionInfo;
  /** When it started, in `Date.now()` milliseconds. */
  readonly startedAtMs: number;
  readonly stats: RecorderStats;
}

/** A saved session opened to look at. */
export interface OpenedSession {
  readonly session: SessionInfo;
  /** Its samples, read only. */
  readonly store: TelemetryStore;
  /** Its variables, as the schema port gives them. */
  readonly variables: readonly RobotVariable[];
  /** The robot it was recorded from, if it said its name. */
  readonly robot: string | null;
  /** What its file held. */
  readonly summary: RecordingSummary;
  /** Where its blocks are read back from when they left memory. */
  readonly blocks: RecordingBlocks;
  /** How long reading and loading it took. */
  readonly loadMs: number;
}

/** What the memory cap did to the live history, for the user to hear about. */
export type MemoryNotice =
  | { readonly kind: 'warning'; readonly usedBytes: number; readonly capBytes: number }
  | { readonly kind: 'dropped'; readonly untilUs: number; readonly capBytes: number }
  | { readonly kind: 'stopped'; readonly capBytes: number };

/** A recording cut short that the last start recovered. */
export interface RecoveredSession {
  readonly session: SessionInfo;
  readonly recovery: SessionRecovery;
}

/** Everything the sessions UI shows. */
export interface SessionsState {
  /** Whether the saved sessions were listed and any recording cut short recovered. */
  readonly ready: boolean;
  /** Where sessions are kept. */
  readonly backend: SessionLibrary['kind'];
  /** Every saved session, newest first. */
  readonly sessions: readonly SessionInfo[];
  readonly recording: LiveRecording | null;
  /**
   * The sessions whose files the live store reads blocks back from, until it is reset; they
   * cannot be deleted before.
   */
  readonly liveSources: readonly string[];
  readonly viewing: OpenedSession | null;
  /** The session being opened, while it loads. */
  readonly opening: string | null;
  /** Recordings cut short that were recovered, until dismissed. */
  readonly recovered: readonly RecoveredSession[];
  /** The last thing that went wrong, until the next action. */
  readonly error: string | null;
  /** What the memory cap last did to the live history, until dismissed or it resumes. */
  readonly memory: MemoryNotice | null;
  readonly storage: StorageEstimate | null;
}

/** A session file ready to download. */
export interface ExportedSession {
  readonly fileName: string;
  readonly blob: Blob;
}

/** The file extension of the recording format. */
export const RECORDING_EXTENSION = '.mmrec';

/** The media type of an exported recording. */
export const RECORDING_MEDIA_TYPE = 'application/vnd.micras-monitor.recording';

interface ActiveRecording {
  readonly session: SessionInfo;
  readonly startedAtMs: number;
  readonly recorder: SessionRecorder;
  readonly release: () => void;
  readonly unsubscribe: () => void;
  readonly timer: ReturnType<typeof setInterval>;
}

/** An opened session gets at least this fraction of the live store's cap: an eighth. */
const VIEW_CAP_FLOOR = 8;

/** How often the recording checks whether the blocks being filled are due to be written. */
const FLUSH_CHECK_MS = 1000;

interface Source {
  readonly id: string;
  readonly file: RecordingFile;
}

interface Viewed {
  readonly opened: OpenedSession;
  readonly file: RecordingFile;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeAccess(variable: RobotVariable): number {
  const { access } = variable;
  return (
    (access.stream ? 1 : 0) |
    (access.write ? 2 : 0) |
    (access.idle ? 4 : 0) |
    (access.persist ? 8 : 0)
  );
}

/** The schema of the robot variables, as a recording's header keeps it. */
export function recordedSchema(variables: readonly RobotVariable[]): RecordingVariable[] {
  return variables.map((variable) => ({
    id: variable.id,
    name: variable.name,
    type: variable.type,
    access: encodeAccess(variable),
    ...(variable.typeTag === null ? {} : { typeTag: variable.typeTag }),
  }));
}

/** The robot variables of a recording's schema, for the schema port of an opened session. */
export function schemaVariables(schema: readonly RecordingVariable[]): RobotVariable[] {
  return schema.map((variable) => ({
    id: variable.id,
    name: variable.name,
    type: variable.type,
    access: decodeAccess(variable.access ?? 0),
    typeTag: variable.typeTag ?? null,
  }));
}

/** The name a session gets when it starts: the robot and the local date and time. */
export function defaultSessionName(robot: string | null, atMs: number): string {
  const when = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(atMs);
  return `${robot ?? 'Session'} · ${when}`;
}

/** A file name for a session's name, without characters file systems refuse. */
export function exportFileName(name: string): string {
  const safe = name
    .normalize('NFKD')
    .replaceAll(/[^\w.-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .toLowerCase();
  return (safe === '' ? 'session' : safe) + RECORDING_EXTENSION;
}

function pick(event: { readonly usedBytes: number; readonly capBytes: number }) {
  return { usedBytes: event.usedBytes, capBytes: event.capBytes };
}

function describedBy(
  header: RecordingHeader
): Partial<Pick<SessionInfo, 'name' | 'robot' | 'createdAtMs'>> {
  const robot = typeof header.robot.name === 'string' ? header.robot.name : null;
  return {
    name: header.name ?? defaultSessionName(robot, header.startedAtMs),
    robot,
    createdAtMs: header.startedAtMs,
  };
}

function spanOf(summary: RecordingSummary): number {
  return summary.range ? summary.range.endUs - summary.range.startUs : 0;
}

/** Records, recovers, lists and opens sessions, and tells the UI about each change. */
export class SessionManager {
  readonly #options: SessionManagerOptions;
  readonly #now: () => number;
  readonly #clock: () => number;
  readonly #listeners = new Set<() => void>();
  #state: SessionsState;
  #recording: ActiveRecording | null = null;
  #sources: Source[] = [];
  #viewed: Viewed | null = null;
  #askedToPersist = false;
  #openRequest = 0;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#clock = options.clock ?? (() => performance.now());
    this.#state = {
      ready: false,
      backend: options.library.kind,
      sessions: [],
      recording: null,
      liveSources: [],
      viewing: null,
      opening: null,
      recovered: [],
      error: null,
      memory: null,
      storage: null,
    };
    options.store.onEvent((event) => this.#onStoreEvent(event));
  }

  /** The live store, which REC records. */
  get live(): TelemetryStore {
    return this.#options.store;
  }

  /** The state; the same object until it changes. */
  get state(): SessionsState {
    return this.#state;
  }

  /** Calls `listener` after the state changes; returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * List the saved sessions, recovering first each recording cut short: one left `recording`
   * whose lock no tab holds. Its damaged tail is cut from the file and reported.
   */
  async start(): Promise<void> {
    try {
      const sessions = await this.#options.library.list();
      const unfinished = sessions.filter((session) => session.state === 'recording');
      const results = await Promise.allSettled(
        unfinished.map(async (session) =>
          (await this.#options.locks.held(session.id)) ? null : this.#recover(session)
        )
      );
      const recovered = results.flatMap((result) =>
        result.status === 'fulfilled' && result.value !== null ? [result.value] : []
      );
      this.#set({ recovered: [...this.#state.recovered, ...recovered] });
    } catch (error) {
      this.#set({ error: messageOf(error) });
    }

    try {
      await this.refresh();
    } catch (error) {
      this.#set({ error: messageOf(error) });
    } finally {
      this.#set({ ready: true });
    }
  }

  /** List the sessions and the storage estimate again. */
  async refresh(): Promise<void> {
    const [sessions, storage] = await Promise.all([
      this.#options.library.list(),
      this.#options.library.estimate().catch(() => null),
    ]);
    this.#set({ sessions, storage });
  }

  /**
   * Start recording the live session into a new session: the whole of it so far, then as it
   * grows. The first recording asks the browser to keep the origin's data.
   */
  async startRecording(): Promise<void> {
    if (this.#recording) {
      return;
    }

    const { library, locks, store } = this.#options;
    const description = this.#options.describe();
    const startedAtMs = this.#now();
    let release: (() => void) | undefined;
    this.#set({ error: null });

    try {
      if (!this.#askedToPersist) {
        this.#askedToPersist = true;
        await library.persist().catch(() => false);
      }

      const id = sessionId(startedAtMs);
      const held = await locks.hold(id);
      release = held;
      const { info, file } = await library.create({
        id,
        name: defaultSessionName(description.name, startedAtMs),
        robot: description.name,
        createdAtMs: startedAtMs,
        state: 'recording',
        bytes: 0,
        samples: 0,
        durationUs: 0,
      });
      const header: RecordingHeader = {
        format: RECORDING_FORMAT,
        version: RECORDING_FORMAT_VERSION,
        startedAtMs,
        robot: description.robot,
        schema: description.schema,
        name: info.name,
      };
      const recorder = await SessionRecorder.start(file, header, store, (error) =>
        this.#set({ error: `Recording could not write: ${messageOf(error)}` })
      );
      this.#sources = [...this.#sources, { id: info.id, file }];
      const unsubscribe = recorder.subscribe(() => this.#publishRecording());
      const timer = setInterval(() => store.flushIfDue(), FLUSH_CHECK_MS);
      this.#recording = { session: info, startedAtMs, recorder, release: held, unsubscribe, timer };
      release = undefined;
      this.#publishRecording();
      this.#set({ liveSources: this.#sources.map((source) => source.id) });
      await this.refresh();
    } catch (error) {
      release?.();
      this.#set({ error: `Recording could not start: ${messageOf(error)}` });
    }
  }

  /**
   * End the recording: write what is being filled, and mark the session saved. If marking it
   * fails, as when the disk is full, the session keeps its lock and stays marked as recording, so
   * no other tab takes it as cut short while this one lives, and the next start recovers it.
   */
  async stopRecording(): Promise<void> {
    const active = this.#recording;

    if (!active) {
      return;
    }

    this.#recording = null;
    clearInterval(active.timer);

    try {
      await active.recorder.stop(this.#options.store);
      const range = this.#options.store.timeRange();
      const stats = active.recorder.status;
      await this.#options.library.update(active.session.id, {
        state: 'saved',
        bytes: stats.bytes,
        samples: stats.samples,
        durationUs: range ? range.endUs - range.startUs : 0,
      });
      active.release();
    } catch (error) {
      this.#set({ error: `Recording did not end cleanly: ${messageOf(error)}` });
    } finally {
      active.unsubscribe();
      this.#set({ recording: null });
      await this.refresh().catch(() => undefined);
    }
  }

  /**
   * Forget the live history, ending the recording first if there is one. Saved sessions stay.
   */
  async resetLive(): Promise<void> {
    await this.stopRecording();
    this.#options.store.reset();
    const sources = this.#sources;
    this.#sources = [];
    this.#set({ liveSources: [] });
    await Promise.all(sources.map((source) => source.file.close().catch(() => undefined)));
  }

  /**
   * Open a saved session to look at, in place of the live one. Opening the session being
   * recorded shows it as far as it was written.
   */
  async open(id: string): Promise<void> {
    const session = this.#state.sessions.find((candidate) => candidate.id === id);

    if (!session) {
      this.#set({ error: 'That session no longer exists' });
      return;
    }

    const request = ++this.#openRequest;
    this.#set({ opening: id, error: null });
    const started = this.#clock();
    let file: RecordingFile | undefined;

    try {
      file = await this.#options.library.open(id);
      const saved = await SavedRecording.read(file);
      const store = new TelemetryStore({
        scheduler: this.#options.scheduler,
        memoryCapBytes: this.#options.viewCapBytes ?? this.#sharedCap(),
      });
      saved.loadInto(store);

      if (request !== this.#openRequest) {
        await file.close();
        return;
      }

      await this.#closeViewed();
      this.#set({ recovered: this.#state.recovered.filter((entry) => entry.session.id !== id) });
      const header = saved.summary.header;
      const robot = typeof header.robot.name === 'string' ? header.robot.name : session.robot;
      this.#viewed = {
        file,
        opened: {
          session,
          store,
          variables: schemaVariables(saved.summary.schema),
          robot,
          summary: saved.summary,
          blocks: saved.blocks,
          loadMs: this.#clock() - started,
        },
      };
      this.#set({ viewing: this.#viewed.opened, opening: null });
    } catch (error) {
      await file?.close().catch(() => undefined);

      if (request === this.#openRequest) {
        this.#set({ opening: null, error: `Could not open the session: ${messageOf(error)}` });
      }
    }
  }

  /** Go back to the live session. */
  async backToLive(): Promise<void> {
    this.#openRequest++;
    await this.#closeViewed();
    this.#set({ viewing: null, opening: null });
  }

  /** Rename a session. */
  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim();

    if (trimmed === '') {
      return;
    }

    try {
      const info = await this.#options.library.update(id, { name: trimmed });
      const recording = this.#recording;

      if (recording?.session.id === id) {
        this.#recording = { ...recording, session: info };
        this.#publishRecording();
      }

      const viewing = this.#viewed;

      if (viewing?.opened.session.id === id) {
        this.#viewed = { ...viewing, opened: { ...viewing.opened, session: info } };
        this.#set({ viewing: this.#viewed.opened });
      }

      await this.refresh();
    } catch (error) {
      this.#set({ error: `Could not rename the session: ${messageOf(error)}` });
    }
  }

  /**
   * Delete a session. The one being recorded, and those the live store still reads from, stay
   * until the recording ends and the live session is reset; the one on screen closes first.
   */
  async remove(id: string): Promise<void> {
    if (this.#sources.some((source) => source.id === id)) {
      this.#set({ error: 'The live session still uses that recording: reset it first' });
      return;
    }

    try {
      if (this.#viewed?.opened.session.id === id) {
        await this.backToLive();
      }

      await this.#options.library.remove(id);
      this.#set({
        recovered: this.#state.recovered.filter((entry) => entry.session.id !== id),
      });
      await this.refresh();
    } catch (error) {
      this.#set({ error: `Could not delete the session: ${messageOf(error)}` });
    }
  }

  /**
   * A session's file to download, in the recording format, with its current name in the header.
   * The session being recorded is exported as far as it was written.
   */
  async exportSession(id: string): Promise<ExportedSession | null> {
    const session = this.#state.sessions.find((candidate) => candidate.id === id);

    if (!session) {
      return null;
    }

    const file = await this.#options.library.open(id);

    try {
      const bytes = await file.read(0, await file.size());
      const { header, end } = decodeRecordingHeader(bytes);
      const head = encodeRecordingHeader({ ...header, name: session.name });
      const whole = new Uint8Array(head.byteLength + bytes.byteLength - end);
      whole.set(head);
      whole.set(bytes.subarray(end), head.byteLength);
      return {
        fileName: exportFileName(session.name),
        blob: new Blob([whole], { type: RECORDING_MEDIA_TYPE }),
      };
    } catch (error) {
      this.#set({ error: `Could not export the session: ${messageOf(error)}` });
      return null;
    } finally {
      await file.close();
    }
  }

  /** Stop showing the recovered recordings. */
  dismissRecovered(): void {
    this.#set({ recovered: [] });
  }

  /** Stop showing the last error. */
  dismissError(): void {
    this.#set({ error: null });
  }

  /** Stop showing what the memory cap did. */
  dismissMemory(): void {
    this.#set({ memory: null });
  }

  #onStoreEvent(event: TelemetryEvent): void {
    switch (event.type) {
      case 'memory-warning':
        this.#set({ memory: { kind: 'warning', ...pick(event) } });
        return;
      case 'history-dropped':
        if (this.#state.memory?.kind !== 'dropped' || this.#state.memory.untilUs < event.untilUs) {
          this.#set({
            memory: { kind: 'dropped', untilUs: event.untilUs, capBytes: event.capBytes },
          });
        }

        return;
      case 'history-stopped':
        this.#set({ memory: { kind: 'stopped', capBytes: event.capBytes } });
        return;
      case 'history-resumed':
        if (this.#state.memory?.kind === 'stopped') {
          this.#set({ memory: null });
        }

        return;
      default:
        return;
    }
  }

  async #recover(session: SessionInfo): Promise<RecoveredSession | null> {
    const { library } = this.#options;
    let file: RecordingFile | undefined;

    try {
      file = await library.open(session.id);
      const size = await file.size();

      if (size === 0) {
        await file.close();
        await library.remove(session.id);
        return null;
      }

      const saved = await SavedRecording.read(file);
      const { summary } = saved;

      if (summary.validEnd < size) {
        await file.truncate(summary.validEnd);
      }

      const recovery: SessionRecovery = {
        recoveredAtMs: this.#now(),
        truncatedBytes: size - summary.validEnd,
        damagedRecords: summary.damaged.length,
      };
      const info = await library.update(session.id, {
        state: 'saved',
        bytes: summary.validEnd,
        samples: summary.samples,
        durationUs: spanOf(summary),
        recovery,
        ...(session.name === session.id ? describedBy(summary.header) : {}),
      });
      return { session: info, recovery };
    } catch (error) {
      this.#set({ error: `Could not recover ${session.name}: ${messageOf(error)}` });
      return null;
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  #sharedCap(): number {
    const { usedBytes, capBytes } = this.#options.store.status();
    return Math.max(capBytes / VIEW_CAP_FLOOR, capBytes - usedBytes);
  }

  async #closeViewed(): Promise<void> {
    const viewed = this.#viewed;
    this.#viewed = null;
    await viewed?.file.close().catch(() => undefined);
  }

  #publishRecording(): void {
    const active = this.#recording;
    this.#set({
      recording: active
        ? {
            session: active.session,
            startedAtMs: active.startedAtMs,
            stats: active.recorder.status,
          }
        : null,
    });
  }

  #set(change: Partial<SessionsState>): void {
    this.#state = { ...this.#state, ...change };
    [...this.#listeners].forEach((listener) => listener());
  }
}
