/**
 * The drag slice of the shell's state: a window or a variable being dragged, where it would land,
 * and what dropping it does.
 *
 * @module
 */

import {
  activeWorkspace,
  applyDrop,
  containsPoint,
  hitTest,
  layoutWorkspace,
  usableBounds,
  type Point,
  type Rect,
  type WindowId,
} from '@/tiling';

import { PLOT_KIND, windowKind } from '../../windows/registry';
import type {
  DragSlice,
  DragSubject,
  DragSurroundings,
  ShellDropTarget,
  ShellState,
  SliceTools,
} from './types';

function accepts(state: ShellState, id: WindowId): boolean {
  return windowKind(state.desktop.windows.get(id)?.kind ?? '').acceptsVariables;
}

/** Creates the drag slice. */
export function dragSlice({ set, get, setDesktop }: SliceTools): DragSlice {
  const local = (pointer: Point): Point => {
    const { origin } = get();
    return { x: pointer.x - origin.x, y: pointer.y - origin.y };
  };

  const floatingRect = (id: WindowId): Rect | null =>
    activeWorkspace(get().desktop).floating.find((entry) => entry.id === id)?.rect ?? null;

  const targetFor = (
    subject: DragSubject,
    pointer: Point,
    surroundings: DragSurroundings
  ): ShellDropTarget | null => {
    const state = get();
    const { desktop, metrics } = state;

    if (surroundings.tab !== null && subject.kind === 'window') {
      return surroundings.tab === desktop.active
        ? null
        : { kind: 'workspace', index: surroundings.tab };
    }

    if (!surroundings.overTiling) {
      return null;
    }

    const point = local(pointer);
    const dragged = subject.kind === 'window' ? subject.id : null;
    const target = hitTest(desktop, dragged, point, metrics);

    if (subject.kind === 'variable') {
      const floating = layoutWorkspace(activeWorkspace(desktop), metrics).windows.findLast(
        (window) => window.visible && window.floating && containsPoint(window.rect, point)
      );

      if (floating !== undefined) {
        return accepts(state, floating.id)
          ? { kind: 'center', id: floating.id, preview: floating.rect }
          : null;
      }

      if (target === null) {
        return activeWorkspace(desktop).root === null
          ? { kind: 'new', preview: usableBounds(metrics) }
          : null;
      }

      return target.kind === 'center' && !accepts(state, target.id) ? null : target;
    }

    return target;
  };

  return {
    drag: null,

    beginDrag: (subject, pointer) => {
      const rect = subject.kind === 'window' ? floatingRect(subject.id) : null;
      const point = local(pointer);
      const grab = rect === null ? null : { x: point.x - rect.x, y: point.y - rect.y };
      set({ drag: { subject, pointer, target: null, grab } });
    },

    moveDrag: (pointer, surroundings) => {
      const { drag } = get();

      if (drag === null) {
        return;
      }

      const { subject, grab } = drag;

      if (subject.kind === 'window' && grab !== null && surroundings.tab === null) {
        const rect = floatingRect(subject.id);

        if (rect !== null) {
          const point = local(pointer);
          get().placeFloating(subject.id, { ...rect, x: point.x - grab.x, y: point.y - grab.y });
        }

        set({ drag: { ...drag, pointer, target: null } });
        return;
      }

      set({ drag: { ...drag, pointer, target: targetFor(subject, pointer, surroundings) } });
    },

    endDrag: () => {
      const { drag, desktop, metrics } = get();
      set({ drag: null });

      if (drag?.target == null) {
        return;
      }

      const { subject, target } = drag;

      if (subject.kind === 'window') {
        if (target.kind !== 'new' && desktop.windows.has(subject.id)) {
          setDesktop(applyDrop(desktop, subject.id, target, metrics));
        }

        return;
      }

      switch (target.kind) {
        case 'center':
          get().addVariable(target.id, subject.name);
          get().run({ type: 'focusWindow', id: target.id });
          return;
        case 'edge':
          get().openWindow(PLOT_KIND, [subject.name], { target: target.id, side: target.side });
          return;
        case 'new':
          get().openWindow(PLOT_KIND, [subject.name]);
          return;
        case 'workspace':
          return;
      }
    },

    cancelDrag: () => set({ drag: null }),
  };
}
