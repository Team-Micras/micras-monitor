/**
 * What the shell says after it sends a command, from a pinned button or a key: sent and waiting,
 * the robot's answer, or that there is no robot to send it to.
 *
 * @module
 */

import type { CommandOutcome } from '@/core/source';
import { refusalReason, type CommandSpec, type RobotPackage } from '@/robot-kit';

/** How a notice about a command reads: fine, a warning, or an error. */
export type CommandTone = 'pending' | 'ok' | 'warning' | 'error';

/** A notice about a command, as the shell shows it under its pinned buttons. */
export interface CommandNotice {
  /** Grows with every press, so a late answer does not replace a newer notice. */
  readonly id: number;
  readonly tone: CommandTone;
  readonly text: string;
}

/** The notice for a press of a command's key or button with no robot whose package has it. */
export function noRobotFor(id: number, command: CommandSpec): CommandNotice {
  return { id, tone: 'warning', text: `No robot to send ${command.label} to` };
}

/** The notice for a command sent and not answered yet. */
export function commandSent(id: number, command: CommandSpec): CommandNotice {
  return { id, tone: 'pending', text: `${command.label} sent…` };
}

function reasonText(pkg: RobotPackage | null, reason: number | null): string {
  if (reason === null || reason === 0) {
    return '';
  }

  return `: ${refusalReason(pkg, reason) ?? `reason ${reason}`}`;
}

/**
 * The notice for the robot's answer to a command, with the reason in the package's words when it
 * deferred or refused.
 */
export function commandAnswered(
  id: number,
  command: CommandSpec,
  pkg: RobotPackage | null,
  outcome: CommandOutcome
): CommandNotice {
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
