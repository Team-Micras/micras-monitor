import { createElement, useEffect } from 'react';

import type { CommandSpec } from '@/robot-kit';

import { Kbd } from '../components/ui/kbd';
import { formatChord } from '../keymap/chords';
import { commandAction } from '../keymap/keymap';
import type { CommandNotice, CommandTone } from '../lib/command-outcome';
import { cn } from '../lib/utils';
import { useLiveMonitor, useRobotPackage, useStatus } from '../monitor-context';
import { useShell, useShellStore } from '../state/shell-store';
import { commandIcon } from '../windows/commands/command-icons';
import { useSendCommand } from './send-command';

const NOTICE_MS = 4000;

const TONE_DOTS: Readonly<Record<CommandTone, string>> = {
  pending: 'bg-muted-foreground animate-pulse',
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-destructive',
};

const SIZES = {
  bar: {
    group: 'relative flex items-center gap-2',
    button: 'h-9 gap-2 rounded-lg pr-1.5 pl-3 text-sm',
    icon: 'size-4',
    notice: 'absolute top-full right-0 z-50 mt-2',
  },
  phone: {
    group: 'relative flex flex-col gap-2',
    button: 'h-16 w-full justify-center gap-3 rounded-2xl text-xl touch-manipulation',
    icon: 'size-7',
    notice: 'absolute right-0 bottom-full left-0 z-50 mb-2',
  },
} as const;

/**
 * The robot package's pinned commands, kept in reach whatever is on screen, and what the last
 * command sent from the shell came to. They stay after the robot is gone, disabled, and are sent
 * to the live robot even while a recording is shown. A dangerous one is drawn in the stop color.
 *
 * @param size `bar` for the top bar, `phone` for the bottom of the phone view.
 */
export function PinnedCommands({ size }: { readonly size: keyof typeof SIZES }) {
  const monitor = useLiveMonitor();
  const status = useStatus(monitor);
  const live = useRobotPackage(monitor)?.package ?? null;
  const commands = useShell((state) => state.commands).filter((command) => command.pinned);
  const notice = useShell((state) => state.commandNotice);
  const send = useSendCommand();
  const connected = status.kind !== 'disconnected' && status.kind !== 'failed';
  const style = SIZES[size];

  return (
    <div className={style.group}>
      {commands.map((command) => (
        <PinnedButton
          key={command.name}
          command={command}
          className={style.button}
          iconClassName={style.icon}
          withKey={size === 'bar'}
          disabled={!connected || !live?.commands.some((known) => known.name === command.name)}
          onPress={() => send(command)}
        />
      ))}
      <output aria-label="Command outcome" aria-live="off" className={style.notice}>
        {notice === null ? null : <CommandNoticeView notice={notice} />}
      </output>
    </div>
  );
}

function PinnedButton({
  command,
  className,
  iconClassName,
  withKey,
  disabled,
  onPress,
}: {
  readonly command: CommandSpec;
  readonly className: string;
  readonly iconClassName: string;
  readonly withKey: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const chord = useShell((state) => state.bindings.get(commandAction(command))?.[0]);
  const danger = command.tone === 'danger';

  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      title={command.description}
      data-command={command.name}
      className={cn(
        'flex shrink-0 items-center font-semibold shadow-sm transition-colors focus-visible:outline-none disabled:opacity-45',
        danger
          ? 'bg-stop text-stop-foreground hover:brightness-90 focus-visible:ring-[3px] focus-visible:ring-stop/40 active:brightness-90'
          : 'border bg-background hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className
      )}
    >
      {createElement(commandIcon(command.icon), { className: iconClassName, 'aria-hidden': true })}
      {command.label}
      {withKey && chord !== undefined ? (
        <Kbd className={cn('h-6 px-1.5', danger && 'bg-black/25 text-stop-foreground')}>
          {formatChord(chord).join('+')}
        </Kbd>
      ) : null}
    </button>
  );
}

/** What the last command sent from the shell came to, for a while, then it clears itself. */
function CommandNoticeView({ notice }: { readonly notice: CommandNotice }) {
  const store = useShellStore();
  const { id, tone, text } = notice;

  useEffect(() => {
    if (tone === 'pending') {
      return undefined;
    }

    const timer = setTimeout(() => store.getState().clearCommandNotice(id), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [store, id, tone]);

  return (
    <p
      data-tone={tone}
      className="flex items-center gap-2 rounded-lg border bg-popover px-3 py-1.5 text-sm whitespace-nowrap text-popover-foreground shadow-md animate-in fade-in-0 slide-in-from-top-1 duration-150"
    >
      <span className={cn('size-2 shrink-0 rounded-full', TONE_DOTS[tone])} aria-hidden />
      {text}
    </p>
  );
}
