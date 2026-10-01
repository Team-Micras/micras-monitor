import { CheckIcon, CircleAlertIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { bitSet, integerValue, sameInteger, withBit, type IntegerValue } from '@/core/integers';
import type { ValueType } from '@/core/variables';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { useLinkUp, useLiveValue, useMonitor } from '../../monitor-context';
import type { WriteOutcome, WriteValue } from '../../ports';
import { CoalescedReads } from '../type-view/coalesced-reads';
import { usePresentedVariables, type PresentedVariable } from '../shared/presented-variables';
import { formatReading } from '../shared/readings';
import type { WindowViewProps } from '../types';
import {
  editorControl,
  optionValue,
  parseValue,
  refusalText,
  type EditorControl,
} from './editor-value';

/**
 * Edits the window's variables with a control for each type: a switch for a bool, a switch per
 * flag of a bitmask, a choice of labels for an enum and a checked field for a number. The
 * controls show the value the robot confirmed; a write shows as pending until the robot answers,
 * and a refusal says why.
 */
export function EditorWindow({ window }: WindowViewProps) {
  const presented = usePresentedVariables(window.payload.variables);

  if (presented.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Drag a variable here from the drawer
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto px-5 pt-1 pb-5">
      {presented.map((entry) => (
        <VariableEditor key={entry.name} entry={entry} />
      ))}
    </div>
  );
}

/** The last write this window made and how the robot answered it. */
interface LastWrite {
  readonly value: WriteValue;
  readonly outcome: WriteOutcome | null;
}

function usePendingWrite(name: string): WriteValue | undefined {
  const { writes } = useMonitor().ports;
  return useSyncExternalStore(
    (listener) => writes.subscribe(listener),
    () => writes.pending(name)
  );
}

function VariableEditor({ entry }: { readonly entry: PresentedVariable }) {
  const { writes, reads } = useMonitor().ports;
  const linked = useLinkUp();
  const confirmed = useLiveValue(entry.name)?.value;
  const pending = usePendingWrite(entry.name);
  const [last, setLast] = useState<LastWrite | null>(null);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const { variable, presentation } = entry;
  const reader = useRef<CoalescedReads | null>(null);
  const variableId = variable?.id;
  const streamed = variable?.access.stream ?? true;

  useEffect(() => {
    if (!linked || streamed || variableId === undefined) {
      return undefined;
    }

    let cancelled = false;
    const current = new CoalescedReads(() =>
      reads.read(entry.name).then((outcome) => {
        if (!cancelled) {
          setReading(false);
          setReadFailure(outcome.status === 'failed' ? outcome.message : null);
        }
      })
    );
    reader.current = current;
    current.request();
    return () => {
      cancelled = true;
      current.close();
      reader.current = null;
    };
  }, [reads, linked, streamed, variableId, entry.name]);

  if (variable === undefined || presentation === null) {
    return (
      <section
        data-editor={entry.name}
        data-missing={entry.missing}
        className="flex flex-col gap-1"
      >
        <h3 className="font-mono text-sm">{entry.name}</h3>
        <p className="text-sm text-muted-foreground">
          {entry.missing
            ? 'Missing: the schema of this robot has no such variable.'
            : 'Connect to a robot to edit it.'}
        </p>
      </section>
    );
  }

  const control = editorControl(variable.type, presentation.labels);
  const writable = variable.access.write && control.kind !== 'none';
  const needsConfirmed = control.kind === 'bool' || control.kind === 'bitmask';
  const disabledReason = !writable
    ? 'The robot does not take writes of this variable.'
    : !linked
      ? 'Connect to a robot to write.'
      : needsConfirmed && confirmed === undefined && pending === undefined && readFailure === null
        ? 'Waiting for the robot to report the current value.'
        : null;

  const write = (value: WriteValue) => {
    setLast({ value, outcome: null });
    void writes
      .write(entry.name, value)
      .catch((error: unknown) => ({
        status: 'failed' as const,
        message: error instanceof Error ? error.message : String(error),
      }))
      .then((outcome) => {
        if (outcome.status === 'confirmed') {
          reader.current?.request();
        }

        setLast((current) => (current?.value === value ? { value, outcome } : current));
      });
  };

  const confirmedText =
    confirmed === undefined ? '—' : formatReading(confirmed, presentation.labels, variable.type);

  return (
    <section data-editor={entry.name} className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <h3 className="truncate font-mono text-sm">{entry.name}</h3>
        <span className="font-mono text-xs text-muted-foreground">{presentation.typeLabel}</span>
        <span className="ml-auto flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
          <span className="text-muted-foreground">confirmed</span>
          <span data-confirmed className="tabular-nums">
            {confirmedText}
          </span>
        </span>
      </header>
      <Control
        control={control}
        confirmed={integerValue(confirmed)}
        pending={integerValue(pending)}
        disabled={disabledReason !== null}
        type={variable.type}
        onWrite={write}
      />
      {variable.access.writeNeedsIdle && writable ? (
        <p className="text-xs text-muted-foreground">Takes writes only while the robot is idle.</p>
      ) : null}
      <WriteNote
        disabledReason={disabledReason}
        pending={pending}
        last={last}
        readFailure={readFailure}
        reading={reading}
        onReadAgain={() => {
          setReading(true);
          reader.current?.request();
        }}
        describe={(value) =>
          formatReading(integerValue(value) ?? value, presentation.labels, variable.type)
        }
      />
    </section>
  );
}

function Control({
  control,
  confirmed,
  pending,
  disabled,
  type,
  onWrite,
}: {
  readonly control: EditorControl;
  readonly confirmed: IntegerValue | undefined;
  readonly pending: IntegerValue | undefined;
  readonly disabled: boolean;
  readonly type: ValueType;
  readonly onWrite: (value: WriteValue) => void;
}) {
  switch (control.kind) {
    case 'bool':
      return (
        <FlagRow
          label="value"
          checked={confirmed === 1}
          pending={pending !== undefined && !sameInteger(pending, confirmed)}
          disabled={disabled || confirmed === undefined}
          onChange={(on) => onWrite(on)}
        />
      );
    case 'bitmask': {
      const base = pending ?? confirmed;
      return (
        <div className="flex flex-col divide-y">
          {control.labels.flags.map((flag) => (
            <FlagRow
              key={flag.bit}
              label={flag.label}
              detail={`bit ${flag.bit}`}
              checked={confirmed !== undefined && bitSet(confirmed, flag.bit, type)}
              pending={
                pending !== undefined &&
                confirmed !== undefined &&
                bitSet(pending, flag.bit, type) !== bitSet(confirmed, flag.bit, type)
              }
              disabled={disabled || base === undefined}
              onChange={(on) => {
                if (base !== undefined) {
                  onWrite(withBit(base, flag.bit, on, type));
                }
              }}
            />
          ))}
        </div>
      );
    }
    case 'enum': {
      const awaits = (value: number) =>
        sameInteger(pending, value) && !sameInteger(pending, confirmed);
      return (
        <div className="flex flex-wrap gap-1.5">
          {control.labels.options.map((option) => (
            <Button
              key={option.value}
              aria-pressed={sameInteger(confirmed, option.value)}
              variant={sameInteger(confirmed, option.value) ? 'secondary' : 'ghost'}
              size="sm"
              disabled={disabled}
              className={cn(
                'font-mono',
                sameInteger(confirmed, option.value) && 'border border-foreground/20',
                awaits(option.value) && 'border border-dashed'
              )}
              onClick={() => onWrite(optionValue(option.value, control.wide))}
            >
              {awaits(option.value) ? <LoaderCircleIcon className="animate-spin" /> : null}
              {option.label}
            </Button>
          ))}
        </div>
      );
    }
    case 'number':
      return <NumberField type={control.type} disabled={disabled} onWrite={onWrite} />;
    default:
      return null;
  }
}

function FlagRow({
  label,
  detail,
  checked,
  pending,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly detail?: string;
  readonly checked: boolean;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 py-2.5">
      <Switch
        checked={checked}
        disabled={disabled}
        data-pending={pending}
        className={cn(pending && 'ring-2 ring-ring/40 ring-offset-1 ring-offset-card')}
        onCheckedChange={(on) => onChange(on)}
      />
      <span className="font-mono text-sm">{label}</span>
      {detail === undefined ? null : (
        <span className="font-mono text-xs text-muted-foreground">{detail}</span>
      )}
      <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        {pending ? (
          <>
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            <span className="text-foreground">pending ack</span>
          </>
        ) : checked ? (
          <>
            <CheckIcon className="size-3.5" />
            on
          </>
        ) : (
          'off'
        )}
      </span>
    </label>
  );
}

function NumberField({
  type,
  disabled,
  onWrite,
}: {
  readonly type: Parameters<typeof parseValue>[1];
  readonly disabled: boolean;
  readonly onWrite: (value: WriteValue) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const parsed = parseValue(text, type);

    if (parsed.ok) {
      setError(null);
      onWrite(parsed.value);
    } else {
      setError(parsed.error);
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex gap-2">
        <Input
          value={text}
          inputMode="decimal"
          aria-label="New value"
          aria-invalid={error !== null}
          disabled={disabled}
          placeholder="New value"
          className="font-mono tabular-nums"
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />
        <Button type="submit" variant="outline" disabled={disabled}>
          Write
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function WriteNote({
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
