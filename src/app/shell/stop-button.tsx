import { CircleXIcon } from 'lucide-react';
import { useEffect } from 'react';

import { emergencyCommand } from '@/robot-kit';

import { Kbd } from '../components/ui/kbd';
import { formatChord } from '../keymap/chords';
import type { StopNotice, StopTone } from '../lib/stop-outcome';
import { cn } from '../lib/utils';
import { useConnectionStatus, useRobotPackage } from '../monitor-context';
import { useShell, useShellStore } from '../state/shell-store';

const NOTICE_MS = 4000;

const TONE_DOTS: Readonly<Record<StopTone, string>> = {
  pending: 'bg-muted-foreground animate-pulse',
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-destructive',
};

/**
 * The emergency stop of the top bar and what its last press came to. It sends the package's
 * emergency command whenever a connection is under way, reconfiguration included, and lets
 * the answer say whether it worked; it is disabled when there is no robot or no package names
 * one.
 *
 * @param onStop Sends the stop, shared with the keyboard.
 */
export function StopButton({ onStop }: { readonly onStop: () => void }) {
  const status = useConnectionStatus();
  const stop = emergencyCommand(useRobotPackage()?.package ?? null);
  const chord = useShell((state) => state.bindings.get('stop')?.[0]);
  const notice = useShell((state) => state.stopNotice);
  const connected = status.kind !== 'disconnected' && status.kind !== 'failed';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onStop}
        disabled={!connected || stop === null}
        title={stop?.description}
        className="flex h-9 items-center gap-2 rounded-lg bg-destructive/85 pr-1.5 pl-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-destructive focus-visible:ring-[3px] focus-visible:ring-destructive/40 focus-visible:outline-none disabled:opacity-45"
      >
        <CircleXIcon className="size-4" aria-hidden />
        {stop?.label ?? 'Stop'}
        {chord === undefined ? null : (
          <Kbd className="h-6 bg-white/20 px-1.5 text-white">{formatChord(chord).join('+')}</Kbd>
        )}
      </button>
      <output aria-label="Stop outcome" className="absolute top-full right-0 z-50 mt-2">
        {notice === null ? null : <StopNoticeView notice={notice} />}
      </output>
    </div>
  );
}

function StopNoticeView({ notice }: { readonly notice: StopNotice }) {
  const store = useShellStore();
  const { id, tone, text } = notice;

  useEffect(() => {
    if (tone === 'pending') {
      return undefined;
    }

    const timer = setTimeout(() => store.getState().clearStopNotice(id), NOTICE_MS);
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
