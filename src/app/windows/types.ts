/**
 * The windows of the shell as the tiling engine carries them.
 *
 * @module
 */

import type { TilingWindow } from '@/tiling';

/** What a window is configured with, which layouts save along with its kind. */
export interface WindowPayload {
  /** A title chosen for this window, instead of its kind's. */
  readonly title?: string;
  /** The variables it shows, by name, so a layout survives a schema that gains variables. */
  readonly variables: readonly string[];
}

/** A window of the shell. */
export type ShellWindow = TilingWindow<WindowPayload>;

/** What the component of a window receives. */
export interface WindowViewProps {
  readonly window: ShellWindow;
  /** Whether the user paused the window, which freezes what it shows. */
  readonly paused: boolean;
}
