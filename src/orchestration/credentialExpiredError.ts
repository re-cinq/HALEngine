/** Thrown by `resolveAuthHeaders` to end the turn with `CREDENTIAL_EXPIRED` instead of a silent failure. */
export class CredentialExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialExpiredError';
  }
}

/** Internal: tags a non-CredentialExpiredError throw from resolveAuthHeaders so wsErrorHandler can rethrow it. */
export class ResolveAuthHeadersError extends Error {
  constructor(public readonly original: Error) {
    super(original.message);
    this.name = 'ResolveAuthHeadersError';
  }
}
