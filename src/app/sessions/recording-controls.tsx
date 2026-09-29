import {
  ChevronDownIcon,
  CircleIcon,
  DownloadIcon,
  FolderOpenIcon,
  RotateCcwIcon,
  SquareIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { lazyWithRetry } from '@/lazy/lazy-with-retry';

import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { formatBytes, formatDuration } from '../lib/format';
import { LazyPart } from '../lib/lazy-part';
import { useEver } from '../lib/use-ever';
import { cn } from '../lib/utils';
import { useMonitor } from '../monitor-context';
import { RecoveryNotice } from './recovery-notice';
import { downloadSession } from './download';
import type { SessionManager } from './session-manager';
import { useSessionManager, useSessions, useStoreStatus } from './sessions-context';

const LazySessionsDialog = lazyWithRetry(() =>
  import('./sessions-dialog').then((module) => ({ default: module.SessionsDialog }))
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

function MemoryLine({ manager }: { readonly manager: SessionManager }) {
  const status = useStoreStatus(manager.live);
  const onDisk =
    status.evictedBlocks > 0 ? ` · ${status.evictedBlocks} blocks read back from disk` : '';
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
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const sessionsWanted = useEver(sessionsOpen);
  const recording = state?.recording ?? null;
  const now = useNow(recording !== null);

  if (manager === null || state === null) {
    return null;
  }

  const elapsedMs = recording === null ? 0 : now - recording.startedAtMs;
  const last = recording?.session.id ?? state.liveSources.at(-1) ?? null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="h-9 gap-2 rounded-lg pr-2.5 pl-3"
            aria-label={recording === null ? 'Recording, off' : 'Recording, on'}
            data-rec={recording === null ? 'off' : 'on'}
            data-elapsed-ms={Math.round(elapsedMs)}
            data-recorded-bytes={recording?.stats.bytes ?? 0}
            data-recorded-samples={recording?.stats.samples ?? 0}
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
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="flex items-baseline justify-between gap-3">
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
          </DropdownMenuLabel>
          <MemoryLine manager={manager} />
          {state.error === null ? null : (
            <p role="alert" className="px-2 pb-1.5 text-xs text-destructive">
              {state.error}
            </p>
          )}
          {recording === null ? (
            <DropdownMenuItem onSelect={() => void manager.startRecording()}>
              <CircleIcon className="fill-destructive text-destructive!" />
              Start recording
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void manager.stopRecording()}>
              <SquareIcon />
              Stop recording
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setSessionsOpen(true)}>
            <FolderOpenIcon />
            Sessions…
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {state.sessions.length}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={last === null}
            onSelect={() => {
              if (last !== null) {
                void downloadSession(manager, last);
              }
            }}
          >
            <DownloadIcon />
            Export the recording
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmReset(true)}>
            <RotateCcwIcon />
            Reset the live session…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ResetDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        manager={manager}
        recording={recording !== null}
      />
      {sessionsWanted ? (
        <LazyPart fallback={null} resetKey={sessionsOpen} retryOnMount>
          <LazySessionsDialog open={sessionsOpen} onOpenChange={setSessionsOpen} />
        </LazyPart>
      ) : null}
      <RecoveryNotice onOpenList={() => setSessionsOpen(true)} />
    </>
  );
}

interface ResetDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly manager: SessionManager;
  readonly recording: boolean;
}

function ResetDialog({ open, onOpenChange, manager, recording }: ResetDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Reset the live session?</DialogTitle>
          <DialogDescription>
            Forgets the <LiveSpan /> of history in this tab
            {recording ? ' and ends the recording, which stays saved' : ''}. Saved sessions are
            kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              void manager.resetLive();
            }}
          >
            Reset session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
