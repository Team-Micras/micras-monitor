import { useEffect, useRef, useState } from 'react';

import { integerValue } from '@/core/integers';
import type { WriteValue } from '@/core/source';

import { useLinkUp, useLiveValue, usePendingWrite, useShownMonitor } from '../../monitor-context';
import { CoalescedReads } from '../blob-view/coalesced-reads';
import { usePresentedVariables, type PresentedVariable } from '../shared/presented-variables';
import { formatReading } from '../shared/value-text';
import type { WindowViewProps } from '../types';
import { ValueControl } from './controls';
import { editorControl } from './editor-value';
import { WriteNote, type LastWrite } from './write-note';

/**
 * Edits the window's variables with a control for each type: a switch for a bool, a switch per
 * flag of a bitmask, a choice of labels for an enum and a checked field for a number. The
 * controls show the value the robot confirmed; a write shows as pending until the robot answers,
 * and a refusal says why.
 */
export function EditorWindow({ window }: WindowViewProps) {
  const monitor = useShownMonitor();
  const presented = usePresentedVariables(monitor, window.payload.variables);

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

function VariableEditor({ entry }: { readonly entry: PresentedVariable }) {
  const monitor = useShownMonitor();
  const linked = useLinkUp(monitor);
  const confirmed = useLiveValue(monitor, entry.name)?.value;
  const pending = usePendingWrite(monitor, entry.name);
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
      monitor.read(entry.name).then((outcome) => {
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
  }, [monitor, linked, streamed, variableId, entry.name]);

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
    void monitor
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
      <ValueControl
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
