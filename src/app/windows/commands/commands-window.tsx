import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  LoaderCircleIcon,
  XIcon,
} from 'lucide-react';
import { createElement, useState } from 'react';

import { roleVariable, type CommandSpec } from '@/core/robot';
import type { CommandOutcome } from '@/core/source';

import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { useLiveValue, useRobotPackage, useShownMonitor, useStatus } from '../../monitor-context';
import { useAnnounce } from '../../shell/announce';
import { useSendCommand } from '../../shell/send-command';
import { useCommandTracker } from '../shared/command-tracker';
import { usePresentedVariables } from '../shared/presented-variables';
import type { WindowViewProps } from '../types';
import { commandIcon } from './command-icons';
import {
  commandAvailability,
  outcomeMessage,
  type CommandAvailability,
  type OutcomeMessage,
} from './command-state';

const TONE_ICONS = { ok: CircleCheckIcon, refused: CircleAlertIcon, failed: CircleXIcon } as const;

/**
 * The robot package's commands as buttons, a dangerous one drawn big in the stop color. A command
 * with a confirmation asks first; a button says when the robot's state is not one its table
 * accepts it in, and the robot's answer, a refusal with its reason included, shows below. The
 * shell asks for every confirmation. A pinned command goes through the shell, as its button in the
 * top bar and its key do, to the live robot and with the shell's notice; a view that keeps the
 * pinned commands in reach of its own, such as the phone's, leaves them out with `showPinned`.
 */
export function CommandsWindow({
  window,
  showPinned = true,
}: WindowViewProps & { readonly showPinned?: boolean }) {
  const monitor = useShownMonitor();
  const track = useCommandTracker();
  const pkg = useRobotPackage(monitor)?.package ?? null;
  const status = useStatus(monitor);
  const stateName = roleVariable(pkg, 'state');
  const [state] = usePresentedVariables(monitor, stateName === null ? [] : [stateName]);
  const stateValue = useLiveValue(monitor, stateName)?.value;
  const [inFlight, setInFlight] = useState<ReadonlySet<number>>(new Set());
  const [answer, setAnswer] = useState<OutcomeMessage | null>(null);
  const [answers, setAnswers] = useState(0);
  const sendCommand = useSendCommand();
  const announce = useAnnounce();

  const linked = status.kind === 'linked';

  if (pkg === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {linked
          ? 'No robot package gives the commands of this robot'
          : 'Connect to a robot to send its commands'}
      </div>
    );
  }

  const labels = state?.presentation?.labels?.kind === 'enum' ? state.presentation.labels : null;
  const shown = pkg.commands.filter((command) => showPinned || command.pinned !== true);
  const ordered = [
    ...shown.filter((command) => command.tone !== 'danger'),
    ...shown.filter((command) => command.tone === 'danger'),
  ];

  const show = (message: OutcomeMessage) => {
    setAnswer(message);
    setAnswers((count) => count + 1);

    announce(message.detail === null ? message.title : `${message.title}: ${message.detail}`);
  };

  const send = async (command: CommandSpec) => {
    setInFlight((current) => new Set(current).add(command.code));
    track(window.id, 1);
    const outcome: CommandOutcome = await monitor
      .command(command.code, command.argument?.default)
      .catch((error: unknown) => ({
        status: 'failed' as const,
        message: error instanceof Error ? error.message : String(error),
      }));
    setInFlight((current) => {
      const next = new Set(current);
      next.delete(command.code);
      return next;
    });
    track(window.id, -1);
    show(outcomeMessage(command, outcome, pkg, labels));
  };

  const press = (command: CommandSpec) => {
    sendCommand(command, command.pinned === true ? undefined : (confirmed) => void send(confirmed));
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto px-5 pt-1 pb-5">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
        {ordered.map((command) => (
          <CommandButton
            key={command.code}
            command={command}
            availability={commandAvailability(command, {
              linked,
              state: typeof stateValue === 'number' ? stateValue : null,
              stateLabels: labels,
              inFlight: inFlight.has(command.code),
            })}
            waiting={inFlight.has(command.code)}
            onPress={() => press(command)}
          />
        ))}
      </div>
      {answer === null ? null : (
        <Answer message={answer} sequence={answers} onDismiss={() => setAnswer(null)} />
      )}
    </div>
  );
}

function CommandButton({
  command,
  availability,
  waiting,
  onPress,
}: {
  readonly command: CommandSpec;
  readonly availability: CommandAvailability;
  readonly waiting: boolean;
  readonly onPress: () => void;
}) {
  const danger = command.tone === 'danger';
  const button = (
    <Button
      variant="outline"
      data-command={command.name}
      data-hint={availability.hint}
      disabled={!availability.enabled}
      className={cn(
        'h-10 justify-start pointer-coarse:h-12',
        availability.hint === 'not-accepted' && 'text-muted-foreground',
        danger &&
          'col-span-full h-12 justify-center border-transparent bg-stop text-base font-semibold text-stop-foreground hover:bg-stop hover:text-stop-foreground hover:brightness-90 focus-visible:ring-stop/40'
      )}
      onClick={onPress}
    >
      {waiting ? (
        <LoaderCircleIcon className="animate-spin" aria-hidden />
      ) : (
        createElement(commandIcon(command.icon), { 'aria-hidden': true })
      )}
      {command.label}
    </Button>
  );

  if (availability.reason === null && command.description === undefined) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('grid', danger && 'col-span-full')}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{availability.reason ?? command.description}</TooltipContent>
    </Tooltip>
  );
}

function Answer({
  message,
  sequence,
  onDismiss,
}: {
  readonly message: OutcomeMessage;
  /** How many answers the window has shown, this one included. */
  readonly sequence: number;
  readonly onDismiss: () => void;
}) {
  const Icon = TONE_ICONS[message.tone];

  return (
    <div
      data-tone={message.tone}
      data-answer={sequence}
      className={cn(
        'relative flex gap-3 rounded-lg border px-4 py-3 text-sm',
        message.tone === 'ok' ? 'text-foreground' : 'border-destructive/40 text-destructive'
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex flex-col gap-0.5 pr-6">
        <span className="font-medium">{message.title}</span>
        {message.detail === null ? null : (
          <span className={cn(message.tone === 'ok' && 'text-muted-foreground')}>
            {message.detail}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        className="absolute top-2 right-2"
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  );
}
