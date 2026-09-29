import { roleVariable } from '@/robot-kit';

import { useConnectionStatus, useLiveValue, useRobotPackage } from '../monitor-context';

/**
 * Whether reloading the page now could cut a run short: a robot is linked and its state is not
 * idle. A linked robot whose state is unknown counts as busy. The idle state is the enum label
 * `IDLE` of the package's state role, in any case.
 */
export function useReloadBlocked(): boolean {
  const linked = useConnectionStatus().kind === 'linked';
  const pkg = useRobotPackage()?.package ?? null;
  const stateName = roleVariable(pkg, 'state');
  const value = useLiveValue(stateName)?.value;

  if (!linked) {
    return false;
  }

  const labels = stateName === null ? undefined : pkg?.variables[stateName]?.labels;

  if (typeof value !== 'number' || labels?.kind !== 'enum') {
    return true;
  }

  return labels.options.find((option) => option.value === value)?.label.toLowerCase() !== 'idle';
}
