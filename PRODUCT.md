# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Bun, Vite 8, React 19 with the React Compiler, TypeScript 7, Tailwind 4 + shadcn/ui, uPlot, oxlint + oxfmt, Vitest 4 + Playwright, and an in-house tiling engine (see the redesign plan). Distributed as an installable, offline-capable PWA on GitHub Pages (Web Bluetooth needs HTTPS).

## Users

The robotics team that builds the robots: people who write the firmware, the control and navigation code, and who debug the hardware. They are technical, but they want a calm, uncluttered tool: little on screen at once, spread across workspaces, never a trading-terminal wall of numbers. One person uses it at a time, connected to one robot at a time. The team also shows the robot to others through it, so it should look good, but there is no separate presentation mode.

## Product Purpose

Micras Monitor lets the team see, record and steer a robot while it runs, over the robot's radio link (Bluetooth LE UART) or over a WebSocket bridge to the MuJoCo simulation. It exists because debugging a fast robot by LEDs, a scope and reflashing is slow; success is a team member connecting to any robot and understanding what it is doing in seconds, without writing code for the monitor.

## Positioning

The monitor is not tied to Micras. It speaks the team's own link protocol (`micras_comm`: COBS frames, handshake, paged schema, sampled variable groups, credit flow control, writes, reads, commands, logs), so any robot built on that stack can use it. A robot the monitor has never seen is described by its schema (variable names, types, access flags); the monitor builds a first layout from that alone. Robot-specific knowledge (composite serializable types and how each is drawn, enum and bitmask labels, the command list, units, layout presets) lives in a per-robot package inside the monitor, never in the generic core.

## Operating Context

- **Bench, real robot:** the robot on the table or the floor, connected over Bluetooth; debugging hardware, sensors, control and localization.
- **Simulation:** runs of the MuJoCo harness (`micras-simulation`, `just micras serve`) reached through its WebSocket bridge, which carries the same bytes as the radio. The simulation is treated as just another robot for now.
- **Competition:** in the pit or at the maze, often without internet, on a laptop or a phone; checking the robot before a run, starting exploration or the fast run, watching the map.
- **Later analysis:** reopening recorded sessions to investigate a run calmly.

## Capabilities and Constraints

Confirmed requirements:

- Live time-series plots of any streamed variable, with pause and scrolling back in time; must stay fast for a whole session (the previous Plotly chart froze after minutes).
- The whole session is kept and can be recorded, reset, saved locally and exported.
- A free, fully customizable workspace: drag variables onto panels, resize, save layouts; editable presets; an automatic first layout from the schema of an unknown robot (monitoring-only variables, writable ones, etc.), cached per robot.
- Variable browser built from the schema; writable variables get editors derived from their type (a writable bool becomes a switch, and so on).
- Composite serializable types: every serializable type the firmware publishes has an equivalent class in the monitor that decodes it and provides a view (the component that displays it). The maze is one such type and its view draws the maze.
- Commands to the robot, kept generic: the core knows only the protocol's command mechanism and its results (OK, UNKNOWN, REFUSED); the robot package names the commands and marks which need confirmation. Any command can be placed in the workspace as a button whose size, colour and position are configurable; an emergency STOP is simply a robot command shown as a big button (MAVLink precedent: termination is an ordinary command, not a protocol message). Refused commands are shown with their reason. Micras gains STOP and a remote way out of ERROR as firmware commands.
- The robot's state machine visible as a current state and a timeline of transitions.
- Link health visible (connection, drops, credit).
- Mobile/tablet: a reduced version (status, commands, run profile, maze, battery, a few values and plots); the full workspace is for the laptop.
- Transports: Web Bluetooth (Chromium only: Firefox has no Web Bluetooth, Safari neither) and WebSocket (all browsers). Web Serial was considered and rejected: the team never talks to the robot over serial.

Constraints:

- Radio: 115200 baud, about 11.5 KB/s, roughly 100–150 samples/s in total across all groups; 4 groups of up to 16 variables; 200-byte payloads; 256-byte credit window. The monitor must choose what to stream within that budget.
- Live data only for now: no full-rate (8 kHz) capture.
- One active connection at a time.
- The firmware and the protocol are still in development and may change when that makes the monitor simpler or better (for example: a type tag for blobs, a robot id, the FSM state as a variable plus transition events, new commands such as STOP and leaving ERROR).

Deferred (next steps, not in the first version):

- Tuning parameters (gains) from the UI: the firmware exposes none as writable today.
- Opening simulation runs (`data.csv` + `meta.json`), comparing runs, CSV export.
- A side channel from the simulation (ground truth, true maze, collisions, pause/step/speed).

## Brand Commitments

Visual constraint stated by the owner: modern and clean, close to shadcn/ui vanilla; panels are windows with frames and titles separated by generous gaps, like a tiling window manager, not flush splitters. Themed worlds (instrument panel, technical drawing) were tried and rejected.

Name: "Micras Monitor". Existing logo: `public/micras_monitor_logo.svg` (dark #282a36 with light #f8f8f2 strokes). Team: Team Micras. License: MIT.

## Evidence on Hand

- Real robot schema: 68 variables from the Micras firmware (`micras-simulation/targets/micras/MicrasFirmware`, `src/micras.cpp:64-153`), five commands (EXPLORE, SOLVE, CALIBRATE, SAVE, RESET), a 131-byte maze blob.
- A simulated robot for development: `scripts/simulated-robot.ts` (`bun run simulate`).
- The MuJoCo harness bridge on `ws://localhost:8080`.
- Audit of the current code: `.omc/research/audit-2026-09-27.md`.
- No users outside the team, no testimonials, no metrics; none to be invented.

## Product Principles

1. Generic core, robot knowledge in packages: nothing Micras-specific leaks into the core.
2. The schema is the source of truth: an unknown robot is usable on first connection, with zero configuration.
3. Never lie about the robot: show what the robot confirmed (acknowledged writes, refused commands, dropped samples), not what the UI hoped.
4. Fast for the whole session: cost follows what is on screen, never the length of the history.
5. Safe by default when a robot is moving: dangerous actions are confirmed, STOP is always one tap away.
