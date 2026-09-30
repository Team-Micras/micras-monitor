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

/** What the dialog would do with the windows: close them, or move them to a named workspace. */
type Choice = { readonly kind: 'close' } | { readonly kind: 'move'; readonly to: string };

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function sameChoice(a: Choice, b: Choice): boolean {
  return a.kind === 'close' ? b.kind === 'close' : b.kind === 'move' && a.to === b.to;
}

/**
 * Asks what becomes of the windows of a workspace being closed: move them to another workspace,
 * the neighbor that takes its place unless another is picked, or close them with it, warned of
 * commands still waiting for the robot's answer. It opens on the choice it was asked with, and is
 * keyed by the question so that each one starts afresh. Workspaces are named, not counted, so a
 * workspace moved while it is open is still the one closed.
 */
export function CloseWorkspaceDialog() {
  const store = useShellStore();
  const closing = useShell((state) => state.closingWorkspace);
  const workspaces = useShell((state) => state.desktop.workspaces);
  const index =
    closing === null ? -1 : workspaces.findIndex((entry) => entry.name === closing.name);
  const workspace = workspaces.at(index);
  const open = closing !== null && index !== -1 && workspace !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          store.getState().cancelCloseWorkspace();
        }
      }}
    >
      {open ? (
        <CloseWorkspaceContent
          key={`${closing.name} ${closing.windows}`}
          closing={closing}
          index={index}
          workspace={workspace}
          workspaces={workspaces}
        />
      ) : null}
    </Dialog>
  );
}

interface ContentProps {
  readonly closing: WorkspaceClosing;
  readonly index: number;
  readonly workspace: Workspace;
  readonly workspaces: readonly Workspace[];
}

function CloseWorkspaceContent({ closing, index, workspace, workspaces }: ContentProps) {
  const store = useShellStore();
  const name = useId();
  const ids = windowIds(workspace);
  const waiting = useShell((state) =>
    ids.reduce((sum, id) => sum + (state.waitingCommands.get(id) ?? 0), 0)
  );
  const [choice, setChoice] = useState<Choice>(() =>
    closing.windows === 'close'
      ? { kind: 'close' }
      : { kind: 'move', to: workspaces[neighborWorkspace(index)]?.name ?? '' }
  );
  const count = plural(ids.length, 'window', 'windows');
  const options: readonly { readonly value: Choice; readonly label: string }[] = [
    ...workspaces.flatMap((other, at) =>
      at === index
        ? []
        : [
            {
              value: { kind: 'move', to: other.name } as const,
              label: `Move them to ${other.name}`,
            },
          ]
    ),
    { value: { kind: 'close' }, label: 'Close them with it' },
  ];

  const confirm = () =>
    store
      .getState()
      .confirmCloseWorkspace(choice.kind === 'close' ? 'close' : { moveTo: choice.to });

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
            key={option.label}
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              sameChoice(choice, option.value)
                ? 'border-foreground/30 bg-accent'
                : 'hover:bg-accent/50'
            )}
          >
            <input
              type="radio"
              name={name}
              className="accent-foreground"
              checked={sameChoice(choice, option.value)}
              onChange={() => setChoice(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      {choice.kind === 'close' && waiting > 0 ? (
        <p role="note" className="text-sm text-muted-foreground">
          {waiting === 1
            ? '1 command is still waiting for the robot.'
            : `${waiting} commands are still waiting for the robot.`}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={() => store.getState().cancelCloseWorkspace()}>
          Cancel
        </Button>
        <Button variant={choice.kind === 'close' ? 'destructive' : 'default'} onClick={confirm}>
          {choice.kind === 'close' ? `Close workspace and ${count}` : 'Close workspace'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
