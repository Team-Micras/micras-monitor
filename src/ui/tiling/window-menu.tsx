import {
  EllipsisIcon,
  MaximizeIcon,
  MinusCircleIcon,
  PictureInPicture2Icon,
  XIcon,
} from 'lucide-react';

import { formatChord } from '@/core/chords';

import type { KeyAction } from '../keyboard/keymap';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { useShell, useShellStore } from '../state/shell-store';
import type { ShellWindow } from '../windows/types';

/** What the menu of a window acts on. */
export interface WindowMenuProps {
  readonly window: ShellWindow;
  readonly title: string;
  /** The workspace the window is on, which the menu does not offer to move it to. */
  readonly workspaceIndex: number;
  readonly floating: boolean;
  readonly maximized: boolean;
}

/**
 * The menu in a window's title bar: maximize, float or tile, move to another workspace, take a
 * variable out and close, each with its key.
 */
export function WindowMenu({
  window,
  title,
  workspaceIndex,
  floating,
  maximized,
}: WindowMenuProps) {
  const store = useShellStore();
  const workspaces = useShell((state) => state.desktop.workspaces);
  const bindings = useShell((state) => state.bindings);
  const { variables } = window.payload;

  const shortcut = (action: KeyAction) => {
    const chord = bindings.get(action)?.[0];
    return chord === undefined ? null : (
      <DropdownMenuShortcut>{formatChord(chord).join('+')}</DropdownMenuShortcut>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`${title} menu`}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          disabled={floating}
          onSelect={() => store.getState().run({ type: 'toggleMaximize', id: window.id })}
        >
          <MaximizeIcon />
          {maximized ? 'Restore' : 'Maximize'}
          {shortcut('window.maximize')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => store.getState().run({ type: 'toggleFloating', id: window.id })}
        >
          <PictureInPicture2Icon />
          {floating ? 'Tile' : 'Float'}
          {shortcut('window.float')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to workspace</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {workspaces.map((workspace, index) =>
              index === workspaceIndex ? null : (
                <DropdownMenuItem
                  key={workspace.name}
                  onSelect={() =>
                    store
                      .getState()
                      .run({ type: 'moveToWorkspace', index, id: window.id, follow: false })
                  }
                >
                  {workspace.name}
                </DropdownMenuItem>
              )
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {variables.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <MinusCircleIcon />
              Remove variable
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {variables.map((name) => (
                <DropdownMenuItem
                  key={name}
                  className="font-mono text-xs"
                  onSelect={() => store.getState().removeVariable(window.id, name)}
                >
                  {name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => store.getState().run({ type: 'close', id: window.id })}
        >
          <XIcon />
          Close
          {shortcut('window.close')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
