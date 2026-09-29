/**
 * The transitions of the state as the robot logs them, with its own timestamps, completed by the
 * sampled history where the log says nothing: before its first line, and where lines were lost.
 *
 * @module
 */

import type { LogEntry } from '../../ports';
import type { Transition } from './transitions';

/** Reads a log line as the state it reports entering, or null for any other line. */
export type StateLogReader = (text: string) => number | null;

/** The transitions the robot's log lines report, oldest first, each a change of state. */
export function loggedTransitions(
  entries: readonly LogEntry[],
  read: StateLogReader
): readonly Transition[] {
  const transitions: Transition[] = [];

  for (const entry of entries) {
    if (entry.source !== 'robot' || entry.timeUs === undefined) {
      continue;
    }

    const value = read(entry.text);

    if (value !== null && value !== transitions.at(-1)?.value) {
      transitions.push({ value, timeUs: entry.timeUs });
    }
  }

  return transitions;
}

function loggedStateAt(logged: readonly Transition[], timeUs: number): number | undefined {
  let state: number | undefined;

  for (const transition of logged) {
    if (transition.timeUs > timeUs) {
      break;
    }

    state = transition.value;
  }

  return state;
}

/**
 * The logged transitions, and the sampled ones the log does not explain: a sampled change to a
 * value is explained when the log has the robot in that value at the sample's time. What is left
 * are the changes before the first line kept and those whose line was lost, as when the robot
 * drops log lines. Oldest first, with repeats of a value collapsed.
 */
export function mergeTransitions(
  logged: readonly Transition[],
  sampled: readonly Transition[]
): readonly Transition[] {
  const unexplained = sampled.filter(
    (transition) => loggedStateAt(logged, transition.timeUs) !== transition.value
  );

  if (unexplained.length === 0) {
    return logged;
  }

  return [...logged, ...unexplained]
    .toSorted((a, b) => a.timeUs - b.timeUs)
    .filter((transition, index, all) => transition.value !== all[index - 1]?.value);
}
