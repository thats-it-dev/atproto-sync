/** Typed errors so the CLI and MCP layers can map failures to exit codes / error codes. */
export type ErrorCode = 'ERROR' | 'USAGE' | 'NOT_CONFIGURED' | 'LOCK_TIMEOUT' | 'AUTH' | 'ALREADY_RUNNING';

export const EXIT_CODES: Record<ErrorCode, number> = {
  ERROR: 1,
  USAGE: 2,
  NOT_CONFIGURED: 3,
  LOCK_TIMEOUT: 4,
  AUTH: 5,
  ALREADY_RUNNING: 1,
};

export class AtpsyncError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AtpsyncError';
  }
}

export function toAtpsyncError(err: unknown): AtpsyncError {
  if (err instanceof AtpsyncError) return err;
  return new AtpsyncError('ERROR', err instanceof Error ? err.message : String(err));
}
