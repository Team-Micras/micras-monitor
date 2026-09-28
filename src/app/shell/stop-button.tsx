import { CircleXIcon } from 'lucide-react';

import { emergencyCommand } from '@/robot-kit';

import { Kbd } from '../components/ui/kbd';
import { formatChord } from '../keymap/chords';
import { useConnectionStatus, useRobotPackage } from '../monitor-context';
import { useShell } from '../state/shell-store';

/**
 * The emergency stop of the top bar. It sends the package's emergency command; it is disabled
 * when there is no robot or no package names one.
 *
 * @param onStop Sends the stop, shared with the keyboard.
 */
export function StopButton({ onStop }: { readonly onStop: () => void }) {
  const streaming = useConnectionStatus().kind === 'streaming';
  const stop = emergencyCommand(useRobotPackage()?.package ?? null);
  const chord = useShell((state) => state.bindings.get('stop')?.[0]);

  return (
    <button
      type="button"
      onClick={onStop}
      disabled={!streaming || stop === null}
      title={stop?.description}
      className="flex h-9 items-center gap-2 rounded-lg bg-destructive/85 pr-1.5 pl-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-destructive focus-visible:ring-[3px] focus-visible:ring-destructive/40 focus-visible:outline-none disabled:opacity-45"
    >
      <CircleXIcon className="size-4" aria-hidden />
      {stop?.label ?? 'Stop'}
      {chord === undefined ? null : (
        <Kbd className="h-6 bg-white/20 px-1.5 text-white">{formatChord(chord).join('+')}</Kbd>
      )}
    </button>
  );
}
