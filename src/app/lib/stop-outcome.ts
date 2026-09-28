/**
 * What the shell says after STOP: sent and waiting, the robot's answer, or that there was
 * nothing to stop.
 *
 * @module
 */

import { refusalReason, type CommandSpec, type RobotPackage } from '@/robot-kit';

import type { CommandOutcome } from '../ports';

/** How a notice about STOP reads: fine, a warning, or an error. */
export type StopTone = 'pending' | 'ok' | 'warning' | 'error';

/** A notice about STOP, as the top bar shows it under the button. */
export interface StopNotice {
  /** Grows with every press, so a late answer does not replace a newer notice. */
  readonly id: number;
  readonly tone: StopTone;
  readonly text: string;
}

/** The notice for a press with no robot or no package naming an emergency command. */
export function nothingToStop(id: number): StopNotice {
  return { id, tone: 'warning', text: 'Nothing to stop' };
}

/** The notice for a STOP sent and not answered yet. */
export function stopSent(id: number, command: CommandSpec): StopNotice {
  return { id, tone: 'pending', text: `${command.label} sent…` };
}

function reasonText(pkg: RobotPackage | null, reason: number | null): string {
  if (reason === null || reason === 0) {
    return '';
  }

  return `: ${refusalReason(pkg, reason) ?? `reason ${reason}`}`;
}

/**
 * The notice for the robot's answer to STOP, with the reason in the package's words when it
 * deferred or refused.
 */
export function stopAnswered(
  id: number,
  command: CommandSpec,
  pkg: RobotPackage | null,
  outcome: CommandOutcome
): StopNotice {
  const { label } = command;

  switch (outcome.status) {
    case 'ok':
      return { id, tone: 'ok', text: `${label} accepted` };
    case 'deferred':
      return { id, tone: 'warning', text: `${label} deferred${reasonText(pkg, outcome.reason)}` };
    case 'refused':
      return { id, tone: 'error', text: `${label} refused${reasonText(pkg, outcome.reason)}` };
    case 'unknown':
      return { id, tone: 'error', text: `${label} is unknown to the robot` };
    default:
      return { id, tone: 'error', text: `${label} failed: ${outcome.message}` };
  }
}
