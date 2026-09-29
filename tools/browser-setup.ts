/**
 * Starts a simulated robot for the browser tests, which cannot open a server of their own, and
 * hands them its port as `simulatedRobotPort`.
 *
 * @module
 */

import type { TestProject } from 'vitest/node';

import { startSimulatedRobot } from './simulated-robot/server';

declare module 'vitest' {
  interface ProvidedContext {
    simulatedRobotPort: number;
  }
}

/** Starts the robot and returns what stops it once the tests are done. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const robot = await startSimulatedRobot({ port: 0 });
  project.provide('simulatedRobotPort', robot.port);
  return () => robot.close();
}
