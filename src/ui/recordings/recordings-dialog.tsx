import {
  CheckIcon,
  DownloadIcon,
  EyeIcon,
  HardDriveIcon,
  LoaderCircleIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { downloadRecording } from '@/recording/library/download';
import type { RecordingInfo } from '@/recording/library/recording-library';
import type { RecordingManager, RecordingsState } from '@/recording/library/recording-manager';

import { Button } from '../primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../primitives/dialog';
import { Input } from '../primitives/input';
import { cn } from '../primitives/utils';
import { describeRecovery, describeSize, describeStart, describeStorage } from './recording-text';
import { useRecordingManager, useRecordings } from './recordings-context';

interface RecordingsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The saved sessions: open one to look at it in the windows, rename, export or delete it. The one
 * being recorded and those the live session still reads from cannot be deleted.
 */
export function RecordingsDialog({ open, onOpenChange }: RecordingsDialogProps) {
  const manager = useRecordingManager();
  const state = useRecordings();
  const opened = useRef(false);

  if (manager === null || state === null) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[80svh] flex-col gap-4 sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          if (opened.current) {
            opened.current = false;
            event.preventDefault();
            document.querySelector<HTMLElement>('[data-window][data-focused="true"]')?.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Sessions</DialogTitle>
          <DialogDescription>
            Recordings kept in this browser. Opening one shows it in the windows; the robot keeps
            streaming to the live session underneath.
          </DialogDescription>
        </DialogHeader>
        {state.error === null ? null : (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <span className="flex-1">{state.error}</span>
            <Button variant="ghost" size="xs" onClick={() => manager.dismissError()}>
              Dismiss
            </Button>
          </p>
        )}
        <ul
          aria-label="Saved sessions"
          className="-mx-2 flex min-h-0 flex-col gap-1 overflow-y-auto"
        >
          {state.sessions.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">
              No sessions yet. Start recording from REC in the top bar.
            </li>
          ) : (
            state.sessions.map((session) => (
              <RecordingRow
                key={session.id}
                session={session}
                state={state}
                manager={manager}
                onOpened={() => {
                  opened.current = true;
                  onOpenChange(false);
                }}
              />
            ))
          )}
        </ul>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <HardDriveIcon className="size-3.5" aria-hidden />
          <span data-storage>{describeStorage(state.storage, state.backend)}</span>
        </p>
      </DialogContent>
    </Dialog>
  );
}

interface RecordingRowProps {
  readonly session: RecordingInfo;
  readonly state: RecordingsState;
  readonly manager: RecordingManager;
  readonly onOpened: () => void;
}

function RecordingRow({ session, state, manager, onOpened }: RecordingRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const recording = state.recording?.session.id === session.id;
  const viewing = state.viewing?.session.id === session.id;
  const opening = state.opening === session.id;
  const inUse = state.liveSources.includes(session.id) || session.state === 'recording';
  const info =
    recording && state.recording
      ? { ...session, bytes: state.recording.stats.bytes, samples: state.recording.stats.samples }
      : session;

  return (
    <li
      data-session={session.id}
      data-samples={info.samples}
      data-duration-us={info.durationUs}
      data-bytes={info.bytes}
      className={cn(
        'group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60',
        viewing && 'bg-muted'
      )}
    >
      <div className="min-w-0 flex-1">
        {renaming ? (
          <RenameField
            name={session.name}
            onDone={(name) => {
              setRenaming(false);

              if (name !== null) {
                void manager.rename(session.id, name);
              }
            }}
          />
        ) : (
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{session.name}</span>
            {recording ? (
              <span className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
                <span className="size-1.5 animate-pulse rounded-full bg-destructive" aria-hidden />
                Recording
              </span>
            ) : null}
            {session.recovery === undefined ? null : (
              <span
                title={describeRecovery({ session, recovery: session.recovery })}
                className="rounded-full border border-amber-500/40 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
              >
                Recovered
              </span>
            )}
            {viewing ? (
              <span className="rounded-full bg-foreground px-2 py-0.5 text-xs text-background">
                On screen
              </span>
            ) : null}
          </div>
        )}
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground tabular-nums">
          {describeStart(session.createdAtMs)} · {describeSize(info)}
        </p>
      </div>
      {deleting ? (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Delete?</span>
          <Button
            variant="destructive"
            size="xs"
            onClick={() => {
              setDeleting(false);
              void manager.remove(session.id);
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setDeleting(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-0.5">
          <Button
            variant="outline"
            size="sm"
            disabled={opening || viewing}
            onClick={() => {
              void manager.open(session.id).then(() => {
                if (manager.state.viewing?.session.id === session.id) {
                  onOpened();
                }
              });
            }}
          >
            {opening ? <LoaderCircleIcon className="animate-spin" /> : <EyeIcon />}
            Open
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Export ${session.name}`}
            onClick={() => void downloadRecording(manager, session.id)}
          >
            <DownloadIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Rename ${session.name}`}
            onClick={() => setRenaming(true)}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${session.name}`}
            disabled={recording || inUse}
            title={
              recording || inUse
                ? 'This recording is being written, or the live session reads it until it is reset'
                : undefined
            }
            onClick={() => setDeleting(true)}
          >
            <Trash2Icon />
          </Button>
        </div>
      )}
    </li>
  );
}

function RenameField({
  name,
  onDone,
}: {
  readonly name: string;
  readonly onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onDone(value.trim() === '' ? null : value);
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-1">
      <Input
        ref={field}
        aria-label="Session name"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onDone(null);
          }
        }}
        className="h-8"
      />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label="Save the name">
        <CheckIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Cancel renaming"
        onClick={() => onDone(null)}
      >
        <XIcon />
      </Button>
    </form>
  );
}
