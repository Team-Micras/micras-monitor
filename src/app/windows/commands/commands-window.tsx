import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  LoaderCircleIcon,
  XIcon,
} from 'lucide-react';
import { createElement, useState } from 'react';

import { emergencyCommand, roleVariable, type CommandSpec } from '@/robot-kit';

import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { LazyPart } from '../../lib/lazy-part';
import { useEver } from '../../lib/use-ever';
import { cn } from '../../lib/utils';
import {
  useConnectionStatus,
  useLiveValue,
  useMonitor,
  useRobotPackage,
} from '../../monitor-context';
import type { CommandOutcome } from '../../ports';
import { useAnnounce } from '../../shell/announce';
import { useStopAction } from '../../shell/stop-action';
import { useCommandTracker } from '../shared/command-tracker';
import { usePresentedVariables } from '../shared/presented-variables';
import type { WindowViewProps } from '../types';
import { commandIcon } from './command-icons';
import { LazyCommandConfirm } from './lazy-command-confirm';
import {
  commandAvailability,
  outcomeMessage,
  type CommandAvailability,
  type OutcomeMessage,
} from './command-state';

const TONE_ICONS = { ok: CircleCheckIcon, refused: CircleAlertIcon, failed: CircleXIcon } as const;

/**
 * The robot package's commands as buttons, with the emergency stop drawn big. A dangerous
 * command asks first; a button says when the robot's state is not one its table accepts it in,
 * and the robot's answer, a refusal with its reason included, shows below. The big STOP is the
 * shell's own stop, the one of the top bar and the keyboard, with its notice there; a view that
 * keeps a STOP of its own in reach, such as the phone's, hides it with `showStop`.
 */
export function CommandsWindow({
  window,
  showStop = true,
}: WindowViewProps & { readonly showStop?: boolean }) {
  const { commands } = useMonitor().ports;
  const track = useCommandTracker();
  const pkg = useRobotPackage()?.package ?? null;
  const status = useConnectionStatus();
  const stateName = roleVariable(pkg, 'state');
  const [state] = usePresentedVariables(stateName === null ? [] : [stateName]);
  const stateValue = useLiveValue(stateName)?.value;
  const [inFlight, setInFlight] = useState<ReadonlySet<number>>(new Set());
  const [answer, setAnswer] = useState<OutcomeMessage | null>(null);
  const [answers, setAnswers] = useState(0);
  const [confirming, setConfirming] = useState<CommandSpec | null>(null);
  const [asking, setAsking] = useState(false);
  const askedOnce = useEver(asking);
  const [asks, setAsks] = useState(0);
  const stop = useStopAction();
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

  const underWay = status.kind !== 'disconnected' && status.kind !== 'failed';
  const labels = state?.presentation?.labels?.kind === 'enum' ? state.presentation.labels : null;
  const emergency = emergencyCommand(pkg);
  const buttons = pkg.commands.filter((command) => command !== emergency);

  const show = (message: OutcomeMessage) => {
    setAnswer(message);
    setAnswers((count) => count + 1);

    announce(message.detail === null ? message.title : `${message.title}: ${message.detail}`);
  };

  const send = async (command: CommandSpec) => {
    setInFlight((current) => new Set(current).add(command.code));
    track(window.id, 1);
    const outcome: CommandOutcome = await commands
      .send(command.code, command.argument?.default)
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

  const confirmFailed = () => {
    setAsking(false);
    show({ tone: 'failed', title: "Couldn't open the confirmation — reload", detail: null });
  };

  const press = (command: CommandSpec) => {
    if (command.confirm === undefined) {
      void send(command);
    } else {
      setConfirming(command);
      setAsks((count) => count + 1);
      setAsking(true);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto px-5 pt-1 pb-5">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
        {buttons.map((command) => (
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
      {emergency === null || !showStop ? null : (
        <button
          type="button"
          disabled={!underWay}
          title={emergency.description}
          onClick={stop}
          className="mt-auto flex h-12 shrink-0 items-center justify-center gap-2 rounded-lg bg-stop text-base font-semibold text-stop-foreground shadow-sm transition-colors hover:brightness-90 focus-visible:ring-[3px] focus-visible:ring-stop/40 focus-visible:outline-none disabled:opacity-45"
        >
          <CircleXIcon className="size-5" aria-hidden />
          {emergency.label}
        </button>
      )}
      {askedOnce ? (
        <LazyPart fallback={null} resetKey={asks} onError={confirmFailed}>
          <LazyCommandConfirm
            open={asking}
            command={confirming}
            onOpenChange={setAsking}
            onConfirm={(command) => void send(command)}
          />
        </LazyPart>
      ) : null}
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
  const button = (
    <Button
      variant="outline"
      data-command={command.name}
      data-hint={availability.hint}
      disabled={!availability.enabled}
      className={cn(
        'h-10 justify-start pointer-coarse:h-12',
        availability.hint === 'not-accepted' && 'text-muted-foreground'
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
        <span className="grid">{button}</span>
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
