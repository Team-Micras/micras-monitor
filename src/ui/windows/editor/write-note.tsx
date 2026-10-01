import { CheckIcon, CircleAlertIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { WriteOutcome, WriteValue } from '@/core/source';

import { Button } from '../../primitives/button';
import { refusalText } from './editor-value';

/** The last write this window made and how the robot answered it. */
export interface LastWrite {
  readonly value: WriteValue;
  readonly outcome: WriteOutcome | null;
}

/**
 * What became of the last write of a variable, or why it cannot be written: waiting for the
 * robot, refused, failed, not read, or confirmed.
 */
export function WriteNote({
  disabledReason,
  pending,
  last,
  readFailure,
  reading,
  onReadAgain,
  describe,
}: {
  readonly disabledReason: string | null;
  readonly pending: WriteValue | undefined;
  readonly last: LastWrite | null;
  readonly readFailure: string | null;
  readonly reading: boolean;
  readonly onReadAgain: () => void;
  readonly describe: (value: WriteValue) => string;
}) {
  let note: ReactNode = null;

  if (disabledReason !== null) {
    note = <span className="text-muted-foreground">{disabledReason}</span>;
  } else if (pending !== undefined) {
    note = (
      <>
        <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
        <span>
          <span className="font-mono">{describe(pending)}</span> sent, waiting for the robot to
          confirm
        </span>
      </>
    );
  } else if (last?.outcome?.status === 'refused') {
    note = (
      <span role="alert" className="flex items-center gap-2 text-destructive">
        <CircleAlertIcon className="size-3.5 shrink-0" />
        Refused: {refusalText(last.outcome.reason)}
      </span>
    );
  } else if (last?.outcome?.status === 'failed') {
    note = (
      <span role="alert" className="flex items-center gap-2 text-destructive">
        <CircleAlertIcon className="size-3.5 shrink-0" />
        Not written: {last.outcome.message}
      </span>
    );
  } else if (readFailure !== null) {
    note = (
      <>
        <span role="alert" className="flex items-center gap-2 text-destructive">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          Not read: {readFailure}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={reading}
          onClick={onReadAgain}
        >
          <RefreshCwIcon className={reading ? 'animate-spin' : undefined} />
          Read again
        </Button>
      </>
    );
  } else if (last?.outcome?.status === 'confirmed') {
    note = (
      <span className="flex items-center gap-2 text-muted-foreground">
        <CheckIcon className="size-3.5 shrink-0" />
        <span className="font-mono">{describe(last.value)}</span> confirmed by the robot
      </span>
    );
  }

  return note === null ? null : (
    <div
      data-write-note
      className="flex min-h-9 items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs"
    >
      {note}
    </div>
  );
}
