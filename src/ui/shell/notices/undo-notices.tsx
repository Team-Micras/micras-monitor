import { useShell, useShellStore } from '../../state/shell-store';
import { windowTitle } from '../../windows/registry';
import { UNDO_MS, UndoNotice } from './undo-notice';

/** The notice that a layout preset was deleted, which can bring it back. */
export function DeletedNotice({ durationMs = UNDO_MS }: { readonly durationMs?: number }) {
  const store = useShellStore();
  const deleted = useShell((state) => state.deletedPreset);

  return (
    <UndoNotice
      id={deleted?.id}
      label="Layout deleted"
      durationMs={durationMs}
      onUndo={() => store.getState().undoDelete()}
      onExpire={(id) => store.getState().clearDeleted(id)}
    >
      Deleted layout <span className="font-medium">{deleted?.preset.name}</span>
    </UndoNotice>
  );
}

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

/** The notices of removals that can be undone: a deleted layout, a variable taken out. */
export function UndoNotices() {
  return (
    <>
      <DeletedNotice />
      <RemovedVariableNotice />
    </>
  );
}
