import { failure } from '@cp2p/engine';
import type { CommandShape, Result } from '@cp2p/engine';
import type { SignedCommand } from '@cp2p/protocol';
import type { VerifiedNonVoterActor } from '@cp2p/protocol/testing';

const RETRY_MS = 250;

/** Keep one intent while virtual deliveries run, resending only at its original parent. */
export class NonVoterCommand {
  readonly #actor: Pick<VerifiedNonVoterActor, 'submit'>;
  readonly #command: CommandShape;
  readonly #parent: { seq: number; hash: string };
  #result: Result<SignedCommand> | null = null;
  #inFlight = false;
  #cancelled = false;
  #retryAt = -Infinity;

  constructor(
    actor: Pick<VerifiedNonVoterActor, 'submit'>,
    command: CommandShape,
    parent: { seq: number; hash: string },
  ) {
    this.#actor = actor;
    this.#command = command;
    this.#parent = { ...parent };
  }

  result(): Result<SignedCommand> | null {
    return this.#result;
  }

  pump(now: number, head: { seq: number; hash: string }): void {
    if (head.seq !== this.#parent.seq || head.hash !== this.#parent.hash) {
      this.#result ??= failure(
        'non-voter-stale-head',
        'Actor submission parent is no longer current',
      );
      this.cancel();
      return;
    }
    if (this.#cancelled || this.#inFlight || now < this.#retryAt || this.#result?.ok === false)
      return;
    this.#inFlight = true;
    this.#retryAt = now + RETRY_MS;
    // Do not await here: preparing a trade needs future virtual network deliveries.
    void Promise.resolve()
      .then(() => this.#actor.submit(this.#command, this.#parent))
      .then((result) => {
        if (!this.#cancelled) this.#result = result;
        return undefined;
      })
      .catch(() => {
        if (!this.#cancelled)
          this.#result = failure('non-voter-submit-threw', 'Actor submission threw unexpectedly');
      })
      .finally(() => {
        this.#inFlight = false;
      });
  }

  cancel(): void {
    this.#cancelled = true;
  }
}
