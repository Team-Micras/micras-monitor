import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';

import { Button } from '../components/ui/button';
import { isTextField } from '../keymap/use-keymap';

/** How long something removed can be brought back. */
export const UNDO_MS = 6000;

/** A notice of something removed that can be brought back. */
export interface UndoNoticeProps {
  /** Tells one removal from the next; nothing is shown without one. */
  readonly id: number | undefined;
  /** Names the notice for assistive technology. */
  readonly label: string;
  readonly onUndo: () => void;
  /** The notice timed out; it is given the id it was shown for. */
  readonly onExpire: (id: number) => void;
  readonly durationMs?: number;
  /** What was removed, in a sentence. */
  readonly children: ReactNode;
}

/**
 * The notice that something was removed, with the button that brings it back; Ctrl+Z does too,
 * outside of text fields. It goes away after `durationMs`, counted from the last time the pointer
 * or the focus left it.
 */
export function UndoNotice({
  id,
  label,
  onUndo,
  onExpire,
  durationMs = UNDO_MS,
  children,
}: UndoNoticeProps) {
  const [held, setHeld] = useState(false);
  const notice = useRef<HTMLOutputElement>(null);
  const expire = useEffectEvent(onExpire);
  const undo = useEffectEvent(onUndo);

  useEffect(() => {
    if (id === undefined || held) {
      return undefined;
    }

    const timer = setTimeout(() => expire(id), durationMs);
    return () => clearTimeout(timer);
  }, [id, held, durationMs]);

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
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  if (id === undefined) {
    return null;
  }

  return (
    <output
      aria-label={label}
      ref={notice}
      className="fixed bottom-14 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-popover py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-md"
    >
      <span>{children}</span>
      <Button variant="outline" size="sm" onClick={onUndo}>
        Undo
      </Button>
    </output>
  );
}
