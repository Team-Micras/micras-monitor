import { PlusIcon } from 'lucide-react';

import { Button } from '../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import { cn } from '../lib/utils';
import { useShell, useShellStore } from '../state/shell-store';

/**
 * The workspace tabs: click one to show it, drop a window on one to move the window there, and
 * add workspaces with the plus button.
 */
export function WorkspaceTabs() {
  const store = useShellStore();
  const workspaces = useShell((state) => state.desktop.workspaces);
  const active = useShell((state) => state.desktop.active);
  const dropIndex = useShell((state) =>
    state.drag?.target?.kind === 'workspace' ? state.drag.target.index : null
  );

  return (
    <nav
      aria-label="Workspaces"
      className="flex items-center gap-0.5 rounded-xl border bg-muted/50 p-1"
    >
      <div role="tablist" className="flex items-center gap-0.5">
        {workspaces.map((workspace, index) => (
          <ContextMenu key={workspace.name}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                role="tab"
                aria-selected={index === active}
                data-workspace-tab={index}
                title={index < 9 ? `Alt+${index + 1}` : undefined}
                onClick={() => store.getState().run({ type: 'switchWorkspace', index })}
                className={cn(
                  'h-8 rounded-lg px-3.5 text-sm text-muted-foreground transition-colors hover:text-foreground',
                  index === active && 'bg-background text-foreground shadow-sm ring-1 ring-border',
                  dropIndex === index &&
                    'bg-foreground/10 text-foreground ring-2 ring-foreground/40'
                )}
              >
                {workspace.name}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                variant="destructive"
                disabled={workspaces.length === 1}
                onSelect={() =>
                  store
                    .getState()
                    .run({ type: 'removeWorkspace', index, policy: 'mergeIntoNeighbor' })
                }
              >
                Close workspace, keep its windows
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-lg text-muted-foreground"
        aria-label="Add a workspace"
        onClick={() => store.getState().addWorkspace()}
      >
        <PlusIcon />
      </Button>
    </nav>
  );
}
