/**
 * The layout a robot the monitor has no package for opens with, made from its schema alone: an
 * Overview with the link and the log, then a few workspaces of at most a few windows each, the
 * variables grouped by the prefix of their names.
 *
 * @module
 */

import { TypeCode } from '@/protocol';
import type { SchemaVariable } from '@/robot-kit';
import {
  createDesktop,
  createWorkspace,
  leaf,
  split,
  type Desktop,
  type TileNode,
  type Workspace,
} from '@/tiling';

import type { ShellWindow, WindowPayload } from '../windows/types';

/** The most windows one workspace of the automatic layout holds. */
export const MAX_WINDOWS_PER_WORKSPACE = 4;

/** The most workspaces of variables the automatic layout makes, besides the Overview. */
export const MAX_DATA_WORKSPACES = 5;

/** The most series one plot draws. */
export const MAX_PLOT_VARIABLES = 4;

/** The most values one readouts window shows. */
export const MAX_READOUT_VARIABLES = 6;

/** The most variables one editor window holds. */
export const MAX_EDITOR_VARIABLES = 3;

const OVERVIEW = 'Overview';
const ROOT_GROUP = 'General';

interface Panel {
  readonly kind: string;
  readonly title?: string;
  readonly variables: readonly string[];
}

interface Group {
  readonly title: string;
  readonly variables: readonly SchemaVariable[];
}

function isFloat({ type }: SchemaVariable): boolean {
  return type === TypeCode.F32 || type === TypeCode.F64;
}

function isBlob({ type }: SchemaVariable): boolean {
  return type === TypeCode.BLOB;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );
}

function groupTitle(prefix: string): string {
  const words = prefix.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function groupsOf(variables: readonly SchemaVariable[]): Group[] {
  const groups = new Map<string, SchemaVariable[]>();

  for (const variable of variables) {
    const slash = variable.name.indexOf('/');
    const title = slash > 0 ? groupTitle(variable.name.slice(0, slash)) : ROOT_GROUP;
    groups.set(title, [...(groups.get(title) ?? []), variable]);
  }

  return [...groups].map(([title, members]) => ({ title, variables: members }));
}

function namesOf(members: readonly SchemaVariable[]): string[] {
  return members.map(({ name }) => name);
}

function panelsOf({ title, variables }: Group): Panel[] {
  const plotted = variables.filter((variable) => variable.access.stream && isFloat(variable));
  const counted = variables.filter(
    (variable) =>
      variable.access.stream && !isFloat(variable) && !isBlob(variable) && !variable.access.write
  );
  const written = variables.filter((variable) => variable.access.write && !isBlob(variable));

  return [
    ...chunks(plotted, MAX_PLOT_VARIABLES).map((members, index) => ({
      kind: 'plot',
      title: index === 0 ? title : `${title} ${index + 1}`,
      variables: namesOf(members),
    })),
    ...chunks(counted, MAX_READOUT_VARIABLES).map((members) => ({
      kind: 'readouts',
      variables: namesOf(members),
    })),
    ...chunks(written, MAX_EDITOR_VARIABLES).map((members) => ({
      kind: 'editor',
      variables: namesOf(members),
    })),
    ...variables.filter(isBlob).map(({ name }) => ({
      kind: 'type-view',
      title: name,
      variables: [name],
    })),
  ];
}

interface Sheet {
  readonly titles: string[];
  readonly panels: Panel[];
}

function sheetsOf(groups: readonly Group[]): Sheet[] {
  const sheets: Sheet[] = [];
  const open = (): Sheet => {
    const sheet: Sheet = { titles: [], panels: [] };
    sheets.push(sheet);
    return sheet;
  };

  for (const group of groups) {
    const panels = panelsOf(group);
    const last = sheets.at(-1);
    const room = last === undefined ? 0 : MAX_WINDOWS_PER_WORKSPACE - last.panels.length;

    if (panels.length === 0) {
      continue;
    }

    let sheet = last !== undefined && panels.length <= room ? last : open();

    for (const panel of panels) {
      if (sheet.panels.length === MAX_WINDOWS_PER_WORKSPACE) {
        sheet = open();
      }

      sheet.panels.push(panel);

      if (!sheet.titles.includes(group.title)) {
        sheet.titles.push(group.title);
      }
    }
  }

  return sheets;
}

function arrange(ids: readonly string[]): TileNode | null {
  switch (ids.length) {
    case 0:
      return null;
    case 1:
      return leaf(ids[0]);
    case 2:
      return split('row', 0.5, leaf(ids[0]), leaf(ids[1]));
    case 3:
      return split('row', 0.5, leaf(ids[0]), split('column', 0.5, leaf(ids[1]), leaf(ids[2])));
    default:
      return split(
        'column',
        0.5,
        split('row', 0.5, leaf(ids[0]), leaf(ids[1])),
        split('row', 0.5, leaf(ids[2]), leaf(ids[3]))
      );
  }
}

function uniqueName(name: string, taken: ReadonlySet<string>): string {
  let candidate = name;

  for (let number = 2; taken.has(candidate); number += 1) {
    candidate = `${name} ${number}`;
  }

  return candidate;
}

function sheetName({ titles }: Sheet): string {
  return titles.length === 1 ? titles[0] : `${titles[0]} +${titles.length - 1}`;
}

/**
 * The starting desktop for a robot without a package. The first workspace, Overview, has the
 * Link and the Log. The variables are grouped by the prefix of their names, up to the first
 * slash (those without one form General), and each group gets, in schema order: plots of its
 * streamable floats, readouts of its other streamable numbers, editors of its writable
 * variables, and a type view for each blob. Groups fill workspaces in order, up to
 * {@link MAX_WINDOWS_PER_WORKSPACE} windows each; a group that does not fit in the room left
 * starts a fresh workspace rather than being cut, and only one larger than a workspace spills
 * into the next. At most {@link MAX_DATA_WORKSPACES} of them are made, so the rest
 * stays in the variable drawer.
 *
 * It depends only on the schema, so the same schema always gives the same desktop.
 */
export function autoLayout(variables: readonly SchemaVariable[]): Desktop<WindowPayload> {
  const windows: ShellWindow[] = [];
  const nextWindow = (panel: Panel): string => {
    const id = `${panel.kind}-${windows.length + 1}`;
    const payload: WindowPayload =
      panel.title === undefined
        ? { variables: panel.variables }
        : { title: panel.title, variables: panel.variables };
    windows.push({ id, kind: panel.kind, payload });
    return id;
  };

  const workspaces: Workspace[] = [
    createWorkspace(
      OVERVIEW,
      arrange([
        nextWindow({ kind: 'link', variables: [] }),
        nextWindow({ kind: 'log', variables: [] }),
      ])
    ),
  ];
  const names = new Set([OVERVIEW]);

  for (const sheet of sheetsOf(groupsOf(variables)).slice(0, MAX_DATA_WORKSPACES)) {
    const name = uniqueName(sheetName(sheet), names);
    names.add(name);
    workspaces.push(createWorkspace(name, arrange(sheet.panels.map(nextWindow))));
  }

  return createDesktop(workspaces, windows);
}
