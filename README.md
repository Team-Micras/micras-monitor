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
| `bun run test`         | Run every Vitest project once                               |
| `bun run test:unit`    | Only the unit tests (Node)                                  |
| `bun run test:browser` | Only the browser tests (Playwright Chromium)                |
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
