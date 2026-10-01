import { useShell, useShellStore } from '../state/shell-store';
import { windowTitle } from '../windows/registry';
import { UndoNotice } from './undo-notice';

/** The notice that a variable was taken out of a window, which can put it back. */
export function RemovedVariableNotice({ durationMs }: { readonly durationMs?: number }) {
  const store = useShellStore();
  const removed = useShell((state) => state.removedVariable);
  const window = useShell((state) =>
    removed === null ? undefined : state.desktop.windows.get(removed.window)
  );

  return (
    <UndoNotice
      id={removed?.id}
      label="Variable removed"
      durationMs={durationMs}
      onUndo={() => store.getState().undoRemoveVariable()}
      onExpire={(id) => store.getState().clearRemovedVariable(id)}
    >
      Removed <span className="font-mono text-xs">{removed?.name}</span>
      {window === undefined ? null : ` from ${windowTitle(window)}`}
    </UndoNotice>
  );
}
