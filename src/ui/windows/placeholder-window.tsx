import type { ReactNode } from 'react';

import { presentVariable } from '@/core/robot';
import type { Variable } from '@/core/variables';

import { formatValue } from '../lib/format';
import { useLiveValue, useRobotPackage, useShownMonitor, useVariables } from '../monitor-context';
import type { WindowViewProps } from './types';

/**
 * Stands in for a window kind this build does not know, as from a newer layout: the window's
 * variables with their latest values, and nothing when it has none.
 */
export function ViewPlaceholder({ window }: WindowViewProps) {
  return <VariableList names={window.payload.variables}>{null}</VariableList>;
}

function VariableList({
  names,
  children,
}: {
  readonly names: readonly string[];
  readonly children: ReactNode;
}) {
  const variables = useVariables(useShownMonitor());

  if (names.length === 0) {
    return children;
  }

  const shown = names.map((name) => variables.find((variable) => variable.name === name) ?? name);

  return (
    <ul className="flex flex-col gap-1 overflow-auto p-4 font-mono text-sm">
      {shown.map((entry) =>
        typeof entry === 'string' ? (
          <li key={entry} className="flex justify-between gap-4 text-muted-foreground">
            <span className="truncate">{entry}</span>
            <span>{variables.length > 0 ? 'missing' : '—'}</span>
          </li>
        ) : (
          <PlaceholderRow key={entry.name} variable={entry} />
        )
      )}
    </ul>
  );
}

function PlaceholderRow({ variable }: { readonly variable: Variable }) {
  const monitor = useShownMonitor();
  const value = useLiveValue(monitor, variable.name)?.value;
  const selection = useRobotPackage(monitor);
  const { unit } = presentVariable(selection?.package ?? null, variable);

  return (
    <li className="flex justify-between gap-4">
      <span className="truncate text-muted-foreground">{variable.name}</span>
      <span className="tabular-nums">
        {formatValue(value)}
        {unit === null ? null : <span className="ml-1 text-muted-foreground">{unit}</span>}
      </span>
    </li>
  );
}
