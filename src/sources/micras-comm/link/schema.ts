import { decodeAccess, TYPE_SIZE, TypeCode, type Access } from '../wire';
import { asError } from './errors';
import { encodeSchemaRequest, type SchemaPage } from './messages';

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
 * Keeps schemas between connections, keyed by their hash, so that a robot running the same build is
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

/** Where loading the schema is after a HELLO_ACK or a page. */
export type SchemaProgress =
  /** The schema is the one already in use. */
  | { readonly kind: 'unchanged' }
  /** A schema is ready to use. */
  | {
      readonly kind: 'ready';
      readonly hash: number;
      readonly entries: readonly SchemaEntry[];
      readonly fromCache: boolean;
    }
  /** Pages are being waited for. */
  | { readonly kind: 'loading'; readonly received: number; readonly total: number }
  /** The page changed nothing. */
  | { readonly kind: 'ignored' };

/** What the schema loader needs from the link. */
export interface SchemaLoaderHost {
  /** Send a frame to the robot. */
  send(frame: Uint8Array): void;

  /** Report something that went wrong without stopping the link. */
  report(message: string): void;
}

/**
 * Learns the robot's schema: from what is already in use, from the cache, or page by page from
 * the robot, asking again from the first missing entry when a page is lost.
 *
 * It keeps a partly assembled schema across handshakes, so a retry only asks for what is missing.
 */
export class SchemaLoader {
  private adopted: { hash: number; entries: readonly SchemaEntry[] } | undefined;
  private assembler: SchemaAssembler | undefined;
  private gapRequestedFrom = -1;

  /**
   * @param cache Where schemas are kept between connections.
   * @param host What the loader needs from the link.
   */
  constructor(
    private readonly cache: SchemaCache,
    private readonly host: SchemaLoaderHost
  ) {}

  /** The schema in use: the one the last HELLO_ACK announced, once it is known. */
  get schema(): readonly SchemaEntry[] | undefined {
    return this.adopted?.entries;
  }

  /** The hash of the schema in use. */
  get hash(): number | undefined {
    return this.adopted?.hash;
  }

  /**
   * Start learning the schema a HELLO_ACK announced. A schema in use that is not the announced
   * one is forgotten at once, so nothing is read or written by it while the new one loads.
   *
   * @param hash The announced hash.
   * @param total The announced number of variables.
   */
  begin(hash: number, total: number): SchemaProgress {
    if (this.adopted?.hash === hash && this.adopted.entries.length === total) {
      return { kind: 'unchanged' };
    }

    this.adopted = undefined;

    const cached = this.loadCached(hash);

    if (cached?.length === total) {
      return this.adopt(hash, cached, true);
    }

    if (this.assembler?.hash !== hash || this.assembler.total !== total) {
      this.assembler = new SchemaAssembler(hash, total);
    }

    this.gapRequestedFrom = -1;
    return this.request(this.assembler);
  }

  /**
   * Take a page in.
   *
   * @param page The page as it arrived.
   */
  accept(page: SchemaPage): SchemaProgress {
    const assembler = this.assembler;

    if (!assembler) {
      return { kind: 'ignored' };
    }

    const outcome = assembler.accept(page);

    if (outcome === 'complete') {
      this.assembler = undefined;
      this.storeCached(assembler.hash, assembler.result());
      return this.adopt(assembler.hash, assembler.result(), false);
    }

    if (outcome === 'gap') {
      return this.askAgainAfterGap(assembler);
    }

    if (outcome === 'progress') {
      this.gapRequestedFrom = -1;
      return progressOf(assembler);
    }

    if (outcome === 'invalid') {
      this.host.report(`A schema page from ${page.first} names a type this monitor does not know`);
    }

    return { kind: 'ignored' };
  }

  /**
   * Pages the robot sent before it saw the new request still arrive after the same gap, and must
   * not each trigger a request of their own.
   */
  private askAgainAfterGap(assembler: SchemaAssembler): SchemaProgress {
    if (assembler.firstMissing === this.gapRequestedFrom) {
      return progressOf(assembler);
    }

    this.gapRequestedFrom = assembler.firstMissing;
    return this.request(assembler);
  }

  private request(assembler: SchemaAssembler): SchemaProgress {
    this.host.send(encodeSchemaRequest(assembler.firstMissing));
    return progressOf(assembler);
  }

  private adopt(hash: number, entries: readonly SchemaEntry[], fromCache: boolean): SchemaProgress {
    this.adopted = { hash, entries };
    return { kind: 'ready', hash, entries, fromCache };
  }

  private loadCached(hash: number): readonly SchemaEntry[] | undefined {
    try {
      return this.cache.load(hash);
    } catch (error) {
      this.host.report(`Reading the schema cache failed: ${asError(error).message}`);
      return undefined;
    }
  }

  private storeCached(hash: number, entries: readonly SchemaEntry[]): void {
    try {
      this.cache.store(hash, entries);
    } catch (error) {
      this.host.report(`Keeping the schema in the cache failed: ${asError(error).message}`);
    }
  }
}

function progressOf(assembler: SchemaAssembler): SchemaProgress {
  return { kind: 'loading', received: assembler.received, total: assembler.total };
}
