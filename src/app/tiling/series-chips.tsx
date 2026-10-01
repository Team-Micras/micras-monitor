import { XIcon } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { WindowId } from '@/tiling';

import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { formatValue } from '../lib/format';
import { cn } from '../lib/utils';
import { useLinkUp, useLiveValue, useShownMonitor } from '../monitor-context';
import { useShellStore } from '../state/shell-store';
import { windowElementId } from './dom-ids';

/** How many series the title bar shows before the rest go behind a "+N" button. */
export const VISIBLE_SERIES = 3;

const SERIES_COLORS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'];

function colorOf(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

interface SeriesChipsProps {
  readonly window: WindowId;
  readonly title: string;
  readonly variables: readonly string[];
}

/**
 * The variables of a window in its title bar, each with its latest value, when the robot sampled
 * it in `data-time`, and a button that takes it out of the window, shown on hover and on focus;
 * Delete or Backspace on that button does the same. Past the first few, the rest sit behind a
 * "+N" button that lists them, removable too.
 */
export function SeriesChips({ window, title, variables }: SeriesChipsProps) {
  const store = useShellStore();
  const hidden = variables.slice(VISIBLE_SERIES);

  const remove = (name: string) => {
    store.getState().removeVariable(window, name);
    document.getElementById(windowElementId(window))?.focus({ preventScroll: true });
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      {variables.slice(0, VISIBLE_SERIES).map((name, index) => (
        <SeriesChip
          key={name}
          name={name}
          title={title}
          color={colorOf(index)}
          onRemove={() => remove(name)}
        />
      ))}
      {hidden.length > 0 ? (
        <Popover>
          <PopoverTrigger
            aria-label={`${hidden.length} more in ${title}`}
            className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground"
          >
            +{hidden.length}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto min-w-56 p-1">
            <ul aria-label={`More in ${title}`} className="grid gap-0.5">
              {hidden.map((name, index) => (
                <li key={name}>
                  <SeriesChip
                    name={name}
                    title={title}
                    color={colorOf(VISIBLE_SERIES + index)}
                    onRemove={() => remove(name)}
                    listed
                  />
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

interface SeriesChipProps {
  readonly name: string;
  readonly title: string;
  readonly color: string;
  readonly onRemove: () => void;
  /** Whether it sits in the overflow list, where the remove button always shows. */
  readonly listed?: boolean;
}

function SeriesChip({ name, title, color, onRemove, listed = false }: SeriesChipProps) {
  const monitor = useShownMonitor();
  const latest = useLiveValue(monitor, name);
  const value = latest?.value;
  const linked = useLinkUp(monitor);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onRemove();
    }
  };

  return (
    <span
      data-series={name}
      data-value={typeof value === 'number' ? value : undefined}
      data-time={latest?.timeUs}
      className={cn(
        'group/chip relative flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-xs',
        listed ? 'justify-between py-1 pr-1 hover:bg-muted' : 'bg-muted'
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className={cn('size-2 shrink-0 rounded-[2px]', color)} aria-hidden />
        <span className="text-muted-foreground">{name}</span>
        <span className={cn('tabular-nums', !linked && 'text-muted-foreground')}>
          {formatValue(value)}
        </span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${name} from ${title}`}
        title={`Remove ${name}`}
        onClick={onRemove}
        onKeyDown={onKeyDown}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          listed
            ? 'size-6 hover:bg-foreground/10'
            : 'absolute top-1/2 right-0.5 size-4 -translate-y-1/2 bg-muted opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100'
        )}
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </span>
  );
}
