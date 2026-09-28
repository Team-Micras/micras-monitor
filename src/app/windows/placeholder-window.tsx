import type { ReactNode } from 'react';

import { presentVariable } from '@/robot-kit';

import { formatValue } from '../lib/format';
import { useLiveValue, useRobotPackage, useVariables } from '../monitor-context';
import type { RobotVariable } from '../ports';
import type { WindowViewProps } from './types';

/**
 * Stands in for a window kind that shows variables until its view lands: the window's variables
 * with their latest values, or a hint to drop one in.
 */
export function PlaceholderWindow({ window }: WindowViewProps) {
  return (
    <VariableList names={window.payload.variables}>
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Drag a variable here from the drawer
      </div>
    </VariableList>
  );
}

/**
 * Stands in for a window kind that draws a view of its own, which variables dropped on it do
 * not join: the window's variables with their latest values, and nothing when it has none.
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
  const variables = useVariables();

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
            <span>not in schema</span>
          </li>
        ) : (
          <PlaceholderRow key={entry.name} variable={entry} />
        )
      )}
    </ul>
  );
}

function PlaceholderRow({ variable }: { readonly variable: RobotVariable }) {
  const value = useLiveValue(variable.name)?.value;
  const selection = useRobotPackage();
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
