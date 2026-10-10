/** Expected failures a caller can show to the user. Anything else is a bug. */
export type ServiceErrorCode = 'forbidden' | 'not_found' | 'invalid';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  /** Field-level messages for `invalid`, keyed by input field name. */
  readonly fields: Readonly<Record<string, string>>;

  constructor(code: ServiceErrorCode, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.fields = fields;
  }
}

export function isServiceError(e: unknown): e is ServiceError {
  return e instanceof ServiceError;
}
