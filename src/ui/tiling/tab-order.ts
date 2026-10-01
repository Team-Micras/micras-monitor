import type { DesktopWindow } from '@/tiling';

/** The windows on screen split by how the keyboard reaches them; see {@link tabOrder}. */
export interface TabOrder {
  readonly tiled: readonly DesktopWindow[];
  readonly floating: readonly DesktopWindow[];
}

/**
 * The windows on screen in the order Tab should reach them: the tiles from the top-left corner
 * to the bottom-right, row by row, then the floating windows in stacking order. Windows of other
 * workspaces cannot be reached and are left out.
 */
export function tabOrder(windows: readonly DesktopWindow[]): TabOrder {
  return {
    tiled: windows
      .filter((entry) => entry.visible && !entry.floating)
      .toSorted((a, b) => Math.round(a.rect.y) - Math.round(b.rect.y) || a.rect.x - b.rect.x),
    floating: windows.filter((entry) => entry.visible && entry.floating),
  };
}
