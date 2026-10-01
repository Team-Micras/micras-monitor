# Architecture

How the Micras Monitor is put together, for someone who has just cloned it. The README covers
setup and use; this file covers the code: how data flows, what every folder and file is for, what may
import what, and how to add a source, a window or a robot package.

The app shows live variables from a robot (or a saved recording of one) in tiling windows. Everything
in `src/` serves that one path.

## 1. The flow in one picture

```
 Source                      where data comes from: src/sources/micras-comm, src/sources/demo
   |  pushes into a SourceSink: status, variables, streams, samples, values, log, stats
   v
 Monitor                     src/core/monitor.ts: the one place a source's data lands
   |  places times on a timeline, keeps status and variables, feeds the log
   v
 HistoryStore                src/history/: every sample in memory, in blocks, with queries
   |        \
   |         Recording       src/recording/: REC writes the history to a file; a file reads back into a history
   v
 UI                          src/ui/: reads the Monitor and the HistoryStore through hooks
   +-- windows               src/ui/windows/<kind>/
```

Going the other way, the UI only calls the monitor, which calls the source's connection: `request`
(what to stream), `command`, `write`, `read`. Nothing in the UI knows how a source talks to its
robot. `src/main.tsx` builds the pieces and is the only file that names a source or a robot package.

The four paths below follow real code. Every path in this file is written in full from the project
root. In section 2 the files are listed by bare name under the folder named in the heading.

### 1.1 A sample arrives and becomes a pixel

1. The transport (`src/sources/micras-comm/transports/websocket-transport.ts` or
   `src/sources/micras-comm/transports/bluetooth/bluetooth-transport.ts`) hands bytes to `RobotLink` (`src/sources/micras-comm/link/robot-link.ts`).
2. `src/sources/micras-comm/wire/cobs.ts` and `src/sources/micras-comm/wire/frame.ts` cut and check frames; `src/sources/micras-comm/link/messages.ts` decodes a `SAMPLE`.
3. `src/sources/micras-comm/link/epochs.ts` checks the sequence number of the sample against the one it expected. If the
   difference is `n > 0`, `n` samples went missing, and the sample leaves with `missingBefore = n`.
4. `src/sources/micras-comm/stream-feed.ts` calls `sink.sample(stream, timeUs, values, missedBefore)`.
5. `Monitor` (`src/core/monitor.ts`) puts the time on the session timeline (`src/core/timeline.ts`) and calls
   `history.append(runId, timeUs, values, missedBefore)`.
6. `HistoryStore.append` (`src/history/history-store.ts`) hands it to the `StreamRun` (`src/history/stream-run.ts`).
   With `missedBefore > 0` the run records a `dropped` gap in its `GapLog` (`src/history/gap-log.ts`)
   with the count, then stores the values in the current `Block` (`src/history/block.ts`) and its
   min/max pyramid (`src/history/min-max-pyramid.ts`).
7. The store tells its subscribers through `TickNotifier` (`src/history/tick-notifier.ts`), at most once
   per frame (the app gives it a `requestAnimationFrame` scheduler in `src/main.tsx`).
8. `PlotController` (`src/ui/windows/plot/plot-controller.ts`) hears it, and `src/ui/windows/plot/plot-data.ts` asks the
   store for the visible window: `DecimationBuilder` (`src/history/decimation.ts`) gives one min/max pair
   per pixel column, and `history.gaps()` gives the gaps in the window.
9. `PlotController` passes the columns to uPlot with `setData` (`src/ui/windows/plot/plot-controller.ts`).
   `src/ui/windows/plot/plot-config.ts` gives uPlot its options and `drawGaps`, which paints the
   dropped and not-stored gaps as bands behind the lines. The "N dropped" label is drawn by
   `src/ui/windows/plot/plot-window.tsx`; uPlot draws the pixels.

So a lost sample becomes a count on the wire, then `missedBefore`, then a stored gap, then a band.
The monitor does not know the wire: the source does the sequence arithmetic.

### 1.2 A window asks for variables, and GROUP_DEFINE goes out

1. Each window kind in `src/ui/windows/registry.ts` has a `demand` function: the Plot asks for its
   variables at `PLOT_RATE_HZ`, Readouts at `READOUT_RATE_HZ` (`src/ui/windows/stream-rates.ts`). A kind with no `demand`
   streams each of its variables at `DEFAULT_STREAM_RATE_HZ`; a kind that wants none says `nothing`.
2. `useStreamDemand` (`src/ui/stream-demand.ts`) gathers the demands of the visible windows and of the
   roles the package pins, and calls `live.request(demands)`.
3. `Monitor.request` (`src/core/monitor.ts`) turns variable names into ids and calls
   `connection.request(...)`.
4. `MicrasCommConnection.request` (`src/sources/micras-comm/micras-comm-connection.ts`) passes the rates
   to `StreamPlanner.request` (`src/sources/micras-comm/streaming/stream-planner.ts`).
5. The planner calls `fitGroups` (`src/sources/micras-comm/streaming/fit-groups.ts`) with the budget from
   `BandwidthEstimator` (`src/sources/micras-comm/streaming/bandwidth-estimator.ts`). The result is a list of groups, each a
   set of variables and a period; what does not fit is cut and shows in the Link window.
