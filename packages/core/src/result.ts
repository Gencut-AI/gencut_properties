/** Minimal result type so domain functions never throw for expected failures. */
export type Result<T, E extends string = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E; readonly message: string };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends string>(error: E, message: string): Result<never, E> {
  return { ok: false, error, message };
}
