import {
  ChevronDownIcon,
  CircleIcon,
  DownloadIcon,
  FolderOpenIcon,
  RotateCcwIcon,
  SquareIcon,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ComponentProps } from 'react';

import { lazyWithRetry } from '@/lazy/lazy-with-retry';

import { Button } from '../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Separator } from '../components/ui/separator';
import { formatBytes, formatDuration } from '../lib/format';
import { LazyPart } from '../lib/lazy-part';
import { useEver } from '../lib/use-ever';
import { cn } from '../lib/utils';
import { useMonitor } from '../monitor-context';
import { MemoryNotice } from './memory-notice';
import { RecoveryNotice } from './recovery-notice';
import { downloadSession } from './download';
import type { SessionManager } from './session-manager';
import { useSessionManager, useSessions, useStoreStatus } from './sessions-context';

const LazySessionsDialog = lazyWithRetry(() =>
  import('./sessions-dialog').then((module) => ({ default: module.SessionsDialog }))
).Component;

const LazyResetDialog = lazyWithRetry(() =>
  import('./reset-dialog').then((module) => ({ default: module.ResetDialog }))
).Component;

const TICK_MS = 500;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

const noStatus = () => () => undefined;
const noMemory = () => 0;

function useLiveMemory(manager: SessionManager | null): number {
  return useSyncExternalStore(
    manager === null ? noStatus : (listener) => manager.live.subscribeStatus(listener),
    manager === null ? noMemory : () => manager.live.status().usedBytes
  );
}

function MemoryLine({ manager }: { readonly manager: SessionManager }) {
  const status = useStoreStatus(manager.live);
  const onDisk =
    status.evictedBlocks > 0 ? ` · ${status.evictedBlocks} blocks only in the file` : '';
  return (
    <p
      data-memory-used={status.usedBytes}
      data-evicted-blocks={status.evictedBlocks}
      className="px-2 pb-1.5 font-mono text-xs text-muted-foreground tabular-nums"
    >
      {formatBytes(status.usedBytes)} of {formatBytes(status.capBytes)} in memory{onDisk}
      {status.historyStopped ? ' · history paused at the cap' : ''}
    </p>
  );
}

function LiveSpan() {
  const { history } = useMonitor().ports;
  const range = history.timeRange();
  return formatDuration(range ? (range.endUs - range.startUs) / 1000 : 0);
}

/**
 * The recording controls of the top bar: REC with how long and how much it recorded, and a menu
 * to start and stop it, list the saved sessions, export the recording and reset the live session.
 */
export function RecordingControls() {
  const manager = useSessionManager();
  const state = useSessions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const sessionsWanted = useEver(sessionsOpen);
  const resetWanted = useEver(confirmReset);
  const recording = state?.recording ?? null;
  const now = useNow(recording !== null);
  const memory = useLiveMemory(manager);

  if (manager === null || state === null) {
    return null;
  }

  const elapsedMs = recording === null ? 0 : now - recording.startedAtMs;
  const last = recording?.session.id ?? state.liveSources.at(-1) ?? null;
  const choose = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="h-9 gap-2 rounded-lg pr-2.5 pl-3"
            aria-label={recording === null ? 'Recording, off' : 'Recording, on'}
            data-rec={recording === null ? 'off' : 'on'}
            data-elapsed-ms={Math.round(elapsedMs)}
            data-recorded-bytes={recording?.stats.bytes ?? 0}
            data-recorded-samples={recording?.stats.samples ?? 0}
            data-memory-used={memory}
          >
            <span
              aria-hidden
              className={cn(
                'size-1.5 rounded-full',
                recording === null
                  ? 'bg-muted-foreground'
                  : recording.stats.failing
                    ? 'bg-amber-500'
                    : 'animate-pulse bg-destructive'
              )}
            />
            <span className="text-xs font-semibold tracking-wide">REC</span>
            {recording === null ? null : (
              <span className="font-mono tabular-nums">{formatDuration(elapsedMs)}</span>
            )}
            <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-72 flex-col p-1" aria-label="Session">
          <div className="flex items-baseline justify-between gap-3 px-2 pt-1.5 pb-1 text-sm font-medium">
            <span>{recording === null ? 'Live session' : 'Recording'}</span>
            <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
              {recording === null ? (
                <>
                  <LiveSpan /> in memory
                </>
              ) : (
                `${formatDuration(elapsedMs)} · ${formatBytes(recording.stats.bytes)}`
              )}
            </span>
          </div>
          <MemoryLine manager={manager} />
          {state.error === null ? null : (
            <p role="alert" className="px-2 pb-1.5 text-xs text-destructive">
              {state.error}
            </p>
          )}
          {recording === null ? (
            <MenuButton onClick={choose(() => void manager.startRecording())}>
              <CircleIcon className="fill-destructive text-destructive" />
              Start recording
            </MenuButton>
          ) : (
            <MenuButton onClick={choose(() => void manager.stopRecording())}>
              <SquareIcon />
              Stop recording
            </MenuButton>
          )}
          <MenuButton onClick={choose(() => setSessionsOpen(true))}>
            <FolderOpenIcon />
            Sessions…
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {state.sessions.length}
            </span>
          </MenuButton>
          <MenuButton
            disabled={last === null}
            onClick={choose(() => {
              if (last !== null) {
                void downloadSession(manager, last);
              }
            })}
          >
            <DownloadIcon />
            Export the recording
          </MenuButton>
          <Separator className="my-1" />
          <MenuButton destructive onClick={choose(() => setConfirmReset(true))}>
            <RotateCcwIcon />
            Reset the live session…
          </MenuButton>
        </PopoverContent>
      </Popover>
      {resetWanted ? (
        <LazyPart fallback={null} resetKey={confirmReset} retryOnMount>
          <LazyResetDialog
            open={confirmReset}
            onOpenChange={setConfirmReset}
            manager={manager}
            recording={recording !== null}
          />
        </LazyPart>
      ) : null}
      {sessionsWanted ? (
        <LazyPart fallback={null} resetKey={sessionsOpen} retryOnMount>
          <LazySessionsDialog open={sessionsOpen} onOpenChange={setSessionsOpen} />
        </LazyPart>
      ) : null}
      <div className="pointer-events-none fixed bottom-14 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        <MemoryNotice />
        <RecoveryNotice onOpenList={() => setSessionsOpen(true)} />
      </div>
    </>
  );
}

function MenuButton({
  destructive = false,
  className,
  ...props
}: ComponentProps<'button'> & { readonly destructive?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none select-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        destructive
          ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10'
          : '[&_svg:not([class*=text-])]:text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}
