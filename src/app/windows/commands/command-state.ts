/**
 * What the Commands window decides without React: whether a command can be sent now, what the
 * package's table hints about the robot's state, and an answer in words.
 *
 * @module
 */

import {
  acceptedIn,
  enumLabel,
  refusalReason,
  type CommandSpec,
  type EnumType,
  type RobotPackage,
} from '@/robot-kit';

import type { CommandOutcome } from '../../ports';

/** What the robot's state says about a command, per the package's mirror of the firmware table. */
export type AcceptanceHint = 'accepted' | 'not-accepted' | 'unknown';

/** Whether a command's button can be pressed, and what to tell next to it. */
export interface CommandAvailability {
  readonly enabled: boolean;
  readonly hint: AcceptanceHint;
  /** Why the button is disabled, or what the robot is expected to say; null when nothing. */
  readonly reason: string | null;
}

/** What the window knows when it lays out a command. */
export interface CommandContext {
  /** Whether the link is up. */
  readonly linked: boolean;
  /** The value of the state variable, or null when unknown. */
  readonly state: number | null;
  /** The labels of the state variable, or null. */
  readonly stateLabels: EnumType | null;
  /** Whether this command waits for its answer. */
  readonly inFlight: boolean;
}

/** How an answer reads. */
export interface OutcomeMessage {
  readonly tone: 'ok' | 'refused' | 'failed';
  readonly title: string;
  readonly detail: string | null;
}

function stateName(labels: EnumType | null, value: number): string {
  return labels === null ? String(value) : enumLabel(labels, value);
}

/** The states a command is accepted in, in words: `any state`, or their labels. */
export function acceptedStatesText(command: CommandSpec, labels: EnumType | null): string {
  return command.acceptedIn === 'any'
    ? 'any state'
    : command.acceptedIn.map((value) => stateName(labels, value)).join(', ');
}

/**
 * Whether a command can be sent. Without a link, or while it waits for its answer, it cannot;
 * otherwise it can, and the package's table only hints whether the robot will take it, since
 * the robot's answer is what counts.
 */
export function commandAvailability(
  command: CommandSpec,
  context: CommandContext
): CommandAvailability {
  const accepted = acceptedIn(command, context.state);
  const hint: AcceptanceHint =
    accepted === null ? 'unknown' : accepted ? 'accepted' : 'not-accepted';

  if (!context.linked) {
    return { enabled: false, hint, reason: 'Not connected to a robot' };
  }

  if (context.inFlight) {
    return { enabled: false, hint, reason: 'Waiting for the robot to answer' };
  }

  if (hint === 'not-accepted' && context.state !== null) {
    return {
      enabled: true,
      hint,
      reason: `Needs ${acceptedStatesText(command, context.stateLabels)}; the robot is in ${stateName(context.stateLabels, context.state)}`,
    };
  }

  return { enabled: true, hint, reason: null };
}

/** The robot's answer to a command, in words. */
export function outcomeMessage(
  command: CommandSpec,
  outcome: CommandOutcome,
  pkg: RobotPackage | null,
  stateLabels: EnumType | null = null
): OutcomeMessage {
  switch (outcome.status) {
    case 'ok':
      return { tone: 'ok', title: `${command.label} accepted`, detail: null };
    case 'deferred':
      return { tone: 'ok', title: `${command.label} deferred`, detail: 'The robot runs it later.' };
    case 'unknown':
      return {
        tone: 'refused',
        title: `${command.label} unknown to the robot`,
        detail: 'Its firmware does not have this command.',
      };
    case 'refused': {
      const reason = refusalReason(pkg, outcome.reason);
      return {
        tone: 'refused',
        title: `Refused — ${reason ?? 'no reason given'}`,
        detail: `${command.name} is accepted in ${acceptedStatesText(command, stateLabels)}.`,
      };
    }
    default:
      return { tone: 'failed', title: `${command.label} not sent`, detail: outcome.message };
  }
}
