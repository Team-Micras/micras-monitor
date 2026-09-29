import {
  CheckIcon,
  ChevronDownIcon,
  LayoutTemplateIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import type { LayoutPreset } from '@/robot-kit';
import { activeWorkspace } from '@/tiling';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { useRobotPackage } from '../monitor-context';
import { useShell, useShellStore } from '../state/shell-store';

/**
 * The layouts menu of the top bar: the presets of the robot's package, which are read only, and
 * the user's own, which can be applied, renamed and deleted; and a field to save the active
 * workspace as a new one. Applying a preset adds it as a workspace.
 */
export function LayoutsMenu() {
  const store = useShellStore();
  const open = useShell((state) => state.layoutsOpen);
  const intent = useShell((state) => state.layoutsIntent);
  const presets = useShell((state) => state.presets);
  const workspaceName = useShell((state) => activeWorkspace(state.desktop).name);
  const pkg = useRobotPackage()?.package ?? null;
  const [name, setName] = useState('');
  const wanted = useRef<string | null | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const packageNames = pkg?.presets.map((preset) => preset.name) ?? [];
  const suggestion = packageNames.includes(workspaceName)
    ? `${workspaceName} (mine)`
    : workspaceName;
  const target = name.trim() === '' ? suggestion : name.trim();
  const replaces = presets.some((preset) => preset.name === target);

  useEffect(() => {
    const focus = wanted.current;

    if (focus === undefined) {
      return;
    }

    wanted.current = undefined;
    const row =
      focus === null
        ? null
        : content.current?.querySelector(`[data-preset="${CSS.escape(focus)}"] [data-apply]`);
    (row instanceof HTMLElement ? row : field.current)?.focus();
  });

  const remove = (preset: string) => {
    const index = presets.findIndex((entry) => entry.name === preset);
    wanted.current = (presets[index + 1] ?? presets[index - 1])?.name ?? null;
    store.getState().deletePreset(preset);
  };

  const apply = (preset: LayoutPreset) => {
    store.getState().applyPreset(preset);
    store.getState().setLayoutsOpen(false);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();

    if (store.getState().savePreset(target)) {
      setName('');
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => store.getState().setLayoutsOpen(next)}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 rounded-full pr-3 pl-3.5 font-normal">
          <LayoutTemplateIcon aria-hidden />
          <span className="font-medium">Layouts</span>
          <ChevronDownIcon className="text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        align="end"
        className="flex w-80 flex-col gap-4 p-3"
        onEscapeKeyDown={(event) => {
          if (store.getState().layoutsIntent?.kind === 'rename') {
            event.preventDefault();
            store.getState().setLayoutsOpen(true);
          }
        }}
        onOpenAutoFocus={(event) => {
          if (store.getState().layoutsIntent?.kind === 'save') {
            event.preventDefault();
            field.current?.focus();
          }
        }}
      >
        {pkg === null || pkg.presets.length === 0 ? null : (
          <Section heading={`${pkg.displayName} layouts`}>
            {pkg.presets.map((preset) => (
              <li key={preset.name} data-preset={preset.name}>
                <button
                  type="button"
                  onClick={() => apply(preset)}
                  className="flex h-9 w-full items-center rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span className="truncate">{preset.name}</span>
                </button>
              </li>
            ))}
          </Section>
        )}
        <Section heading="Your layouts">
          {presets.length === 0 ? (
            <li className="px-2.5 py-1 text-sm text-muted-foreground">
              None yet. Save the workspace you are looking at.
            </li>
          ) : (
            presets.map((preset) =>
              intent?.kind === 'rename' && intent.name === preset.name ? (
                <RenameRow
                  key={preset.name}
                  name={preset.name}
                  onDone={(focus) => (wanted.current = focus)}
                />
              ) : (
                <li
                  key={preset.name}
                  data-preset={preset.name}
                  className="flex items-center gap-0.5"
                >
                  <button
                    type="button"
                    data-apply
                    onClick={() => apply(preset)}
                    className="flex h-9 min-w-0 flex-1 items-center rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <span className="truncate">{preset.name}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label={`Rename ${preset.name}`}
                    onClick={() =>
                      store.getState().setLayoutsOpen(true, { kind: 'rename', name: preset.name })
                    }
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label={`Delete ${preset.name}`}
                    onClick={() => remove(preset.name)}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              )
            )
          )}
        </Section>
        <form onSubmit={save} className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <Input
              ref={field}
              value={name}
              aria-label="Layout name"
              placeholder={suggestion}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" variant="outline">
              {replaces ? 'Replace' : 'Save'}
            </Button>
          </div>
          <p className="px-0.5 text-xs text-muted-foreground">
            Saves the tiles of {workspaceName} as a layout.{' '}
            {target !== workspaceName && name.trim() === ''
              ? 'A robot layout has that name.'
              : null}
          </p>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function Section({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2.5 text-xs font-medium text-muted-foreground">{heading}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function RenameRow({
  name,
  onDone,
}: {
  readonly name: string;
  readonly onDone: (focus: string) => void;
}) {
  const store = useShellStore();
  const [text, setText] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const exists = useShell((state) => state.presets.some((preset) => preset.name === text.trim()));
  const taken = exists && text.trim() !== name;

  useEffect(() => field.current?.select(), []);

  const finish = (focus: string) => {
    store.getState().setLayoutsOpen(true);
    onDone(focus);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (store.getState().renamePreset(name, text)) {
      finish(text.trim());
    }
  };

  return (
    <li data-preset={name}>
      <form onSubmit={submit} className="flex items-center gap-0.5">
        <Input
          value={text}
          aria-label={`New name for ${name}`}
          aria-invalid={taken}
          className="h-9 flex-1"
          onChange={(event) => setText(event.target.value)}
          ref={field}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          aria-label="Rename"
          disabled={taken || text.trim() === ''}
        >
          <CheckIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel"
          onClick={() => finish(name)}
        >
          <XIcon />
        </Button>
      </form>
    </li>
  );
}
