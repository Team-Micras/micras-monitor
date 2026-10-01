import { CheckIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';

import { bitSet, sameInteger, withBit, type IntegerValue } from '@/core/integers';
import type { WriteValue } from '@/core/source';
import type { ValueType } from '@/core/variables';

import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import { Switch } from '../../primitives/switch';
import { cn } from '../../primitives/utils';
import { optionValue, parseValue, type EditorControl } from './editor-value';

/**
 * The control that writes a variable of one kind: a switch for a bool, a switch per flag of a
 * bitmask, a button per label of an enum and a checked field for a number. It shows the value the
 * robot confirmed, and marks what was written and not confirmed yet.
 */
export function ValueControl({
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
