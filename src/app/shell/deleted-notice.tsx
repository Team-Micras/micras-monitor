import { useEffect } from 'react';

import { Button } from '../components/ui/button';
import { useShell, useShellStore } from '../state/shell-store';

/** How long a deleted layout can be brought back. */
export const UNDO_DELETE_MS = 6000;

/** The notice that a layout preset was deleted, with the button that brings it back. */
export function DeletedNotice() {
  const store = useShellStore();
  const deleted = useShell((state) => state.deletedPreset);
  const id = deleted?.id;

  useEffect(() => {
    if (id === undefined) {
      return undefined;
    }

    const timer = setTimeout(() => store.getState().clearDeleted(id), UNDO_DELETE_MS);
    return () => clearTimeout(timer);
  }, [store, id]);

  if (deleted === null) {
    return null;
  }

  return (
    <output
      aria-label="Layout deleted"
      className="fixed bottom-14 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-popover py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-md"
    >
      <span>
        Deleted layout <span className="font-medium">{deleted.preset.name}</span>
      </span>
      <Button variant="outline" size="sm" onClick={() => store.getState().undoDelete()}>
        Undo
      </Button>
    </output>
  );
}