6. If the groups changed, the planner calls `RobotLink.setGroups`
   (`src/sources/micras-comm/link/robot-link.ts`), which runs `GroupConfigurator`
   (`src/sources/micras-comm/link/group-configurator.ts`): one `GROUP_DEFINE` and `GROUP_ENABLE` per
   group. `encodeGroupDefine` in `src/sources/micras-comm/link/messages.ts` builds the payload,
   `src/sources/micras-comm/wire/frame.ts` frames it, and `RobotLink` and the transport write it.
7. The robot answers `GROUP_ACK` to the define, and the configurator registers the epoch
   (`define` in `src/sources/micras-comm/link/epochs.ts`). After the `GROUP_ENABLE` is acknowledged it
   calls `activate`, the epoch is announced, and `src/sources/micras-comm/stream-feed.ts` tells the sink
   `streamOpened`. The `Monitor` opens a stream run in the history and samples start to flow (1.1).

### 1.3 A pinned command (STOP): key press to notice

1. The package declares `{ name: 'STOP', pinned: true, key: 'Space', tone: 'danger' }`
   (`src/robots/micras/commands.ts`). Nothing else in the code knows what STOP is.
2. `src/ui/keyboard/keymap.ts` adds the command's key to the keymap. `src/ui/keyboard/use-keymap.ts` swallows keydown and
   keyup for it, ignores key repeat, and calls the app's `onAction`.
3. `src/ui/app.tsx` finds the command (`sendByName`), asks for confirmation if the command has `confirm`
   (`src/ui/shell/commands/command-confirm.tsx`), then shows a "sent" notice
   (`src/ui/shell/commands/command-outcome.ts`).
4. It calls `live.command(code)` on the **live** monitor, never the shown one, so STOP works with a
   recording on screen. The button in the top bar (`src/ui/shell/commands/pinned-commands.tsx`) takes
   the same path through `useSendCommand` (`src/ui/shell/shell-contexts.ts`).
5. `Monitor.command` forwards to `MicrasCommConnection.command`, which calls `RobotLink.command`
   (`src/sources/micras-comm/link/robot-link.ts`). `src/sources/micras-comm/link/messages.ts` encodes `COMMAND`; `src/sources/micras-comm/link/requests.ts` waits for the matching
   `COMMAND_ACK`, with a timeout.
6. The connection maps the ack to a `CommandOutcome` (`src/core/source.ts`): `ok`, `unknown`, `refused` or `deferred`, each with the
   robot's reason code, or `failed` with a message when there was no answer.
7. `commandAnswered` (`src/ui/shell/commands/command-outcome.ts`) turns it into a notice, using the package's refusal
   reasons. It goes into the shell store (`src/ui/state/shell-store/commands.ts`), shown next to the
   button and announced to screen readers (`src/ui/shell/a11y/announcements.tsx`).

### 1.4 Recording a session, and reopening it

Recording:

1. The REC button (`src/ui/recordings/recording-controls.tsx`) calls `RecordingManager.startRecording`
   (`src/recording/library/recording-manager.ts`).
2. The manager creates a file in the library (`src/recording/library/opfs-library.ts`, which talks to
   `src/recording/library/opfs.worker.ts` and `src/recording/library/opfs-host.ts`, or `src/recording/library/memory-library.ts` without the file system) and calls
   `RecordingWriter.start` (`src/recording/recording-writer.ts`).
3. The writer is the history's `BlockBacking`: it calls `store.startRecording(writer)` and follows the
   history (`store.follow`), appending records encoded by `src/recording/codec.ts` and framed by
   `src/recording/scan.ts`. Sealed blocks are written at once and the block being filled every 5 s, so a
   dead tab loses at most that.

Reopening:

1. `src/ui/recordings/recordings-dialog.tsx` calls `RecordingManager.open(id)`.
2. `RecordingReader.read(file)` (`src/recording/recording-reader.ts`) scans the file, and `src/recording/load.ts` builds a
   `HistoryStore` of its own whose blocks load from the file as plots scroll to them.
3. The manager publishes it as `viewing`. `ShownMonitor` (`src/ui/recordings/shown-monitor.tsx`) sees it
   and replaces the _shown_ monitor with `Monitor.ofRecording(store, ...)`: a monitor over that history
   with no connection.
4. Windows read `useShownMonitor()` (`src/ui/monitor-context.ts`) and so draw the recording; the bars,
   STOP and the connection read `useLiveMonitor()` and carry on with the robot.
   `src/ui/recordings/viewing-indicator.tsx` shows which recording is on screen, and its "Live" button calls
   `backToLive()`, after which the shown monitor is the live one again.

## 2. Every folder and every file

Generated from `git ls-files src`: every tracked file under `src/` appears once, 223 in all. Tests
mirror these paths under `tests/` (section 6).

### `src/`

The composition root.

- `main.tsx`: The entry point. It creates the `HistoryStore`, the `Monitor`, the source (`?fake` picks the demo, otherwise `micras-comm`), the robot registry and the storage worker, and renders `App`. It is the only file allowed to import a source or a robot package.

### `src/core/`

What the rest of the app agrees on, with no React and no wire format. The `Source` boundary and the `Monitor` that receives from it live here, and so do the model of a variable and the contract of a robot package. It imports nothing else from the project.

