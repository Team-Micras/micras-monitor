import { decodeAccess, TYPE_SIZE, TypeCode, type Access } from '../wire';
import type { SchemaPage } from './messages';

/** One variable of the robot, as its schema describes it. */
export interface SchemaEntry {
  /** Its position in the schema, which is what every message names it by. */
  readonly id: number;
  readonly name: string;
  readonly type: TypeCode;
  readonly access: Access;
  /** How the bytes of a blob are to be read, such as `maze-grid`; only blobs have one. */
  readonly typeTag?: string;
}

/**
 * Keeps schemas between sessions, keyed by their hash, so that a robot running the same build is
 * learned once. The link keeps no storage of its own; the application injects one, such as a
 * `localStorage` adapter.
 */
export interface SchemaCache {
  /** The schema with this hash, if one was stored. */
  load(hash: number): readonly SchemaEntry[] | undefined;

  /** Keep a schema that was received whole. */
  store(hash: number, entries: readonly SchemaEntry[]): void;
}

/** A schema cache that lasts as long as the page. */
export class MemorySchemaCache implements SchemaCache {
  private readonly schemas = new Map<number, readonly SchemaEntry[]>();

  load(hash: number): readonly SchemaEntry[] | undefined {
    return this.schemas.get(hash);
  }

  store(hash: number, entries: readonly SchemaEntry[]): void {
    this.schemas.set(hash, entries);
  }
}

/** What a schema page did to the schema being assembled. */
export type PageOutcome =
  /** The page belongs to another schema. */
  | 'ignored'
  /** The page continued where the last one ended. */
  | 'progress'
  /** The page started past an entry that never arrived. */
  | 'gap'
  /** Every entry has arrived. */
  | 'complete'
  /** The page names a type this monitor does not know, so none of it was taken. */
  | 'invalid';

/**
 * Puts a schema together from pages, which can go missing: the robot charges them to the credit
 * window and the radio module drops what does not fit its buffer.
 */
export class SchemaAssembler {
  private readonly entries: (SchemaEntry | undefined)[];
  private filled = 0;

  /**
   * @param hash The hash HELLO_ACK announced.
   * @param total How many variables HELLO_ACK announced.
   */
  constructor(
    readonly hash: number,
    readonly total: number
  ) {
    this.entries = Array.from({ length: total }, () => undefined);
  }

  /**
   * Take a page in.
   *
   * @param page The page as it arrived.
   * @returns What it changed.
   */
  accept(page: SchemaPage): PageOutcome {
    if (page.schemaHash !== this.hash || page.total !== this.total) {
      return 'ignored';
    }

    if (!page.entries.every((entry) => isTypeCode(entry.type))) {
      return 'invalid';
    }

    const gap = page.first > this.firstMissing;

    page.entries.forEach((entry, offset) => this.fill(page.first + offset, entry));

    if (this.complete) {
      return 'complete';
    }

    return gap ? 'gap' : 'progress';
  }

  /** The first entry still missing, which is where to ask the robot to start again. */
  get firstMissing(): number {
    const index = this.entries.indexOf(undefined);
    return index === -1 ? this.total : index;
  }

  /** How many entries have arrived. */
  get received(): number {
    return this.filled;
  }

  /** Whether every entry has arrived. */
  get complete(): boolean {
    return this.filled === this.total;
  }

  /** The schema, once complete. */
  result(): readonly SchemaEntry[] {
    if (!this.complete) {
      throw new Error(`Schema has ${this.filled} of ${this.total} entries`);
    }

    return this.entries.filter((entry) => entry !== undefined);
  }

  private fill(id: number, entry: SchemaPage['entries'][number]): void {
    if (id >= this.total) {
      return;
    }

    if (!this.entries[id]) {
      this.filled++;
    }

    const base = { id, name: entry.name, type: entry.type, access: decodeAccess(entry.access) };

    this.entries[id] = entry.typeTag === null ? base : { ...base, typeTag: entry.typeTag };
  }
}

function isTypeCode(code: number): code is TypeCode {
  return Number.isInteger(code) && code in TYPE_SIZE;
}
