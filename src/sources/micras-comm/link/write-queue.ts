import { ErrorCode, WriteStatus, type WireValue } from '../wire';
import { asError } from './errors';
import type { LinkContext, WriteEvent, WriteResult } from './link-events';
import { encodeWrite } from './messages';

interface Write {
  readonly value: WireValue;
  readonly bytes: Uint8Array;
  resolve(result: WriteResult): void;
  reject(error: Error): void;
}

/**
 * The writes to the robot's variables, at most one in flight per variable.
 *
 * A WRITE_ACK names only the variable, so two writes of the same variable in flight could not be
 * told apart once one of them is lost. A write made while another of the same variable waits for
 * its answer is held back and sent after it; a newer one replaces it before it is sent, and the
 * newest value always ends up on the robot.
 */
export class WriteQueue {
  readonly #context: LinkContext;
  readonly #inFlight = new Map<number, Write>();
  readonly #held = new Map<number, Write>();

  /**
   * @param context What the writes share with their link.
   */
  constructor(context: LinkContext) {
    this.#context = context;
  }

  /**
   * Write a variable, now or once the write in flight for it is answered.
   *
   * @param variableId The variable.
   * @param value The value, already checked against its type.
   * @param bytes The value as it goes on the wire.
   * @returns What the robot answered, or that a newer write replaced this one first.
   */
  write(variableId: number, value: WireValue, bytes: Uint8Array): Promise<WriteResult> {
    return new Promise<WriteResult>((resolve, reject) => {
      const write: Write = { value, bytes, resolve, reject };

      this.#emit({ variableId, value, state: 'pending' });

      if (!this.#inFlight.has(variableId)) {
        void this.#send(variableId, write);
        return;
      }

      const replaced = this.#held.get(variableId);
      this.#held.set(variableId, write);

      if (replaced) {
        this.#emit({ variableId, value: replaced.value, state: 'superseded' });
        replaced.resolve({ status: 'superseded' });
      }
    });
  }

  /** The newest value written to a variable that the robot has not answered yet. */
  pending(variableId: number): WireValue | undefined {
    return (this.#held.get(variableId) ?? this.#inFlight.get(variableId))?.value;
  }

  /**
   * Fail every write held back, because what they were meant for is gone, such as the connection.
   * The writes in flight fail with their requests.
   */
  failHeld(error: Error): void {
    const held = [...this.#held];
    this.#held.clear();

    for (const [variableId, write] of held) {
      this.#emit({ variableId, value: write.value, state: 'failed', error });
      write.reject(error);
    }
  }

  async #send(variableId: number, first: Write): Promise<void> {
    let write: Write | undefined = first;

    while (write) {
      this.#inFlight.set(variableId, write);
      await this.#exchange(variableId, write);
      write = this.#held.get(variableId);
      this.#held.delete(variableId);
    }

    this.#inFlight.delete(variableId);
  }

  async #exchange(variableId: number, write: Write): Promise<void> {
    const { value } = write;
    const answer = this.#context.requests.add(
      'write',
      variableId,
      this.#context.timing.requestTimeoutMs,
      (code, context) => code === ErrorCode.MALFORMED && context === variableId
    );

    this.#context.send(encodeWrite(variableId, write.bytes));

    try {
      const status = await answer;
      this.#emit(
        status === WriteStatus.OK
          ? { variableId, value, state: 'confirmed' }
          : { variableId, value, state: 'refused', status }
      );
      write.resolve({ status: 'answered', writeStatus: status });
    } catch (error) {
      this.#emit({ variableId, value, state: 'failed', error: asError(error) });
      write.reject(asError(error));
    }
  }

  #emit(event: WriteEvent): void {
    this.#context.emit('write', event);
  }
}
