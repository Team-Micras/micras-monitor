import { useLayoutEffect, useRef } from 'react';

import {
  activeWorkspace,
  cornerHandles,
  focusedWindow,
  layoutDesktop,
  layoutWorkspace,
} from '@/tiling';

import { Kbd } from '../components/ui/kbd';
import { formatChord } from '../keymap/chords';
import type { KeyAction } from '../keymap/keymap';
import { useShell, useShellStore } from '../state/shell-store';
import { windowTitle } from '../windows/registry';
import { CORNER_INSET, CornerHandle } from './corner-handle';
import { DropPreview } from './drop-preview';
import { GutterHandle } from './gutter-handle';
import { useScreenTabOrder } from './screen-tab-order';
import { tabOrder } from './tab-order';
import { WindowFrame } from './window-frame';

function Keys({ action }: { readonly action: KeyAction }) {
  const chord = useShell((state) => state.bindings.get(action)?.[0]);
  return chord === undefined ? null : formatChord(chord).map((key) => <Kbd key={key}>{key}</Kbd>);
}

/**
 * The tiling of every workspace as one flat list of absolutely positioned windows, keyed by
 * id in the order they were opened, so a window keeps its view mounted whatever moves it.
 * Only the active workspace is visible; its gaps resize the splits, and so do the corners where
 * two gaps meet, both at once. It is a stacking context of
 * its own, so however many windows float, the drawer, the launcher and popovers stay above.
 */
export function TilingView() {
  const store = useShellStore();
  const container = useRef<HTMLElement>(null);
  const desktop = useShell((state) => state.desktop);
  const metrics = useShell((state) => state.metrics);

  useLayoutEffect(() => {
    const element = container.current;

    if (element === null) {
      return undefined;
    }

    const measure = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      store.getState().setViewport({ x, y, width, height });
    };

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [store]);

  const workspace = activeWorkspace(desktop);
  const focused = focusedWindow(workspace);
  const placed = new Map(layoutDesktop(desktop, metrics).map((entry) => [entry.id, entry]));
  const { gutters } = layoutWorkspace(workspace, metrics);
  const order = tabOrder([...placed.values()]);
  useScreenTabOrder(container, {
    tiled: order.tiled.map((entry) => entry.id),
    floating: order.floating.map((entry) => entry.id),
  });
  const empty = workspace.root === null && workspace.floating.length === 0;

  return (
    <section
      ref={container}
      data-tiling
      className="absolute inset-0 isolate overflow-hidden"
      aria-label={`Workspace ${workspace.name}`}
    >
      {[...desktop.windows.values()].map((window) => {
        const entry = placed.get(window.id);

        if (entry === undefined) {
          return null;
        }

        const owner = desktop.workspaces[entry.workspace];
        return (
          <WindowFrame
            key={window.id}
            window={window}
            placed={entry}
            focused={entry.workspace === desktop.active && focused === window.id}
            maximized={owner.maximized === window.id}
            stackIndex={owner.floating.findIndex((floating) => floating.id === window.id)}
          />
        );
      })}
      {gutters.map((gutter) => {
        const [a, b] = gutter.between.map((id) => {
          const window = desktop.windows.get(id);
          return window === undefined ? id : windowTitle(window);
        });
        return <GutterHandle key={gutter.path} gutter={gutter} label={`Resize ${a} and ${b}`} />;
      })}
      {cornerHandles(desktop, metrics, CORNER_INSET).map((handle) => (
        <CornerHandle key={`${handle.id} ${handle.corner}`} handle={handle} />
      ))}
      {empty ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <p>This workspace is empty.</p>
          <p className="flex items-center gap-1.5">
            Open a window with <Keys action="launcher" /> or drag a variable here from{' '}
            <Keys action="drawer" />
          </p>
        </div>
      ) : null}
      <DropPreview />
    </section>
  );
}
