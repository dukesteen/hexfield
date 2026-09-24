/** A typed rule failure that can cross the engine boundary as plain data. */
export interface RuleError {
  /** Stable code for handling this failure in callers and tests. */
  readonly code: string;
  /** Human-readable explanation for logs and development tools. */
  readonly message: string;
  /** Optional structured context. Values must remain plain JSON data. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A success value or a typed failure. */
export type Result<T, E = RuleError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wraps a successful result. */
export function success<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Creates a typed rule error. */
export function ruleError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RuleError {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Wraps an error code, message and optional details as a failed result. */
export function failure(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Result<never> {
  return { ok: false, error: ruleError(code, message, details) };
}
