import { canonicalEncode } from '@cp2p/codec';
import type { CommandShape, Input, Seat, SystemInput } from '@cp2p/engine';

/**
 * Some engine requests are answered by one seat with a system input (a `reveal` pending): a
 * drawer showing a victory card, the target of a look, the actor of a take. In a verified game
 * such an answer needs the seat's signature, its bound parent and nonce, and proof evidence,
 * exactly like a command. It travels as a command of this reserved type whose `input` is the
 * system input without its `kind`; the log applies the system input, so the engine sees the same
 * input a local game records. `input.seat` must be the signer, so no seat can answer for another.
 */
export const SEAT_INPUT = 'SEAT_INPUT';

/** The system inputs a seat may submit through a signed envelope. */
export const SEAT_INPUT_TYPES: readonly string[] = [
  'REVEAL_PROGRESS',
  'DEAL_KNOWN',
  'SHOW_HAND',
  'TAKE_CARDS',
  'TAKE_PROGRESS',
];

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Wrap a system input for signing by its seat. */
export function seatInputCommand(input: SystemInput): CommandShape {
  const { kind: _kind, ...rest } = input;
  return { type: SEAT_INPUT, input: rest };
}

/** The system input inside a well-formed envelope signed by `seat`, or null. */
export function unwrapSeatInput(seat: Seat, command: CommandShape): SystemInput | null {
  if (command.type !== SEAT_INPUT) return null;
  if (Object.keys(command).length !== 2) return null;
  const inner = command.input;
  if (
    !record(inner) ||
    typeof inner.type !== 'string' ||
    !SEAT_INPUT_TYPES.includes(inner.type) ||
    Object.hasOwn(inner, 'kind') ||
    inner.seat !== seat
  )
    return null;
  return { kind: 'system', ...inner, type: inner.type };
}

/**
 * The engine input a signed body stands for. An envelope with a malformed inner input stays a
 * command of an unknown type, which the engine rejects.
 */
export function bodyInput(seat: Seat, command: CommandShape): Input {
  const inner = unwrapSeatInput(seat, command);
  return inner ?? { kind: 'command', seat, command };
}

/** Whether two inputs are the same value (used to bind proofs to their command). */
export function sameInput(left: Input, right: Input): boolean {
  const a = canonicalEncode(left);
  const b = canonicalEncode(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
