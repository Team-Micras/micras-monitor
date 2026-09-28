import { ChartLineIcon } from 'lucide-react';

import { useShell } from '../state/shell-store';
import { windowKind, windowTitle } from '../windows/registry';

/** The chip that follows the pointer while a window or a variable is dragged. */
export function DragGhost() {
  const drag = useShell((state) => state.drag);
  const windows = useShell((state) => state.desktop.windows);

  if (drag === null || drag.grab !== null) {
    return null;
  }

  const { subject, pointer } = drag;
  const window = subject.kind === 'window' ? windows.get(subject.id) : undefined;
  const Icon = window === undefined ? ChartLineIcon : windowKind(window.kind).icon;
  const label =
    subject.kind === 'variable' ? subject.name : window === undefined ? '' : windowTitle(window);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
      style={{ left: pointer.x + 12, top: pointer.y + 12 }}
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className={subject.kind === 'variable' ? 'font-mono' : undefined}>{label}</span>
    </div>
  );
}
