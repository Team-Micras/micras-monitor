import { encodeSchemaRequest, type SchemaPage } from './messages';
import { SchemaAssembler, type SchemaCache, type SchemaEntry } from './schema';
import { asError } from './transport';

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

/** What the schema loader needs from the session. */
export interface SchemaLoaderHost {
  /** Send a frame to the robot. */
  send(frame: Uint8Array): void;

  /** Report something that went wrong without stopping the session. */
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
   * @param cache Where schemas are kept between sessions.
   * @param host What the loader needs from the session.
   */
  constructor(
    private readonly cache: SchemaCache,
    private readonly host: SchemaLoaderHost
  ) {}

  /** The schema in use, once one is known. */
  get schema(): readonly SchemaEntry[] | undefined {
    return this.adopted?.entries;
  }

  /** The hash of the schema in use. */
  get hash(): number | undefined {
    return this.adopted?.hash;
  }

  /**
   * Start learning the schema a HELLO_ACK announced.
   *
   * @param hash The announced hash.
   * @param total The announced number of variables.
   */
  begin(hash: number, total: number): SchemaProgress {
    if (this.adopted?.hash === hash && this.adopted.entries.length === total) {
      return { kind: 'unchanged' };
    }

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
