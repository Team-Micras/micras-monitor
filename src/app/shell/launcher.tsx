import {
  LayoutGridIcon,
  LayoutTemplateIcon,
  ListTreeIcon,
  MaximizeIcon,
  MoonIcon,
  PauseIcon,
  PencilIcon,
  PictureInPicture2Icon,
  PlugIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useEffect } from 'react';

import { activeWorkspace, focusedWindow } from '@/tiling';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../components/ui/command';
import { formatChord } from '../keymap/chords';
import { workspaceAction, type KeyAction } from '../keymap/keymap';
import { useRobotPackage } from '../monitor-context';
import { useShell, useShellStore } from '../state/shell-store';
import { WINDOW_KINDS } from '../windows/registry';

/**
 * The launcher (Ctrl+K): open windows, go to workspaces, act on the focused window and reach
 * the rest of the app by typing. Its search field takes the focus while it is open, so Space
 * types there; the field lets go of it the moment the launcher closes, so Space is STOP again
 * while the dialog fades out.
 *
 * @param onAction Runs a keymap action, so that the launcher and the keys do the same thing.
 */
export function Launcher({ onAction }: { readonly onAction: (action: KeyAction) => void }) {
  const store = useShellStore();
  const open = useShell((state) => state.overlay === 'launcher');
  const workspaces = useShell((state) => state.desktop.workspaces);
  const hasFocus = useShell((state) => focusedWindow(activeWorkspace(state.desktop)) !== null);
  const bindings = useShell((state) => state.bindings);
  const presets = useShell((state) => state.presets);
  const robotPackage = useRobotPackage()?.package ?? null;
  const packagePresets = robotPackage?.presets ?? [];
  const packageName = robotPackage?.displayName;

  const close = () => store.getState().setOverlay(null);
  const run = (action: () => void) => () => {
    close();
    action();
  };
  const shortcut = (action: KeyAction) => {
    const chord = bindings.get(action)?.[0];
    return chord === undefined ? null : (
      <CommandShortcut>{formatChord(chord).join('+')}</CommandShortcut>
    );
  };

  const shortcutFor = (action: KeyAction | null) => (action === null ? null : shortcut(action));

  useEffect(() => {
    const focused = document.activeElement;

    if (!open && focused instanceof HTMLElement && focused.closest('[cmdk-root]') !== null) {
      focused.blur();
    }
  }, [open]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => store.getState().setOverlay(next ? 'launcher' : null)}
      title="Launcher"
      description="Open a window or run an action"
      showCloseButton={false}
    >
      <CommandInput placeholder="Open a window or run an action…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Open a window">
          {WINDOW_KINDS.map((kind) => {
            const Icon = kind.icon;
            return (
              <CommandItem
                key={kind.id}
                value={`open ${kind.title} ${kind.description}`}
                onSelect={run(() => store.getState().openWindow(kind.id))}
              >
                <Icon />
                {kind.title}
                <span className="text-muted-foreground">{kind.description}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        {hasFocus ? (
          <CommandGroup heading="Focused window">
            <CommandItem onSelect={run(() => onAction('window.maximize'))}>
              <MaximizeIcon />
              Maximize or restore
              {shortcut('window.maximize')}
            </CommandItem>
            <CommandItem onSelect={run(() => onAction('window.float'))}>
              <PictureInPicture2Icon />
              Float or tile
              {shortcut('window.float')}
            </CommandItem>
            <CommandItem onSelect={run(() => onAction('window.pause'))}>
              <PauseIcon />
              Pause or resume
              {shortcut('window.pause')}
            </CommandItem>
            <CommandItem onSelect={run(() => onAction('window.close'))}>
              <XIcon />
              Close
              {shortcut('window.close')}
            </CommandItem>
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Workspaces">
          {workspaces.map((workspace, index) => (
            <CommandItem
              key={workspace.name}
              value={`workspace ${index + 1} ${workspace.name}`}
              onSelect={run(() => store.getState().run({ type: 'switchWorkspace', index }))}
            >
              <LayoutGridIcon />
              Go to {workspace.name}
              {shortcutFor(workspaceAction(index))}
            </CommandItem>
          ))}
          <CommandItem onSelect={run(() => store.getState().addWorkspace())}>
            <PlusIcon />
            New workspace
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Layouts">
          <CommandItem
            value="save workspace as a layout"
            onSelect={run(() => store.getState().setLayoutsOpen(true, { kind: 'save' }))}
          >
            <SaveIcon />
            Save workspace as a layout…
          </CommandItem>
          {packagePresets.map((preset) => (
            <CommandItem
              key={`package ${preset.name}`}
              value={`apply layout ${preset.name} robot`}
              onSelect={run(() => store.getState().applyPreset(preset))}
            >
              <LayoutTemplateIcon />
              Apply layout {preset.name}
              <span className="text-muted-foreground">{packageName}</span>
            </CommandItem>
          ))}
          {presets.flatMap((preset) => [
            <CommandItem
              key={`apply ${preset.name}`}
              value={`apply layout ${preset.name}`}
              onSelect={run(() => store.getState().applyPreset(preset))}
            >
              <LayoutTemplateIcon />
              Apply layout {preset.name}
            </CommandItem>,
            <CommandItem
              key={`rename ${preset.name}`}
              value={`rename layout ${preset.name}`}
              onSelect={run(() =>
                store.getState().setLayoutsOpen(true, { kind: 'rename', name: preset.name })
              )}
            >
              <PencilIcon />
              Rename layout {preset.name}…
            </CommandItem>,
            <CommandItem
              key={`delete ${preset.name}`}
              value={`delete layout ${preset.name}`}
              onSelect={run(() => store.getState().deletePreset(preset.name))}
            >
              <Trash2Icon />
              Delete layout {preset.name}
            </CommandItem>,
          ])}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="App">
          <CommandItem onSelect={run(() => store.getState().setOverlay('drawer'))}>
            <ListTreeIcon />
            Variables
            {shortcut('drawer')}
          </CommandItem>
          <CommandItem onSelect={run(() => store.getState().setConnectionOpen(true))}>
            <PlugIcon />
            Connection
          </CommandItem>
          <CommandItem onSelect={run(() => store.getState().toggleTheme())}>
            <MoonIcon />
            Toggle light and dark
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