- `variables.ts`: The model of a variable: `ValueType`, its bit width and range, `Access`, `Variable` and `Value`. Every source maps its own type codes onto it.
- `integers.ts`: 64-bit integers (number or bigint) and bit tests that do not lose bits a number cannot hold.
- `source.ts`: The `Source`, `SourceConnection` and `SourceSink` interfaces, and the outcome types of commands, writes and reads. The plugin boundary.
- `monitor.ts`: The `Monitor`: implements the sink once, places times on the timeline, feeds the history and the log, keeps status, variables and stats, and forwards `request`, `command`, `write` and `read` to the connection. `Monitor.ofRecording` makes a read-only one over a saved history.
- `timeline.ts`: `SessionTimeline`: puts the times of each run of the robot's clock on one timeline that never goes back, across reboots and reconnections.
- `log.ts`: The bounded log of robot lines and connection notes that the Log window shows.
- `emitter.ts`: A small typed event emitter used wherever something needs listeners.
- `chords.ts`: Key chords: parsing `Alt+Shift+ArrowLeft`, matching it against a keyboard event and formatting it. Kept in the core because robot packages name keys for their commands.

### `src/core/robot/`

The contract of a robot package: plain data that tells the generic UI what a schema cannot (labels, units, roles, commands, presets). A package is registered at startup and chosen by the robot's name or variable names.

- `index.ts`: Public surface of the folder.
- `types.ts`: `RobotPackage`, `CommandSpec`, roles, serializable types and everything else a package can declare.
- `registry.ts`: `RobotRegistry`: holds the packages and picks one for a connected robot.
- `validate.ts`: Consistency checks run when a package is registered, so a broken package fails at startup.
- `package-error.ts`: The error a rejected package raises, with the path of the offending field.
- `present.ts`: Helpers the generic UI reads a package with: labels, roles, command lookup. All accept `null`, which is raw mode.

### `src/history/`

The history in memory: every sample of the session, stored in fixed-size blocks, with the queries the plots and readouts use. It imports only `src/core`. It knows nothing of the wire, of React or of uPlot.

- `history-store.ts`: `HistoryStore`: the public facade. Opens and closes stream runs, appends samples, marks boundaries, answers the queries and carries the subscriptions. It is the largest file here.
- `index.ts`: Public surface of the folder.
- `queries.ts`: The read side: ranges, change checks, sample iteration, value at a time, decimation entry point.
- `stream-run.ts`: `StreamRun`: the samples of one stream from open to close. Checks time order, turns `missedBefore` into a dropped gap, fills blocks.
- `gap-log.ts`: `GapLog`: the gaps of a run (dropped, not-stored) and how much memory they cost.
- `block.ts`: `Block`: a fixed-size stretch of one run's columns, with its min/max pyramid.
- `block-backing.ts`: `BlockBacking`, `BlockRef` and `BlockData`: what a place that keeps blocks outside memory (the recording) must offer.
- `columns.ts`: How a numeric variable is stored (f32 or f64) and the column allocation helpers.
- `min-max-pyramid.ts`: `MinMaxPyramid`: min and max summaries per level, so a plot can draw a long range without reading every sample.
- `decimation.ts`: `DecimationBuilder`: turns a time window into at most one min/max pair per pixel column, with flags for data, NaN and line breaks.
- `variable-history.ts`: `VariableHistory`: one variable's history, a list of segments, one per run it was in, plus its latest value.
- `variable-registry.ts`: Looks variables up by name and type, and maps the robot's ids to names through the current schema.
- `tick-notifier.ts`: `TickNotifier` and `ChangeSignal`: tell readers something changed, at most once per frame.
- `scheduler.ts`: The `Scheduler` interface (the app passes `requestAnimationFrame`) and a manual one for tests.
- `types.ts`: Shared types: gap kinds and `Gap`, boundaries, `TimeRange`, variable references, recorded records.

### `src/history/memory/`

The memory cap. When the history passes it, blocks already written to a recording leave memory and are read back when a plot scrolls to them; without a recording the oldest ones are dropped and show as not-stored.

- `block-memory.ts`: `BlockMemory`: counts bytes, chooses what to evict, starts the reads back and the writes out.
- `block-loader.ts`: Bookkeeping for the reads back: what the current query asked for and how many reads are under way.
- `block-writer.ts`: Bookkeeping for the writes out: which blocks are written, which are due, and the backoff of failing writes.

### `src/recording/`

The recording format and its files: what REC writes while the robot streams, and how a saved recording is scanned, checked and read back into a history. It imports `src/core` and `src/history`.

- `index.ts`: Public surface of the folder.
- `codec.ts`: Format version 2: header and record layouts, with encoders and decoders.
- `bytes.ts`: Little-endian readers and writers the codec is built on.
- `crc32.ts`: CRC-32 of bytes.
- `scan.ts`: Record framing and how a reader finds records again after damage.
- `recording-file.ts`: The `RecordingFile` interface (write at a position, read a slice) and an in-memory one.
- `recording-writer.ts`: `RecordingWriter`: follows a history and appends records to a file as they happen.
- `recording-reader.ts`: `RecordingReader`: reads a file, finds its blocks and tells where each sits.
- `load.ts`: Builds a `HistoryStore` from a read recording, with its blocks loaded on demand.

### `src/recording/library/`

Where the recordings live: the browser's private file system through a worker, or memory where there is none. `RecordingManager` is what the UI talks to.

- `recording-manager.ts`: `RecordingManager`: start and stop REC, list, rename, delete, export, recover recordings a dead tab left, open one to look at, go back to live.
- `recording-library.ts`: The `RecordingLibrary` interface: files and descriptions per recording, and the locks.
- `opfs-library.ts`: The library as the page sees it: every file operation goes to the worker.
- `opfs-host.ts`: The library as the worker runs it, with synchronous access handles.
- `opfs.worker.ts`: The worker entry that serves `opfs-host`.
- `storage-worker.ts`: Starts that worker early, so it is loaded before REC needs it.
- `memory-library.ts`: A library in memory, for browsers without the file system and for tests.
- `browser-recordings.ts`: Chooses between the two and builds the manager for the app.
- `download.ts`: Saves an exported recording to the user's disk.

