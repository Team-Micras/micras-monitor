import { presentVariable } from '@/robot-kit';

import { formatValue } from '../lib/format';
import { useLiveValue, useRobotPackage, useVariables } from '../monitor-context';
import type { VariableInfo } from '../ports';
import type { WindowViewProps } from './types';

/**
 * Stands in for a window kind until its view lands: the window's variables with their latest
 * values, or a hint to drop one in.
 */
export function PlaceholderWindow({ window }: WindowViewProps) {
  const variables = useVariables();
  const shown = window.payload.variables.map(
    (name) => variables.find((variable) => variable.name === name) ?? name
  );

  if (shown.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Drag a variable here from the drawer
      </div>
    );
  }

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

function PlaceholderRow({ variable }: { readonly variable: VariableInfo }) {
  const value = useLiveValue(variable.id);
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
