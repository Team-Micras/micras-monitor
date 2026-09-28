/**
 * Split tree primitives. Every function is pure and returns the same node when nothing changes.
 *
 * @module
 */

import type { LeafNode, NodePath, Orientation, Side, SplitNode, TileNode, WindowId } from './types';

/** Creates a leaf tile for a window. */
export function leaf(id: WindowId): LeafNode {
  return { type: 'leaf', id };
}

/** Creates a split tile; `ratio` is the first child's share. */
export function split(
  orientation: Orientation,
  ratio: number,
  first: TileNode,
  second: TileNode
): SplitNode {
  return { type: 'split', orientation, ratio, first, second };
}

/** Lists the windows of a tree in depth-first order, first children before second ones. */
export function leafIds(node: TileNode | null): WindowId[] {
  if (node === null) {
    return [];
  }

  if (node.type === 'leaf') {
    return [node.id];
  }

  return [...leafIds(node.first), ...leafIds(node.second)];
}

/** The first window of a tree in depth-first order, or null for an empty tree. */
export function firstLeafId(node: TileNode): WindowId;
export function firstLeafId(node: TileNode | null): WindowId | null;
export function firstLeafId(node: TileNode | null): WindowId | null {
  if (node === null) {
    return null;
  }

  return node.type === 'leaf' ? node.id : firstLeafId(node.first);
}

/** The node at a path, or null when the path leaves the tree. */
export function nodeAt(node: TileNode | null, path: NodePath): TileNode | null {
  if (node === null || path === '') {
    return node;
  }

  if (node.type === 'leaf') {
    return null;
  }

  return nodeAt(path[0] === '0' ? node.first : node.second, path.slice(1));
}

/** The path of a window's leaf, or null when the window is not in the tree. */
export function pathOf(node: TileNode | null, id: WindowId): NodePath | null {
  if (node === null) {
    return null;
  }

  if (node.type === 'leaf') {
    return node.id === id ? '' : null;
  }

  const inFirst = pathOf(node.first, id);

  if (inFirst !== null) {
    return `0${inFirst}`;
  }

  const inSecond = pathOf(node.second, id);
  return inSecond === null ? null : `1${inSecond}`;
}

/** Tells whether a window is tiled in the tree. */
export function containsLeaf(node: TileNode | null, id: WindowId): boolean {
  return pathOf(node, id) !== null;
}

/**
 * The path of the subtree holding exactly a set of windows, in any arrangement, or null when no
 * subtree does.
 */
export function findSubtree(node: TileNode | null, ids: readonly WindowId[]): NodePath | null {
  if (node === null || ids.length === 0) {
    return null;
  }

  const wanted = new Set(ids);
  const leaves = leafIds(node);

  if (leaves.length === wanted.size && leaves.every((id) => wanted.has(id))) {
    return '';
  }

  if (node.type === 'leaf') {
    return null;
  }

  const inFirst = findSubtree(node.first, ids);

  if (inFirst !== null) {
    return `0${inFirst}`;
  }

  const inSecond = findSubtree(node.second, ids);
  return inSecond === null ? null : `1${inSecond}`;
}

/** The orientation of the split that puts a window against a side. */
export function orientationOf(side: Side): Orientation {
  return side === 'left' || side === 'right' ? 'row' : 'column';
}

/** Tells whether a window placed against a side becomes the first child of the split. */
export function comesFirst(side: Side): boolean {
  return side === 'left' || side === 'top';
}

/** The side of a split's `first` or `second` child. */
export function sideOf(orientation: Orientation, first: boolean): Side {
  if (orientation === 'row') {
    return first ? 'left' : 'right';
  }

  return first ? 'top' : 'bottom';
}

/**
 * Replaces the node at a path by the result of `update`. Returns the tree unchanged when the path
 * leaves it or the update changes nothing.
 */
export function updateAt(
  node: TileNode,
  path: NodePath,
  update: (node: TileNode) => TileNode
): TileNode {
  if (path === '') {
    return update(node);
  }

  if (node.type === 'leaf') {
    return node;
  }

  if (path[0] === '0') {
    const first = updateAt(node.first, path.slice(1), update);
    return first === node.first ? node : { ...node, first };
  }

  const second = updateAt(node.second, path.slice(1), update);
  return second === node.second ? node : { ...node, second };
}

/**
 * Puts a new window beside the node at a path: that node and the window become the two children
 * of a new split, the window on `side` and `ratio` as the first child's share.
 */
export function insertBeside(
  node: TileNode,
  path: NodePath,
  id: WindowId,
  side: Side,
  ratio: number
): TileNode {
  return updateAt(node, path, (existing) => {
    const added = leaf(id);
    const [first, second] = comesFirst(side) ? [added, existing] : [existing, added];
    return split(orientationOf(side), ratio, first, second);
  });
}

/** A tree after a window was taken out of it, and the path of the subtree that took its space. */
export interface Removal {
  readonly root: TileNode | null;
  readonly promoted: NodePath | null;
}

/**
 * Takes a window's leaf out and promotes its sibling into the parent's place, so the sibling
 * covers the freed space and no hole is left. An unknown window leaves the tree unchanged.
 */
export function removeLeaf(node: TileNode, id: WindowId): Removal {
  const path = pathOf(node, id);

  if (path === null) {
    return { root: node, promoted: null };
  }

  if (path === '') {
    return { root: null, promoted: null };
  }

  const parent = path.slice(0, -1);
  const root = updateAt(node, parent, (above) =>
    above.type === 'split' ? (path.endsWith('0') ? above.second : above.first) : above
  );
  return { root, promoted: parent };
}

/** Exchanges the leaves of two windows. The tree is unchanged unless both are in it. */
export function swapLeaves(node: TileNode, a: WindowId, b: WindowId): TileNode {
  const pathA = pathOf(node, a);
  const pathB = pathOf(node, b);

  if (a === b || pathA === null || pathB === null) {
    return node;
  }

  return updateAt(
    updateAt(node, pathA, () => leaf(b)),
    pathB,
    () => leaf(a)
  );
}

/** Sets the ratio of the split at a path. The tree is unchanged when no split lives there. */
export function setRatioAt(node: TileNode, path: NodePath, ratio: number): TileNode {
  return updateAt(node, path, (target) =>
    target.type === 'split' && target.ratio !== ratio ? { ...target, ratio } : target
  );
}
