import { useShell, useShellStore } from '../state/shell-store';
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
