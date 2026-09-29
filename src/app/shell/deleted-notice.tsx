import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { isTextField } from '../keymap/use-keymap';
import { useShell, useShellStore } from '../state/shell-store';

/** How long a deleted layout can be brought back. */
export const UNDO_DELETE_MS = 6000;

/**
 * The notice that a layout preset was deleted, with the button that brings it back; Ctrl+Z does
 * too, outside of text fields. It goes away after `durationMs`, counted from the last time the
 * pointer or the focus left it.
 */
export function DeletedNotice({ durationMs = UNDO_DELETE_MS }: { readonly durationMs?: number }) {
  const store = useShellStore();
  const deleted = useShell((state) => state.deletedPreset);
  const [held, setHeld] = useState(false);
  const id = deleted?.id;
  const notice = useRef<HTMLOutputElement>(null);

  useEffect(() => {
    if (id === undefined || held) {
      return undefined;
    }

    const timer = setTimeout(() => store.getState().clearDeleted(id), durationMs);
    return () => clearTimeout(timer);
  }, [store, id, held, durationMs]);

  useEffect(() => {
    const element = notice.current;

    if (id === undefined || element === null) {
      return undefined;
    }

    const hold = () => setHeld(true);
    const release = () => setHeld(false);
    element.addEventListener('pointerenter', hold);
    element.addEventListener('pointerleave', release);
    element.addEventListener('focusin', hold);
    element.addEventListener('focusout', release);
    return () => {
      element.removeEventListener('pointerenter', hold);
      element.removeEventListener('pointerleave', release);
      element.removeEventListener('focusin', hold);
      element.removeEventListener('focusout', release);
      setHeld(false);
    };
  }, [id]);

  useEffect(() => {
    if (id === undefined) {
      return undefined;
    }

    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'z' &&
        !isTextField(event.target)
      ) {
        event.preventDefault();
        store.getState().undoDelete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, id]);

  if (deleted === null) {
    return null;
  }

  return (
    <output
      aria-label="Layout deleted"
      ref={notice}
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
