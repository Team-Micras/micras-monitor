/**
 * Keeps the desktop on screen and the layouts saved per robot in step: loads the layout of the
 * robot that connects, and saves changes to it a moment after they stop.
 *
 * @module
 */

import type { LayoutPreset, SchemaVariable } from '@/robot-kit';

import type { ShellState, ShellStore } from '../state/shell-store';
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
  #baseline: Pick<ShellState, 'desktop' | 'presets'>;
  #subject: LayoutSubject | null = null;
  #guarded = false;
  #touched = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | null = null;

  /**
   * @param store The shell's state, whose desktop and presets it swaps and saves.
   * @param book Where the layouts are kept.
   * @param delayMs How long after the last change a layout is saved.
   */
  constructor(store: ShellStore, book: LayoutBook, delayMs = SAVE_DELAY_MS) {
    this.#store = store;
    this.#book = book;
    this.#delayMs = delayMs;
    this.#baseline = store.getState();
  }

  /**
   * Shows the layout of the robot shown last, so that the desktop before a link is that robot's.
   * It does nothing once a robot is followed.
   */
  start(): void {
    const last = this.#book.last();
    const saved = this.#subject === null && last !== null ? this.#book.load(last, []) : null;

    if (saved?.desktop != null) {
      this.#store.getState().loadLayout(saved.desktop, saved.presets);
    }

    this.#baseline = this.#store.getState();
  }

  /**
   * Shows the layout of a robot, saving the one on screen first if it is another robot's.
   *
   * What the user did to the desktop before the first link is not lost: without a layout saved
   * for the robot it stays on screen and becomes the robot's, and the presets made meanwhile join
   * the robot's own. A saved entry that cannot be read is left as it is until the user changes
   * something, and copied aside before it is replaced.
   */
  follow(subject: LayoutSubject): void {
    if (this.#subject?.key === subject.key) {
      this.#subject = subject;
      return;
    }

    const first = this.#subject === null;
    const before = this.#store.getState();
    const edited =
      first &&
      (before.desktop !== this.#baseline.desktop || before.presets !== this.#baseline.presets);

    this.flush();
    this.#subject = subject;
    const names = subject.variables.map(({ name }) => name);
    const saved = this.#book.load(subject.key, names);
    const carried = edited ? before.presets : [];
    const presets = [
      ...(saved?.presets ?? []),
      ...carried.filter((preset) => !saved?.presets.some((own) => own.name === preset.name)),
    ];
    const desktop =
      saved?.desktop ??
      (edited
        ? before.desktop
        : subject.packagePresets.length > 0
          ? presetDesktop(subject.packagePresets)
          : autoLayout(subject.variables));
    this.#store.getState().loadLayout(desktop, presets);
    this.#guarded = this.#book.unreadable(subject.key);
    this.#touched = false;
    this.flush();
    this.#unsubscribe ??= this.#store.subscribe((next, previous) => {
      if (next.desktop !== previous.desktop || next.presets !== previous.presets) {
        this.#touched = true;
        this.#schedule();
      }
    });
  }

  /** Saves at once what waits to be saved. */
  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;

    if (this.#subject === null || (this.#guarded && !this.#touched)) {
      return;
    }

    if (this.#guarded) {
      this.#book.backup(this.#subject.key);
      this.#guarded = false;
    }

    const { desktop, presets } = this.#store.getState();
    const names = this.#subject.variables.map(({ name }) => name);
    this.#book.save(this.#subject.key, { desktop, presets }, names);
    this.#book.remember(this.#subject.key);
  }

  /** Saves what waits and lets go of the store; `follow` starts it again. */
  stop(): void {
    this.flush();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#subject = null;
    this.#baseline = this.#store.getState();
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), this.#delayMs);
  }
}