### `src/robots/micras/`

The package for the team's micromouse, as plain data: labels, commands (with STOP pinned to Space), variable presentation, the maze view and the suggested workspaces. It imports `src/core` and React, and never a source.

- `index.ts`: The `micras` package.
- `commands.ts`: The commands, the states that accept each and the refusal reasons.
- `labels.ts`: The integer vocabularies of the firmware: state, objective, run profile, fault.
- `variables.ts`: Units, descriptions, labels and colors per variable.
- `presets.ts`: The workspaces Micras suggests.
- `maze.ts`: Decodes the firmware's serialized maze.
- `maze-view.tsx`: Draws the maze and the robot on it.

### `src/sources/`

Where robot data comes from. Each folder is one source: it implements `Source`, pushes into the `SourceSink` and may import only `src/core` and its own folder. A source never imports another source.

### `src/sources/demo/`

A robot in memory, for `?fake`: no wire, no simulation, a source written directly against the sink.

- `demo-source.ts`: `DemoSource`: answers at once, streams synthetic signals, takes commands and writes, logs.
- `demo-robot.ts`: The demo robot's variables and signals, shaped like the Micras.
- `demo-maze.ts`: A maze the demo reveals cell by cell.

### `src/sources/micras-comm/`

The source for robots that speak the `micras_comm` protocol, the only place that knows it. It turns frames from a transport into the monitor's model. Wire format in `wire/`, the protocol state in `link/`, rate planning in `streaming/`, byte pipes in `transports/`.

- `micras-comm-source.ts`: The `Source`: builds a transport and a link for a target and returns a connection.
- `micras-comm-connection.ts`: One connection: a link and its planner, driven by the monitor, reporting to the sink. Maps commands, writes and reads onto the link.
- `stream-feed.ts`: Turns what the link streams into `streamOpened`, `sample` (with `missedBefore`), `streamClosed` and boundaries.
- `connection-status.ts`: Turns link and transport state into the source's status and stats.
- `value-types.ts`: The one place the wire's type codes and access flags are mapped onto `ValueType` and `Access`.
- `schema-storage.ts`: Keeps schemas in `localStorage` so a reconnect to the same build skips the paged schema.

### `src/sources/micras-comm/link/`

The protocol state machine: handshake, schema, requests with answers, writes, credit, groups and epochs. `RobotLink` is the hub.

- `robot-link.ts`: `RobotLink`: the handshake, the state machine, dispatch of incoming messages, commands, writes and reads.
- `link-events.ts`: The vocabulary of link states and events, plus the counters.
- `messages.ts`: One encoder or decoder per message type; the only code that knows where a field sits in a payload.
- `requests.ts`: Matches answers to requests (with timeouts) and `AsyncMutex` for one-at-a-time exchanges.
- `schema.ts`: Schema entries and the assembler that joins the schema pages.
- `epochs.ts`: Epochs: one definition of a group from enabled to redefined or lost. Checks sequence numbers, counts missing samples and places robot times.
- `group-configurator.ts`: Brings the robot's groups in line with a requested layout with GROUP_DEFINE and GROUP_ENABLE.
- `credit.ts`: `CreditLedger` and `CreditFlow`: how much the robot may still send.
- `write-queue.ts`: Writes to variables, at most one in flight per variable.
- `link-watchdog.ts`: PINGs the robot to notice silence and stalled streams, and measures the round trip.
- `clock.ts`: Unwraps the robot's clock and tells a wrap from a step back.
- `retry.ts`: `Backoff` for reconnection and `withTimeout`.
- `errors.ts`: Error classes for robot errors, timeouts and link failures.

### `src/sources/micras-comm/streaming/`

Decides what to stream. Windows ask for rates per variable; this folder fits them to the bandwidth the link has.

- `stream-planner.ts`: `StreamPlanner`: takes requested rates, asks `fitGroups`, and reconfigures the robot only when the groups change.
- `fit-groups.ts`: `fitGroups`: packs the requested variables into groups within the byte budget, cutting what does not fit.
- `bandwidth-estimator.ts`: `BandwidthEstimator`: how many bytes per second the radio and the serial port can carry.

### `src/sources/micras-comm/transports/`

Byte pipes. A transport opens, sends bytes and reports bytes and state; nothing here knows frames.

