/**
 * Keeps the desktop on screen and the layouts saved per robot in step: loads the layout of the
 * robot that connects, and saves changes to it a moment after they stop.
 *
 * @module
 */

import type { LayoutPreset, SchemaVariable } from '@/robot-kit';

import type { ShellStore } from '../state/shell-store';
import { autoLayout } from './auto-layout';
import type { LayoutBook } from './layout-book';
import { presetDesktop } from './presets';

/** How long after the last change a layout is saved. */
export const SAVE_DELAY_MS = 500;

/** The robot whose layout is on screen. */
export interface LayoutSubject {
  /** The robot's key, as `layoutKey` gives it. */
  readonly key: string;
  /** Its schema. */
  readonly variables: readonly SchemaVariable[];
  /** The presets of its package; none in raw mode. */
  readonly packagePresets: readonly LayoutPreset[];
}

/**
 * The layout of the connected robot. It follows one robot at a time: `follow` swaps the desktop
 * for that robot's saved layout, or for its initial one the first time, which is the package's
 * presets, else an automatic layout from the schema. From then on every change of the desktop or
 * of the user's presets is saved under the robot's key, after {@link SAVE_DELAY_MS} of quiet.
 *
 * Disconnecting is not something it sees: the layout stays on screen, and stays saved under the
 * same key, until another robot is followed.
 */
export class LayoutSession {
  readonly #store: ShellStore;
  readonly #book: LayoutBook;
  readonly #delayMs: number;
  #subject: LayoutSubject | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | null = null;

  constructor(store: ShellStore, book: LayoutBook, delayMs = SAVE_DELAY_MS) {
    this.#store = store;
    this.#book = book;
    this.#delayMs = delayMs;
  }

  /** Shows the layout of a robot, saving the one on screen first if it is another robot's. */
  follow(subject: LayoutSubject): void {
    if (this.#subject?.key === subject.key) {
      this.#subject = subject;
      return;
    }

    this.flush();
    this.#subject = subject;
    const names = subject.variables.map(({ name }) => name);
    const saved = this.#book.load(subject.key, names);
    const state = this.#store.getState();
    state.loadLayout(
      saved?.desktop ??
        (subject.packagePresets.length > 0
          ? presetDesktop(subject.packagePresets)
          : autoLayout(subject.variables)),
      saved?.presets ?? []
    );
    this.flush();
    this.#unsubscribe ??= this.#store.subscribe((next, previous) => {
      if (next.desktop !== previous.desktop || next.presets !== previous.presets) {
        this.#schedule();
      }
    });
  }

  /** Saves at once what waits to be saved. */
  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;

    if (this.#subject !== null) {
      const { desktop, presets } = this.#store.getState();
      const names = this.#subject.variables.map(({ name }) => name);
      this.#book.save(this.#subject.key, { desktop, presets }, names);
    }
  }

  /** Saves what waits and lets go of the store; `follow` starts it again. */
  stop(): void {
    this.flush();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#subject = null;
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), this.#delayMs);
  }
}
