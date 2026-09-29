import type { CommandShape, GameState, PrivateState, Seat, TradeOffer } from '@cp2p/engine';
import type { BotLevel } from '../types.js';
import { createBotView } from '../view.js';
import type { BotHost } from './host.js';
import type { BotRequest, BotResponse, PlayerPending } from './messages.js';

/** The two ends of a message channel: a Web Worker, a Node worker thread, or in-process. */
export interface BotPort {
  postMessage(message: BotRequest): void;
  /** Subscribe to responses; returns the unsubscribe function. */
  listen(listener: (message: unknown) => void): () => void;
  close?(): void;
}

/** A port for a browser `Worker` running `serveBotHost`. */
export function workerPort(worker: {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}): BotPort {
  return {
    // A dedicated worker's postMessage has no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    postMessage: (message) => worker.postMessage(message),
    listen(listener) {
      const handler = (event: { data: unknown }): void => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
    close: () => worker.terminate(),
  };
}

/** A port to a host in the same thread (tests, and environments without workers). */
export function inProcessPort(host: BotHost): BotPort {
  const listeners = new Set<(message: unknown) => void>();
  return {
    postMessage(message) {
      // Structured cloning is what a worker boundary does; do the same so nothing is shared.
      const copy = structuredClone(message);
      queueMicrotask(() => {
        const response = structuredClone(host.handle(copy));
        for (const listener of listeners) listener(response);
      });
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Serve a bot host on a worker's global scope (`self` in a Web Worker). */
export function serveBotHost(
  scope: {
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    postMessage(message: unknown): void;
  },
  host: BotHost,
): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  scope.addEventListener('message', (event) => scope.postMessage(host.handle(event.data)));
}

export interface BotSeatRef {
  /** The bot's key within the host. */
  bot: string;
  level: BotLevel;
  seed: Uint8Array;
}

export interface DecideArgs extends BotSeatRef {
  state: GameState;
  priv: PrivateState;
  seat: Seat;
  pending: PlayerPending;
  legal?: CommandShape[];
  timeBudgetMs?: number;
  iterationBudget?: number;
  hosted?: boolean;
}

export interface Decision {
  command: CommandShape;
  warnings: string[];
  elapsedMs: number;
}

/**
 * The host side of the boundary. It posts a bot only its view — the public state and its own
 * private state, built by `createBotView` — and resolves each request with the matching response.
 */
export class BotClient {
  private next = 1;
  private readonly waiting = new Map<number, (response: BotResponse) => void>();
  private readonly stop: () => void;

  constructor(private readonly port: BotPort) {
    this.stop = port.listen((message) => {
      if (typeof message !== 'object' || message === null || !('id' in message)) return;
      const id = message.id;
      if (typeof id !== 'number') return;
      const resolve = this.waiting.get(id);
      this.waiting.delete(id);
      // The host answers with its own response union.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      resolve?.(message as BotResponse);
    });
  }

  private request(build: (id: number) => BotRequest): Promise<BotResponse> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      // BotPort.postMessage takes the message alone; it is not window.postMessage.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      this.port.postMessage(build(id));
    });
  }

  async decide(args: DecideArgs): Promise<Decision> {
    const view = createBotView(args.state, args.priv, args.seat);
    const response = await this.request((id) => ({
      kind: 'decide',
      id,
      bot: args.bot,
      level: args.level,
      seed: args.seed,
      view,
      pending: args.pending,
      ...(args.legal ? { legal: args.legal } : {}),
      ...(args.timeBudgetMs === undefined ? {} : { timeBudgetMs: args.timeBudgetMs }),
      ...(args.iterationBudget === undefined ? {} : { iterationBudget: args.iterationBudget }),
      ...(args.hosted ? { hosted: true } : {}),
    }));
    if (response.kind === 'decision')
      return {
        command: response.command,
        warnings: response.warnings,
        elapsedMs: response.elapsedMs,
      };
    throw new Error(response.kind === 'error' ? response.message : `Unexpected ${response.kind}`);
  }

  async respondTrade(
    args: BotSeatRef & { state: GameState; priv: PrivateState; seat: Seat; offer: TradeOffer },
  ): Promise<boolean> {
    const view = createBotView(args.state, args.priv, args.seat);
    const response = await this.request((id) => ({
      kind: 'respondTrade',
      id,
      bot: args.bot,
      level: args.level,
      seed: args.seed,
      view,
      offer: args.offer,
    }));
    if (response.kind === 'tradeResponse') return response.accept;
    throw new Error(response.kind === 'error' ? response.message : `Unexpected ${response.kind}`);
  }

  async dispose(bot: string): Promise<void> {
    await this.request((id) => ({ kind: 'dispose', id, bot }));
  }

  close(): void {
    this.stop();
    this.port.close?.();
    this.waiting.clear();
  }
}
