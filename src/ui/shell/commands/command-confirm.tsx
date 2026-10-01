import type { CommandSpec } from '@/core/robot';

import { Button } from '../../primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog';

/** What the dialog that confirms a command needs. */
export interface CommandConfirmProps {
  readonly open: boolean;
  /** The command being confirmed; it stays while the dialog fades out. */
  readonly command: CommandSpec | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (command: CommandSpec) => void;
}

/** The dialog that asks before a dangerous command is sent. */
export function CommandConfirm({ open, command, onOpenChange, onConfirm }: CommandConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{command?.label}</DialogTitle>
          <DialogDescription>{command?.confirm}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (command !== null) {
                onConfirm(command);
              }

              onOpenChange(false);
            }}
          >
            {command?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
