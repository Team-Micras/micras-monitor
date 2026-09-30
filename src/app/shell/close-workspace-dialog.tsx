import { useId, useState } from 'react';

import { neighborWorkspace, windowIds, type Workspace } from '@/tiling';

import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { cn } from '../lib/utils';
import { useShell, useShellStore, type WorkspaceClosing } from '../state/shell-store';

/** What the dialog would do with the windows: close them, or move them to a workspace. */
type Choice = 'close' | number;

function windowCount(workspace: Workspace): string {
  const count = windowIds(workspace).length;
  return count === 1 ? '1 window' : `${count} windows`;
}

/**
 * Asks what becomes of the windows of a workspace being closed: move them to another workspace,
 * the neighbor that takes its place unless another is picked, or close them with it. It opens on
 * the choice it was asked with, and is keyed by the question so that each one starts afresh.
 */
export function CloseWorkspaceDialog() {
  const store = useShellStore();
  const closing = useShell((state) => state.closingWorkspace);
  const workspaces = useShell((state) => state.desktop.workspaces);
  const workspace = closing === null ? undefined : workspaces[closing.index];

  return (
    <Dialog
      open={closing !== null && workspace !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          store.getState().setClosingWorkspace(null);
        }
      }}
    >
      {closing !== null && workspace !== undefined ? (
        <CloseWorkspaceContent
          key={`${closing.index} ${closing.windows}`}
          closing={closing}
          workspace={workspace}
          workspaces={workspaces}
        />
      ) : null}
    </Dialog>
  );
}

function CloseWorkspaceContent({
  closing,
  workspace,
  workspaces,
}: {
  readonly closing: WorkspaceClosing;
  readonly workspace: Workspace;
  readonly workspaces: readonly Workspace[];
}) {
  const store = useShellStore();
  const name = useId();
  const { index } = closing;
  const [choice, setChoice] = useState<Choice>(
    closing.windows === 'close' ? 'close' : neighborWorkspace(index)
  );
  const count = windowCount(workspace);
  const options: readonly { readonly value: Choice; readonly label: string }[] = [
    ...workspaces.flatMap((other, at) =>
      at === index ? [] : [{ value: at, label: `Move them to ${other.name}` }]
    ),
    { value: 'close', label: 'Close them with it' },
  ];

  const confirm = () => {
    const { run, setClosingWorkspace } = store.getState();
    setClosingWorkspace(null);
    run({
      type: 'removeWorkspace',
      index,
      policy: choice === 'close' ? 'closeWindows' : { mergeInto: choice },
    });
  };

  return (
    <DialogContent className="sm:max-w-md" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Close {workspace.name}?</DialogTitle>
        <DialogDescription>It holds {count}. What becomes of them?</DialogDescription>
      </DialogHeader>
      <fieldset className="grid gap-1">
        <legend className="sr-only">Its {count}</legend>
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              choice === option.value ? 'border-foreground/30 bg-accent' : 'hover:bg-accent/50'
            )}
          >
            <input
              type="radio"
              name={name}
              className="accent-foreground"
              checked={choice === option.value}
              onChange={() => setChoice(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <DialogFooter>
        <Button variant="ghost" onClick={() => store.getState().setClosingWorkspace(null)}>
          Cancel
        </Button>
        <Button variant={choice === 'close' ? 'destructive' : 'default'} onClick={confirm}>
          {choice === 'close' ? `Close workspace and ${count}` : 'Close workspace'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
