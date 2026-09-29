# Micras Monitor

A browser monitor for robots that speak the `micras_comm` protocol. It connects over Bluetooth LE
or over a WebSocket bridge to the simulation, learns the robot from its schema, and shows live
variables, the maze and robot commands. It is being rebuilt; this tree is the foundation (toolchain,
wire layer and an empty app shell).

## Requirements

- [Bun](https://bun.sh) 1.4 (package manager and scripts)
- Node.js 22.12 or later (Vite and Vitest run on it)
- A Chromium-based browser (Chrome, Edge) for Web Bluetooth; Firefox and Safari do not implement it
- Playwright's Chromium for the browser tests: `bunx playwright install chromium`

## Commands

| Command                | What it does                                                |
| ---------------------- | ----------------------------------------------------------- |
| `bun install`          | Install the exact versions in `bun.lock`                    |
| `bun run dev`          | Start the development server                                |
| `bun run build`        | Typecheck every project and build the app into `dist/`      |
| `bun run preview`      | Serve the production build                                  |
| `bun run typecheck`    | `tsc -b` over the app, tools and config projects            |
| `bun run lint`         | oxlint, type-aware, with the React Compiler and layer rules |
| `bun run format`       | Format with oxfmt                                           |
| `bun run format:check` | Check formatting without writing                            |
| `bun run test`         | Unit and browser tests once (`test:e2e` runs on its own)    |
| `bun run test:unit`    | Only the unit tests (Node)                                  |
| `bun run test:browser` | Only the browser tests (Playwright Chromium)                |
| `bun run test:e2e`     | Builds the app and checks the PWA in Chromium (about 20 s)  |
| `bun run test:watch`   | Vitest in watch mode                                        |
| `bun run simulate`     | Simulated robot on `ws://localhost:8080`                    |
| `bun run check`        | Lint, format check, typecheck, tests and build, as in CI    |

The simulated robot listens on `MICRAS_SIM_PORT` when it is set. Flags shape its link and inject
faults, for example `bun run simulate --throughput 3000 --latency 50 --corrupt 0.02`; the header of
`tools/simulated-robot.ts` lists them all. Tests start it in-process on a free port.
The app connects to a real robot by default; `?connect=ws://localhost:8080` connects on load, and
`?fake` serves a synthetic robot from memory instead. `bun run dev` next to `bun run simulate` is
the quickest way to see live values.
`bun run bench:telemetry` measures the telemetry store's memory and query times at full size.

`bun tools/check-live-session.ts --url ws://localhost:8080` connects a session to a live robot, such
as the simulation's monitor bridge (`just micras serve`), streams a few variables for five seconds
and prints what the link did. It is a manual check, not part of CI.

`bun tools/check-micras-sim.ts --robot ws://localhost:8080 [--screens <dir>]` follows a whole
exploration of Micras in the simulation through the app itself: it serves the app with Vite, opens
it headless at `?connect=…` and reads what the windows on screen show. It sends EXPLORE from IDLE,
checks that SAVE during the run is refused as not idle, that every change of the maze follows a new
`maze/revision`, and that the Robot window's timeline is the robot's `state …` log, SAVE included.
Then it explores again and presses Space, and checks that STOP goes through BRAKE to IDLE and that
the robot rests: under 5 mm in 2 s, under 0.01 m/s, in the cell it was stopped in or the next one,
with the map unchanged. With `--screens` it saves the maze window during and after the search, dark
and light. It needs a run that stays up after the search, such as `explore_link` without its
`[[events]]` and its `[stop]` (the robot left idle in the start cell) and `--monitor`, and a dev tree
nobody edits meanwhile (Vite reloads the page). Also a manual check, not CI.

`bun tools/check-recording.ts --robot ws://localhost:8080 [--minutes 30] [--kill-at 15]
[--memory-cap-mb <n>] [--view-cap-mb <n>] [--screens <dir>]` records a long session of the
simulated robot through the app, kills the browser with SIGKILL at `--kill-at` minutes, reopens it
on the same profile and checks that the recording is recovered with at most the last 5 s lost,
then opens it, shows the whole history and scrolls through it while a second recording runs to
`--minutes`. It prints the size, samples, recovered range and timings. A manual check, not CI.

## Sessions and recording

The live session is the telemetry store of the running app, always in memory; the link feeds it
for the life of the tab, across reconnections. REC writes it to a session file in the browser's
Origin Private File System: the whole session so far first, then every block as it seals, and the
block being filled every 5 s, so a tab that dies loses at most the last 5 s. Stopping ends the
file; Reset forgets the live history, and ends the recording first. `?memory-cap-mb=<n>` caps the
stores' memory, and `?view-cap-mb=<n>` that of an opened session alone; past the cap, blocks
already written leave memory and are read back from the file when a plot scrolls to them, and
without REC the oldest history is dropped as a `not-stored` band.

A saved session opens read only, in the same windows, into a store of its own whose blocks come
back from its file as needed. The link and the live store carry on underneath, REC keeps
recording, and STOP in the top bar still reaches the robot; the windows' own commands, writes and
reads are off until **Live** goes back to the live session.

Each session is a directory `micras-monitor/sessions/<id>/` with `session.json`, its description,
and `recording.mmrec`, the recording format (version 1, `src/telemetry/recording.ts`). A dedicated
worker (`src/app/sessions/opfs.worker.ts`) owns the files and appends through synchronous access
handles, each write flushed before it is acknowledged. The tab recording a session holds a Web Lock
on it; on start, a session still marked `recording` whose lock nobody holds was cut short: its
damaged tail, if any, is cut from the file and reported, and it is listed as recovered. Export
downloads the file with its current name in the header. Browsers without the file system keep
sessions in memory for the life of the tab.
## Phone and PWA

The app is an installable PWA (`vite-plugin-pwa`, service worker in `sw/sw.ts`). The service worker
precaches the app shell, every lazy chunk (windows, maze view, launcher, drawer, dialogs) and only the
latin and latin-ext subsets of Geist and Geist Mono, so after the first load the app opens offline.
Updates never reload by themselves: an "Update available" notice offers Reload, which stays disabled
while a robot is linked and its state is not idle.

Below 640 px of width the tiling gives way to a single column for the phone: status, the map, two
values, the commands, a small plot and the writable labelled settings, above a STOP that is always on
screen. It is drawn from the robot package's roles, presets and labels (`src/app/phone/phone-plan.ts`),
so a robot with no package gets its first streamed numbers and its commands.

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

## Layout

The app is a single package. Folders are layers, and `no-restricted-imports` rules in `.oxlintrc.json`
keep their dependencies pointing one way; each planned layer gets its rule when its folder lands.

| Path              | Layer                                                     | May import                       |
| ----------------- | --------------------------------------------------------- | -------------------------------- |
| `src/protocol/`   | COBS, frames, message layouts and value codecs            | nothing else in the monitor      |
| `src/link/`       | Transports, the session and the stream planner            | `protocol`                       |
| `src/telemetry/`  | Session store, history, decimation and recording format   | types of `protocol`              |
| `src/tiling/`     | Tiling window engine, no DOM                              | nothing else in the monitor      |
| `src/robot-kit/`  | Contracts for robot packages (planned)                    | `protocol`                       |
| `src/app/`        | React: shell, windows, theme                              | every layer above                |
| `robots/<robot>/` | Robot packages: types, views, commands, presets (planned) | `robot-kit`, React for the views |
| `tools/`          | Simulated robot, live check, bench and their tests        | `protocol`, `link`, `telemetry`  |

Only `src/app/` and the `src/main.tsx` entry point may import React. `src/main.tsx` is the composition
root: it is the only file that imports the robot packages, and it hands them to the app, so nothing
else in `src/` depends on `robots/`. Aliases: `@/…` for `src/…` and `@robots/…` for `robots/…`.

File names are kebab-case throughout, components included, as shadcn/ui names them.

The frame vectors in `src/protocol/fixtures/` are the bytes the firmware's own codec produces
(`tests/host/test_frame.cpp` in the firmware); a change to the wire format changes both together.
