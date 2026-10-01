# Micras Monitor

A browser monitor and remote control for robots that speak the `micras_comm` protocol. It connects
over Bluetooth LE or a WebSocket bridge to the simulation, learns the robot from its schema, and
shows live variables in a tiling workspace: plots, readouts, the maze, the robot's state, its
commands, its log and the state of the link. It records sessions in the browser, works offline as
a PWA, and has a single-column view for the phone. The team's guide, in Portuguese, is
`docs/monitor-redesign/USER-GUIDE.md` at the root of the Micras workspace.

## Requirements

- [Bun](https://bun.sh) 1.4 (package manager and scripts)
- Node.js 22.12 or later (Vite and Vitest run on it)
- A Chromium-based browser (Chrome, Edge) for Web Bluetooth; Firefox and Safari do not implement it
- Playwright's Chromium for the browser tests: `bunx playwright install chromium`

## Running it

`bun install`, then one of:

| To see                      | Run                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| The app, no robot           | `bun run dev`, open the page and use the connection pill                                               |
| A synthetic robot in memory | `bun run dev` and open `/?fake`                                                                        |
| The simulated robot         | `bun run simulate` (`ws://localhost:8080`) next to `bun run dev`, then `/?connect=ws://localhost:8080` |
| The real simulation         | `just micras serve` in the simulation's repository, then connect to its bridge                         |
| A real robot over Bluetooth | Connection pill, Bluetooth, Connect; needs Chrome and a secure context (see below)                     |

The connection pill in the top bar takes a WebSocket URL or starts the Bluetooth pairing. Other
query parameters: `?memory-cap-mb=<n>` caps the live session's memory and `?view-cap-mb=<n>` that
of an opened session. The simulated robot listens on `MICRAS_SIM_PORT` when it is set, and flags
shape its link and inject faults, for example `bun run simulate --throughput 3000 --latency 50
--corrupt 0.02`; the header of `scripts/simulated-robot.ts` lists them all.

## Keyboard

The keymap is central (`src/app/keymap/keymap.ts`), and the launcher (`Ctrl+K`) lists the same
actions. Keys that are not a modified chord (`P`, `Space`, `/`) are ignored while typing in a text
field. Space is STOP: it is handled before anything else, in keydown and keyup, so the same press
never also presses a focused button. On Linux Chrome, `Alt+1..8` and `Alt+F` may belong to the
browser; the installed PWA does not have that problem.

| Keys                                    | Action                                                               |
| --------------------------------------- | -------------------------------------------------------------------- |
| `Space`                                 | STOP the robot                                                       |
| `Alt+←/→/↑/↓`                           | Focus the window in that direction                                   |
| `Alt+Shift+←/→/↑/↓`                     | Move (swap) the window in that direction                             |
| `Alt+F`                                 | Maximize the focused window                                          |
| `Alt+O`                                 | Float or tile the focused window                                     |
| `Alt+Q`                                 | Close the focused window                                             |
| `P`                                     | Pause the focused window                                             |
| `Alt+1..9`                              | Go to a workspace                                                    |
| `Alt+Shift+1..9`                        | Send the focused window to a workspace                               |
| `Alt+Shift+PgUp/PgDn`                   | Move the workspace left or right                                     |
| `Alt+Shift+W`                           | Close the workspace, asking where its windows go                     |
| `Delete` on a series' remove button     | Take the variable out of the window                                  |
| `Ctrl+Z`                                | Undo the last layout deleted or variable removed                     |
| `Ctrl+K` (`Meta+K`)                     | Launcher                                                             |
| `/`                                     | Variables drawer                                                     |
| `Esc`                                   | Close the drawer, a dialog or a menu                                 |
| `Tab`                                   | Windows in screen order, then the gaps, then floating windows        |
| Arrows, `Home`, `End`, `Enter` on a gap | Resize a split by 2% (10% with Shift), to its limits, or even it out |

The keymap reads overrides from the browser's storage (`src/app/state/key-overrides.ts`).

## Workspaces and layouts

A workspace is a tiling of windows (Plot, Readouts, Editor, Type view such as the maze, Robot,
Commands, Log, Link). Drag a window's title to swap it (centre of another window), split it (edge)
or send it to another workspace (drop on its tab); drag a gap or use the keyboard to resize, or a
corner where two gaps meet to resize both at once; drag a variable from the drawer onto a window to
add it or onto an edge to plot it in a new window, and take it out again with the × on its chip in
the title bar (the "+N" list holds the ones past the third) or from the window menu. The window
menu floats, maximizes and moves windows. Drag a workspace tab along the bar to reorder the
workspaces; its right-click menu moves it, or closes it with its windows or moving them to another
workspace.

The robot's package brings layouts (for Micras: Overview, Tracking, Sensors, Maze run). The Layouts
menu applies them as a new workspace and saves your own. Layouts are kept per robot and refer to
variables by name, so adding a variable to the firmware does not lose them.

## REC and sessions

The live session is the telemetry store of the running app, always in memory; the link feeds it for
the life of the tab, across reconnections. REC writes it to a session file in the browser's Origin
Private File System: the whole session so far first, then every block as it seals, and the block
being filled every 5 s, so a tab that dies loses at most the last 5 s. Stopping ends the file; Reset
forgets the live history, and ends the recording first. Past the memory cap, blocks already written
leave memory and are read back from the file when a plot scrolls to them, and without REC the oldest
history is dropped as a `not-stored` band.

A saved session opens read only, in the same windows, into a store of its own. The link and the live
store carry on underneath, REC keeps recording, and STOP still reaches the robot; the windows' own
commands, writes and reads are off until **Live** goes back to the live session.

Each session is a directory `micras-monitor/sessions/<id>/` with `session.json` and
`recording.mmrec` (format version 1, `src/telemetry/recording.ts`). A dedicated worker
(`src/app/sessions/opfs.worker.ts`) owns the files and appends through synchronous access handles,
each write flushed before it is acknowledged. The tab recording a session holds a Web Lock on it; on
start, a session still marked `recording` whose lock nobody holds was cut short: its damaged tail, if
any, is cut and reported, and it is listed as recovered. Export downloads the file. Browsers without
the file system keep sessions in memory for the life of the tab.

## Phone and PWA

The app is an installable PWA (`vite-plugin-pwa`, service worker in `sw/sw.ts`). The service worker
precaches the app shell, every lazy chunk and only the latin and latin-ext subsets of Geist and Geist
Mono, so after the first load the app opens offline. Updates never reload by themselves: an "Update
available" notice offers Reload, which stays disabled while a robot is linked and its state is not
idle, or while recording.

Below 640 px of width the tiling gives way to a single column: status, the map, two values, the
commands, a small plot and the writable labelled settings, above a STOP that is always on screen. It
is drawn from the package's roles, presets and labels (`src/app/phone/phone-plan.ts`), so a robot with
no package gets its first streamed numbers and its commands.

The Pages workflow (`.github/workflows/pages.yml`) runs on `main`: lint, typecheck, tests, a build with
`BASE_PATH=/<repository>/`, then the deploy. Build with another base by setting `BASE_PATH`.

### Testing on an Android phone over Bluetooth

Web Bluetooth needs Chrome on Android (iOS has none) and a secure context, so use the deployed HTTPS
page, or the build served through USB debugging.

1. On the phone, open the deployed page in Chrome, wait for it to load once, and use the menu's
   "Install app" (or "Add to Home screen"). Open it from the new icon.
2. Turn airplane mode on, then Bluetooth back on, and open the app again: it must load offline.
3. Turn the robot on and tap the connection pill, choose Bluetooth and Connect. Chrome asks for the
   robot; pick it. The status card must show the robot, the state and the battery.
4. Check that the map, the two values and the plot move, that a command (Explore from idle) is
   accepted, and that STOP stops the robot from the bar at the bottom, also while the page is scrolled.
5. Lock and unlock the phone during a run and check that the link recovers or says why not.
6. Push a new build with the robot linked and not idle: "Update available" must show with Reload
   disabled; stop the robot and Reload must work.

Without Pages: `bun run build && bun run preview --host`, `adb reverse tcp:4173 tcp:4173`, then open
`http://localhost:4173` in the phone's Chrome (localhost counts as secure). The service worker only
runs in the production build.

## Accessibility

The tiled windows are regions named by their titles, and Tab reaches them in screen order (top-left
to bottom-right), then the gaps between them, which are keyboard splitters (`role="separator"` with
`aria-valuenow/min/max`), then the floating windows. One polite live region announces connection
changes, robot state changes, command refusals with their reason, recording start and stop and a
window that failed to load; an assertive one announces what STOP came to. Samples are never
announced. The drawer, the launcher and the dialogs keep Tab inside them and give the focus back to
where it came from on Escape. Motion stops under `prefers-reduced-motion`. The text tokens meet
WCAG AA in both themes (`tests/app/state/theme-contrast.test.tsx` checks every pair), and axe runs in
the browser tests over the workspace, the phone view and the open dialogs.

## Architecture

The app is a single package. Folders are layers, and `no-restricted-imports` rules in `.oxlintrc.json`
keep their dependencies pointing one way.

| Path              | Layer                                                                                                                                 | May import                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `src/protocol/`   | COBS, frames, message layouts and value codecs                                                                                        | nothing else in the monitor      |
| `src/link/`       | Transports, the session and the stream planner                                                                                        | `protocol`                       |
| `src/telemetry/`  | Session store, history, decimation and recording format                                                                               | types of `protocol`              |
| `src/tiling/`     | Tiling window engine, no DOM                                                                                                          | nothing else in the monitor      |
| `src/robot-kit/`  | Contracts for robot packages and the helpers that read them                                                                           | `protocol`                       |
| `src/lazy/`       | Idle and retrying dynamic imports                                                                                                     | nothing else in the monitor      |
| `src/app/`        | React: shell, windows, sessions, phone view, theme                                                                                    | every layer above                |
| `robots/<robot>/` | Robot packages: types, views, commands, presets                                                                                       | `robot-kit`, React for the views |
| `scripts/`        | Simulated robot, live checks, bench and bundle size                                                                                   | `protocol`, `link`, `telemetry`  |
| `tests/`          | Every test, mirroring `src/`, `robots/` and `scripts/`; `tests/support/` holds their fixtures and helpers, `tests/e2e/` the PWA check | everything                       |

Only `src/app/` and the `src/main.tsx` entry point may import React. `src/main.tsx` is the composition
root: it is the only file that imports the robot packages, and it hands them to the app, so nothing
else in `src/` depends on `robots/`. Aliases: `@/…` for `src/…` and `@robots/…` for `robots/…`. Inside
`src/app/`, the UI reaches the robot through the ports in `src/app/ports/` (connection, schema,
values, history, commands, reads, writes, log), which `src/app/live/` implements over the link and
`src/app/fake/` over an in-memory robot. File names are kebab-case throughout.

The frame vectors in `tests/support/protocol/` are the bytes the firmware's own codec produces
(`tests/host/test_frame.cpp` in the firmware); a change to the wire format changes both together.

## Adding a robot package

A package is plain data (`RobotPackage`, `src/robot-kit/types.ts`) that tells the generic UI what
the schema cannot: labels, units, roles, commands, refusal reasons, layouts and how to draw a
serialized type. The monitor picks it by the name in HELLO_ACK (`id`), or, for firmware that sends
none, by the set of variable names in `signature`. Without a package everything still works raw.

```ts
// robots/sumo/index.ts
import type { RobotPackage } from '@/robot-kit';

export const sumo: RobotPackage = {
  id: 'sumo',
  displayName: 'Sumo',
  signature: ['state', 'blade'],
  roles: { state: 'state', battery: 'battery' },
  variables: {
    state: {
      labels: {
        kind: 'enum',
        name: 'State',
        options: [
          { value: 0, label: 'IDLE' },
          { value: 1, label: 'FIGHT' },
        ],
      },
    },
    battery: { unit: 'V' },
  },
  types: [],
  commands: [
    { code: 0, name: 'FIGHT', label: 'Fight', acceptedIn: [0], confirm: 'Start the fight?' },
    { code: 5, name: 'STOP', label: 'Stop', acceptedIn: 'any', emergency: true },
  ],
  refusalReasons: { 1: 'not idle' },
  presets: [{ name: 'Overview', root: { window: { kind: 'robot' } } }],
};
```

Register it in `src/main.tsx` next to `micras`: `new RobotRegistry([micras, sumo])`. The UI reads
roles (`state`, `battery`, `pose.x`, `map`, `map.revision`, …) and never names, so the Robot window,
the phone view and the Commands window work as soon as the roles are set. A package for React adds
`SerializableType` entries whose `View` draws a blob such as the maze (`robots/micras/` is the full
example), and `idleStates` tells the app when the robot is at rest for updates. `validatePackage`
rejects a malformed package at registration.

## Tests and checks

| Command                   | What it does                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bun run check`           | Everything below, in order, as in CI                                                                             |
| `bun run lint`            | oxlint, type-aware, with the React Compiler and layer rules                                                      |
| `bun run format`          | Format with oxfmt (`format:check` only checks)                                                                   |
| `bun run typecheck`       | `tsc -b` over the app, scripts, tests and config projects                                                        |
| `bun run test`            | Unit (Node) and browser (Playwright Chromium) tests; `test:e2e` runs on its own                                  |
| `bun run test:unit`       | Only the unit tests                                                                                              |
| `bun run test:browser`    | Only the browser tests                                                                                           |
| `bun run test:e2e`        | Builds the app and checks the PWA in Chromium (about 20 s)                                                       |
| `bun run test:watch`      | Vitest in watch mode                                                                                             |
| `bun run build`           | Typecheck and build into `dist/`; `bun run preview` serves it                                                    |
| `bun run size`            | Gzipped size of the bundle against its target (reports, does not fail)                                           |
| `bun run bench:telemetry` | Memory and query times of the telemetry store at full size                                                       |
| `bun run check:live`      | Streams a live robot's variables through a session and prints what the link did (manual)                         |
| `bun run check:sim`       | Follows an exploration of Micras in the simulation through the app (manual)                                      |
| `bun run check:recording` | Records a long session, kills the tab and checks the recovery (manual)                                           |
| `bun run bench`           | Frame budget of 8 plots against the stored baseline (`scripts/bench-baseline.json`); `--record` stores a new one |

`bun run bench` is not part of `check`: it fails when the p95 frame of eight plots passes 8 ms or
when a time passes 1.5 times the baseline plus 0.5 ms. On CI, `.github/workflows/bench.yml` runs on
pull requests and pushes to `main` and compares only relative regression: the same runner measures
the base and the head twice each (`--no-budgets --output`), and `scripts/bench-diff.ts` compares the best
of each side. Tests run one project after another with capped parallelism (`vite.config.ts`), so
`check` takes about a minute and 2.5 GB; run only one suite at a time.

### Manual checks

These need a running simulation and are not part of CI.

`bun run check:live --url ws://localhost:8080` connects a session to a live robot, such
as the simulation's monitor bridge (`just micras serve`), streams a few variables for five seconds
and prints what the link did.

`bun run check:sim --robot ws://localhost:8080 [--screens <dir>]` follows a whole
exploration of Micras in the simulation through the app itself: it serves the app with Vite, opens it
headless at `?connect=…` and reads what the windows show. It sends EXPLORE from IDLE, checks that SAVE
during the run is refused as not idle, that every change of the maze follows a new `maze/revision`,
and that the Robot window's timeline is the robot's `state …` log. Then it explores again and presses
Space, and checks that STOP goes through BRAKE to IDLE and that the robot rests: under 5 mm in 2 s,
under 0.01 m/s, in the cell it was stopped in or the next one, with the map unchanged. With
`--screens` it saves the maze window during and after the search, dark and light. It needs a run
that stays up after the search (such as `explore_link` without its `[[events]]` and its `[stop]`) and
`--monitor`, and a dev tree nobody edits meanwhile.

`bun run check:recording --robot ws://localhost:8080 [--minutes 30] [--kill-at 15]
[--memory-cap-mb <n>] [--view-cap-mb <n>] [--screens <dir>]` records a long session through the app,
kills the browser with SIGKILL at `--kill-at` minutes, reopens it on the same profile and checks that
the recording is recovered with at most the last 5 s lost, then opens it, shows the whole history and
scrolls through it while a second recording runs to `--minutes`. It prints the size, samples,
recovered range and timings.
