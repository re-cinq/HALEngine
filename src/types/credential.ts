/** Thrown by `resolveAuthHeaders` when a credential cannot be renewed; the client receives its message verbatim (specs/hal-engine-credential-resolver/spec.md). */
export class CredentialExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialExpiredError';
  }
}