- `transport.ts`: The `Transport` interface, its states and close reasons, and a base class.
- `websocket-transport.ts`: A WebSocket transport (also the simulation's bridge).

### `src/sources/micras-comm/transports/bluetooth/`

Web Bluetooth to the HM-19 module.

- `bluetooth-transport.ts`: The Bluetooth transport.
- `bluetooth-types.ts`: The parts of Web Bluetooth it uses, typed here because TypeScript's DOM library lacks them.
- `gatt-write-queue.ts`: Queues GATT writes one chunk at a time.

### `src/sources/micras-comm/wire/`

Bytes on the wire: byte stuffing, frames, message type constants, value codecs. It depends on nothing, and is shared with the simulated robot in `scripts/`.

- `index.ts`: Public surface of the folder.
- `cobs.ts`: COBS byte stuffing, matching the firmware.
- `frame.ts`: Frame encoding, Fletcher-16 check and the decoder that resynchronises.
- `constants.ts`: Message types, error codes and limits mirrored from the firmware's `protocol.hpp`.
- `value-codec.ts`: Reads and writes the values the schema describes, indexed by type code.

### `src/tiling/`

The tiling window engine: workspaces of split trees, a floating layer, placement, focus and drop targets, all as immutable data. No DOM, no React, no project imports.

- `index.ts`: Public surface of the folder.
- `types.ts`: The data: desktop, workspace, tree nodes, windows.
- `tree.ts`: Pure split-tree primitives.
- `workspace.ts`: Operations on one workspace: focus history, placement, tiled and floating.
- `workspaces.ts`: Add, rename, reorder and remove workspaces.
- `desktop.ts`: Operations on the whole desktop.
- `layout.ts`: Turns a workspace into rectangles for a viewport, with minimum sizes.
- `geometry.ts`: Rectangle helpers.
- `focus.ts`: Geometric focus (which window is to the left) and reading order.
- `hit-test.ts`: Where a dragged window would land, and applying the drop.
- `corners.ts`: Resizing two splits at once from a corner.
- `commands.ts`: One command per keymap or pointer action, and `execute`.
- `serialize.ts`: JSON snapshots of a desktop, validated on the way back in.
- `validate.ts`: The rules every desktop obeys.
- `errors.ts`: The error for a layout the engine cannot accept.

### `src/ui/`

The React interface. It reads the monitor and never imports a source or a robot package; `main.tsx` hands those in. The subfolders are shell (bars, dialogs), tiling (the React side of the engine), windows (one folder per kind), state, layouts, keyboard, recordings, phone, pwa, lazy, lib (formatting) and primitives (shadcn).

- `app.tsx`: `App`: wires the monitors, the shell store, keyboard, command sending and confirmation, and lays out the top bar, tiling, status bar, drawer and launcher.
- `monitor-context.ts`: `MonitorContext` and its hooks: `useLiveMonitor()` (bars, STOP, connection) and `useShownMonitor()` (windows), plus the per-variable hooks and the `PackageChooser`.
- `stream-demand.ts`: Collects what the visible windows and pinned roles want streamed and hands it to the live monitor.
- `styles.css`: Tailwind entry, theme tokens and global styles.

### `src/ui/keyboard/`

Keys.

- `keymap.ts`: Every action, the keys of the package's commands, default chords and overrides.
- `use-keymap.ts`: The keyboard listener that turns events into actions.
- `tiling-actions.ts`: The keymap actions that are tiling commands.
- `key-overrides.ts`: Keeps the keys the user rebound.

### `src/ui/layouts/`

Layouts: presets, saved layouts per robot and the layout a robot with no package gets.

- `saved-layouts.ts`: Layouts saved per robot in `localStorage`.
- `layout-sync.ts`: Loads the connected robot's layout and saves changes shortly after.
- `presets.ts`: Presets as workspaces and back.
- `auto-layout.ts`: The layout for a robot with no package, from its schema.

### `src/ui/lazy/`

Code splitting.

- `lazy-with-retry.ts`: `React.lazy` that can try again after a failed chunk load.
- `lazy-part.tsx`: Loads a part of the interface when first needed.
- `idle.ts`: Runs work when the browser is idle.

### `src/ui/lib/`

Small helpers.

- `format.ts`: Formatting of values and times for the screen.

### `src/ui/phone/`

The single-column view under 640 px.

- `phone-plan.ts`: Chooses what the phone shows from the package and schema.
- `phone-view.tsx`: Draws it.

### `src/ui/primitives/`

The shadcn components the interface is built from, generated and then trimmed. Not domain code.

- `badge.tsx`: Badge.
- `button.tsx`: Button.
- `command.tsx`: Command palette list (cmdk), used by the launcher.
- `context-menu.tsx`: Context menu.
- `dialog.tsx`: Dialog.
- `dropdown-menu.tsx`: Dropdown menu.
- `input.tsx`: Text input.
- `kbd.tsx`: Keyboard key cap.
- `popover.tsx`: Popover.
- `separator.tsx`: Separator.
- `switch.tsx`: Switch.
- `tooltip.tsx`: Tooltip.
- `utils.ts`: `cn`, which joins class names.

### `src/ui/pwa/`

Installed-app behavior.

- `app-updates.ts`: Whether a new build is waiting and the action to apply it.

### `src/ui/recordings/`

The interface for recordings (shown to the user as "Sessions").

- `recordings-context.ts`: The `RecordingManager` as React reads it.
- `recording-controls.tsx`: The REC button and its progress.
- `recordings-dialog.tsx`: The list of recordings: open, rename, export, delete.
- `shown-monitor.tsx`: Replaces the shown monitor with one over the open recording.
- `viewing-indicator.tsx`: Which recording is on screen, with the way back to live.
- `recovery-notice.tsx`: A recording a closed tab left behind was recovered.
- `memory-notice.tsx`: The memory cap warnings.
- `reset-dialog.tsx`: Asks before forgetting the live history.
- `recording-text.ts`: Words for a recording.

### `src/ui/shell/`

The frame around the windows: bars, the variable drawer, the launcher, dialogs, notices and accessibility helpers.

- `variable-drawer.tsx`: The `/` drawer that lists the schema and starts drags.
- `variable-groups.ts`: Filters and groups the drawer's list by name prefix.
- `launcher.tsx`: The `Ctrl+K` launcher.
- `lazy-shell.ts`: Lazy loading of the heavier shell parts.
- `close-workspace-dialog.tsx`: Asks where a closing workspace's windows go.
- `shell-contexts.ts`: Contexts the shell gives windows and bars: announce, send a command, track pending commands.

### `src/ui/shell/a11y/`

Screen reader and focus helpers.

- `announcer.tsx`: The polite and assertive live regions and the function that fills them.
- `announcements.tsx`: Announces connection, state, command and recording events.
- `focus-trap.ts`: Keeps Tab inside a dialog.

### `src/ui/shell/bars/`

The top bar, the workspace tabs and the status bar.

- `top-bar.tsx`: Robot and connection, the open recording, tabs, clock, REC and the pinned commands.
- `workspace-tabs.tsx`: The workspace tabs, with drag to reorder and a menu.
- `tab-reorder.ts`: Which gap a dragged tab is over and where it lands.
- `connection-popover.tsx`: The connection pill: URL or Bluetooth pairing.
- `layouts-menu.tsx`: Apply, save and delete layouts.
- `session-clock.tsx`: How long the link has been up.
- `status-bar.tsx`: The bar under the tiling: drawer, size, theme.

### `src/ui/shell/commands/`

Sending commands from the shell and telling what came of it.

- `pinned-commands.tsx`: The buttons for the package's pinned commands and the notice after the last one.
- `command-outcome.ts`: Builds the notice for a command: sent, answered with a reason, or no robot.
- `command-confirm.tsx`: The confirmation dialog of commands that ask first.

### `src/ui/shell/notices/`

Notices that appear over the interface.

- `undo-notices.tsx`: Undo for a deleted layout or a removed variable.
- `update-notice.tsx`: "Update available" and failed chunk loads.
- `reload-guard.ts`: Whether a reload is unsafe: recording, robot not at rest, link unsettled.

### `src/ui/state/`

The shell's own state (desktop, theme, overlays, drags). Robot data is not here; it is in the monitor.

- `default-desktop.ts`: The workspaces shown before a robot has linked.
- `theme.ts`: Light and dark theme choice.

### `src/ui/state/shell-store/`

One zustand store built from slices.

- `index.ts`: Builds the store from the slices.
- `types.ts`: The state and action types of every slice.
- `desktop.ts`: Windows, workspaces and viewport.
- `layouts.ts`: The user's presets and the loaded layout.
- `ui.ts`: Theme and open panels.
- `drag.ts`: Drags in progress.
- `commands.ts`: The robot's commands, their key bindings and the last command notice.

### `src/ui/tiling/`

The React side of the tiling engine: it draws the layout and the handles, and runs drags.

- `tiling-view.tsx`: Renders every workspace as one flat list of windows so a view stays mounted when it moves.
- `window-frame.tsx`: A window's title bar, chips and body.
- `window-menu.tsx`: The window menu: float, maximize, move.
- `window-error-boundary.tsx`: Contains a window that crashes.
- `series-chips.tsx`: The variable chips in a title bar.
- `split-handle.tsx`: The gap between tiles, a mouse and keyboard splitter.
- `corner-handle.tsx`: Resizes two splits from a corner.
- `pointer-drag.ts`: The pointer drag gesture and hit-testing under it.
- `drag-ghost.tsx`: The chip that follows the pointer.
- `drop-preview.tsx`: Shows where a drop would land.
- `keyboard-order.ts`: Tab order, DOM ids that tie frames to controls, and the drawer search field.

### `src/ui/windows/`

One folder per window kind. `registry.ts` lists the kinds and what each asks the link to stream.

- `registry.ts`: The window kinds: title, icon, component (lazy for heavy ones) and `demand`.
- `types.ts`: `ShellWindow`, its payload and the props of a window.
- `stream-rates.ts`: The rates each kind asks for.
- `placeholder-window.tsx`: Stands in for a kind this build does not know.

### `src/ui/windows/blob-view/`

The window that draws a serialized type, such as the maze.

- `blob-view-window.tsx`: The window; calls the package's view for the type.
- `coalesced-reads.ts`: Reads one variable, never more than one at a time.
- `hex-dump.ts`: A hex dump for types no package decodes.

### `src/ui/windows/commands/`

The Commands window.

- `commands-window.tsx`: The window.
- `command-state.ts`: Whether a command can be sent now and an answer in words.
- `command-icons.ts`: The icons a command can show, by name.

### `src/ui/windows/editor/`

The Editor window: write variables.

- `editor-window.tsx`: The window.
- `controls.tsx`: The control for each kind of variable.
- `editor-value.ts`: Which control a variable gets and how typed text becomes a value.
- `write-note.tsx`: The last write and how the robot answered.

### `src/ui/windows/link/`

The Link window: rate, losses, round trip, gauges.

- `link-window.tsx`: The window.
- `link-summary.ts`: The stats as the window words them.

### `src/ui/windows/log/`

The Log window.

- `log-window.tsx`: The window.
- `log-filter.ts`: Which entries show and how times read.

### `src/ui/windows/plot/`

The Plot window: a uPlot chart read straight from the history.

- `plot-window.tsx`: The React window.
- `plot-controller.ts`: Owns the uPlot, subscribes to the history and redraws at most once per frame.
- `plot-data.ts`: Computes axes, decimated columns, the live window and visible gaps.
- `plot-config.ts`: The uPlot options and the bands drawn for dropped and not-stored gaps.
- `plot-navigation.ts`: Pan and zoom of a paused plot.
- `plot-tooltip.ts`: The tooltip under the cursor.

### `src/ui/windows/readouts/`

The Readouts window.

- `readouts-window.tsx`: Latest values, large, ten times a second; stale ones fade.

### `src/ui/windows/robot/`

The Robot window: state, battery, pose, timeline of states.

- `robot-window.tsx`: The window.
- `transitions.ts`: Finds changes of a variable's value in its history.
- `logged-transitions.ts`: The same from the robot's own log lines, filled in from the history.

### `src/ui/windows/shared/`

Helpers several windows use.

- `presented-variables.ts`: A window's variables with schema entry, package presentation and color.
- `value-text.ts`: Values in words: enum labels, flags, aligned numbers, staleness.
- `session-end.ts`: The end of the history, and how old a value may get at its rate.
- `document-theme.ts`: Theme colors for canvases that cannot use CSS variables.

## 3. The import rules

Folders are layers and the arrows point one way. `.oxlintrc.json` enforces them with
`no-restricted-imports`; each rule's message says what it guards, and `bun run lint` fails on a
violation.

| Folder                     | May import                                                 | Never imports                                                           |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/core/`                | other core modules, by relative path                       | anything else in the project (also `main`), React                       |
| `src/history/`             | `core`                                                     | recording, tiling, sources, robots, ui, `main`, React                   |
| `src/recording/`           | `core`, `history`                                          | tiling, sources, robots, ui, `main`, React                              |
| `src/tiling/`              | nothing in the project                                     | core, history, recording, sources, robots, ui, `main`, React            |
| `src/sources/<s>/`         | `core` (by `@/core`) and its own folder (by relative path) | history, recording, tiling, robots, ui, `main`, any other source, React |
| `src/robots/<robot>/`      | `core` (with `core/robot` as the contract), React          | history, recording, tiling, sources, ui, `main`, another robot          |
| `src/ui/`                  | `core`, `history`, `recording`, `tiling`, React            | sources, robots, `main`                                                 |
| `src/main.tsx`             | everything in `src/`, React                                |                                                                         |
| `scripts/`                 | `core` and the sources                                     | history, recording, tiling, `core/robot`, robots, ui, tests, React      |
| `scripts/simulated-robot/` | `src/sources/micras-comm/wire` only                        | everything else in `src/`, tests, React                                 |
| `scripts/bench-history.ts` | `core` and `history`                                       | recording, tiling, `core/robot`, robots, ui, sources, tests, React      |
| any file in `src/`         |                                                            | `tests/`, `scripts/`                                                    |

React is allowed only in `src/ui/`, the robot packages and `src/main.tsx`. The `@/` alias is `src/`.

How a source is fenced from other sources without naming them: the generic rule for
`src/sources/*/**` forbids every `@/sources/...` alias, so a source reaches its own files only by
relative path; and a rule per depth (`src/sources/*/*.ts`, `src/sources/*/*/*.ts`, and so on to five
levels, for `.ts` and `.tsx`) forbids a relative path that climbs out of the source's own folder. A
new source folder is fenced from `demo`, from `micras-comm` and from every future source as soon as
it exists, and they are fenced from it.

`tests/config/import-fences.test.ts` checks the fences themselves: it writes probe files into a temporary directory with the same config, runs oxlint on them and expects each import to be refused or accepted as the table says. If
you change a rule in `.oxlintrc.json`, that test is where to say what it should now do.

## 4. The vocabulary

- **source**: something that can give the monitor a robot's data (`Source`, `src/core/source.ts`). There are two: `micras-comm` and `demo`.
- **connection**: one live use of a source, a `SourceConnection`. The monitor sends `request`, `command`, `write` and `read` to it; it pushes into a `SourceSink`.
- **monitor**: the `Monitor` of `src/core/monitor.ts`: the sink every connection pushes into, and what the UI reads. The _live_ monitor has a connection; a _recording_ monitor reads a saved history and has none.
- **stream**: a set of variables sampled together and delivered together, with one time per sample. The source numbers streams.
- **stream run** (`StreamRun`): one stream in the history, from the moment it opened to the moment it closed. A new layout in the same slot is a new run.
- **run of the robot's clock** (in the timeline, `src/core/timeline.ts`): the stretch of a robot's own clock between two reboots or resets. `SessionTimeline` gives each one an offset so all of them sit on one timeline. Not the same as a stream run.
- **epoch**: `micras-comm` only (`src/sources/micras-comm/link/epochs.ts`): one definition of a group on the robot, from enabled to redefined or lost. Its sequence numbers only mean something inside it. The monitor sees epochs as streams.
- **slot**: where the robot keeps a stream; a new stream in a slot replaces the one there. For `micras-comm` it is the group number.
- **gap**: a stretch of a variable's history with no samples. Kinds: `dropped` (it was streamed, the source knows samples were lost; has a count), `not-stored` (the memory cap did not keep them, or later let them go; has a count), `not-streamed` (the variable was in no stream then; not drawn).
- **block**: a fixed-size stretch of a run's columns (`src/history/block.ts`), the unit of memory eviction and of what a recording writes and reads back.
- **package**: a `RobotPackage` (`src/core/robot/types.ts`): plain data saying what a schema cannot (labels, units, roles, commands, presets). Without one the app still works in raw mode.
- **pinned command**: a command whose package entry says `pinned: true`: it stays in the top bar and at the bottom of the phone view, may carry a `key`, a `tone` and a `confirm`, and always goes to the live monitor.
- **recording**: a saved history in a file (`src/recording/`). The UI calls them "Sessions".

## 5. How to add things

### A new data source

1. Make `src/sources/<name>/` with a class implementing `Source` (`id`, `targets`, `connect(target, sink)`),
   which returns a `SourceConnection` (`request`, `command`, `write`, `read`, `pendingWrite`, `close`).
2. Push into the sink: `status`, `variables` (`Variable` of `src/core/variables.ts`; an empty list when
   they are gone), `streamOpened`, `sample` with `missedBefore` (the source does its own loss count),
   `streamClosed`, `value`, `boundary`, `log`, `writesChanged` (a write started or ended), `stats`.
3. Import only `src/core` (by `@/core/...`) and your own folder, by relative path. Never write
   `@/sources/...`. The fences in `.oxlintrc.json` cover any folder `src/sources/*/` automatically,
   including "never import another source" (section 3); add rows to
   `tests/config/import-fences.test.ts` only if you add a rule.
4. If it reaches robots in a way the monitor cannot yet name, extend `TargetKind` and `Target` in
   `src/core/source.ts`, then give the new kind a label in `TRANSPORT_LABELS` and a form in
   `src/ui/shell/bars/connection-popover.tsx`.
5. Choose it in `src/main.tsx`, where `source()` decides what the `Monitor` gets. Today `?fake` is an
   either/or switch between the demo and `micras-comm`, and `?connect=` starts a WebSocket target only,
   so a third source needs its own way to be selected and to be connected.
6. Put tests under `tests/sources/<name>/`. `tests/support/sources/scripted-source.ts` is a scripted
   source for tests of the layers above; `src/sources/demo/` is the shortest example to read.

### A new window kind

1. Make `src/ui/windows/<kind>/<kind>-window.tsx`, a component taking `WindowViewProps`. Read data with
   `useShownMonitor()`; use `useLiveMonitor()` only for what must act on the robot.
2. Add an entry to `WINDOW_KINDS` in `src/ui/windows/registry.ts`: `id`, `title`, `description`, `icon`,
   the (lazy) `component`, and `acceptsVariables` (required: whether a variable dropped on the window
   joins it, or opens a plot beside it).
3. Say what it wants streamed with `demand` (rates in `src/ui/windows/stream-rates.ts`). Without
   `demand`, each of its variables streams at `DEFAULT_STREAM_RATE_HZ`; pass `nothing` to stream none.
4. Add it to `src/ui/state/default-desktop.ts` or to a package's presets if it should open by default.
5. Pure logic goes in its own `.ts` file beside the window, with a test in `tests/ui/windows/<kind>/`.

### A new robot package

1. Make `src/robots/<robot>/index.ts` exporting a `RobotPackage`. The README has a worked example.
   `src/robots/micras/` splits labels, commands, variables, presets and a maze view.
2. Register it in `src/main.tsx`: `new RobotRegistry([micras, <robot>], reservedChord)`.
   `validatePackage` rejects a malformed one at startup.
3. A new type that needs a drawing gets a `SerializableType` whose `View` or `loadView` draws it.

## 6. Tests and scripts

File names are kebab-case throughout.

`tests/` mirrors `src/`: `src/history/history-store.ts` is tested by `tests/history/history-store.test.ts`.
An integration test sits with the module it exercises, such as
`tests/sources/micras-comm/link/robot-link-simulated.test.ts`. Also:

- `tests/support/`: fixtures and helpers (scripted source, in-memory backings, sample recordings,
  virtual time, mouse and browser setup), mirroring `src/` where they belong to a module.
- `tests/config/`: tests of the build and lint setup, including the import fences.
- `tests/scripts/`: tests of the bench comparison and the simulated maze.
- `tests/e2e/`: the PWA check, which builds the app and runs it in Chromium.
- `.test.ts` runs in Node (`unit`), `.test.tsx` in Chromium (`browser`). Files named
  `*-performance.test.*` are the `performance` project, which only `bench` runs.

Scripts (`bun run <name>`; sources in `scripts/`):

| Script            | What it does                                                                    |
| ----------------- | ------------------------------------------------------------------------------- |
| `check`           | lint, format check, typecheck, tests, e2e, build and size, as CI does           |
| `check:sim`       | follows an exploration of Micras in the simulation through the app (manual)     |
| `check:recording` | records a long session, kills the tab and checks recovery (manual)              |
| `check:live`      | streams a live robot's variables through a link and prints what it did (manual) |
| `bench`           | frame budget of eight plots against the stored baseline                         |
| `bench:history`   | memory and query times of the history store at full size                        |
| `simulate`        | the simulated robot on a WebSocket (`scripts/simulated-robot/`)                 |
| `size`            | gzipped size of the bundle against its target                                   |

Other files in `scripts/`: `bench-compare.ts`, `bench-diff.ts`, `bench-result.ts` and
`bench-baseline.json` (judging bench runs), and `simulated-robot/` (`server.ts`, `robot.ts`,
`variables.ts`, `commands.ts`, `maze.ts`, `faults.ts`, `wire.ts`: a robot that speaks `micras_comm`,
sharing `src/sources/micras-comm/wire/` with the app). The README has the options of each.

**Machine rule: run one browser suite at a time.** Chromium starts in `bun run test` (its browser
project), `test:browser`, `test:e2e`, `bench` (the `performance` project), `check` (which includes
those) and, through Playwright, `check:sim` and `check:recording`. `check:live` is Node only. Two
suites at once have frozen the notebook. Take the lock when you run them:
`flock /tmp/micras-monitor-tests.lock bun run check`.
