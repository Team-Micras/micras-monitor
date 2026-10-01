/**
 * A live monitor over the demo robot, fast enough for tests, with what a test may change of it.
 *
 * @module
 */

import type { ReactNode } from 'react';

import { PackageChooser, type AppMonitor, type MonitorScope } from '@/app/monitor-context';
import { Monitor } from '@/core/monitor';
import { RobotRegistry, type RobotPackage } from '@/core/robot';
import { DEMO_ROBOT } from '@/sources/demo/demo-robot';
import { DemoSource, type DemoOptions, type DemoRobot } from '@/sources/demo/demo-source';
import { HistoryStore, type Scheduler } from '@/history';

import { scripted, type Script } from './scripted-source';

/** What a test may change of the demo monitor. */
export interface DemoMonitorOptions extends DemoOptions, Script {
  /** Parts of the demo robot to replace, such as how it answers. */
  readonly robot?: Partial<DemoRobot>;
  /** When the history tells its readers about changes; the next frame by default. */
  readonly scheduler?: Scheduler;
}

const FRAME_SCHEDULER: Scheduler = {
  schedule: (task) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => task());
    } else {
      setTimeout(task, 16);
    }
  },
};

/** The URL tests connect the demo robot at; it goes nowhere. */
export const DEMO_TARGET = { transport: 'websocket', url: 'ws://robot' } as const;

/**
 * A live monitor over the demo robot, answering in 5 ms unless told otherwise. It is not
 * connected; connect it at {@link DEMO_TARGET}.
 */
export function demoMonitor(options: DemoMonitorOptions = {}): AppMonitor {
  const { robot, scheduler, answerMs = 5, sampleRateHz, now, ...script } = options;
  const source = new DemoSource({ ...DEMO_ROBOT, ...robot }, { answerMs, sampleRateHz, now });
  return new Monitor({
    history: new HistoryStore({ scheduler: scheduler ?? FRAME_SCHEDULER }),
    source: scripted(source, script),
  });
}

/** What the app shows from, for a test that mounts parts of it without the app: one live monitor. */
export function monitorScope(
  monitor: AppMonitor,
  packages: readonly RobotPackage<ReactNode>[]
): MonitorScope {
  return {
    live: monitor,
    shown: monitor,
    recording: null,
    packages: new PackageChooser(new RobotRegistry(packages)),
    synthetic: true,
  };
}

/** A command script that notes the code of every command sent and lets the source answer it. */
export function recordCommands(sent: number[]): NonNullable<Script['command']> {
  return (code, argument, inner) => {
    sent.push(code);
    return inner.command(code, argument);
  };
}
