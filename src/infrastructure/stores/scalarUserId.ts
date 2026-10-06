export function assertScalarUserId(userId: string | number): void {
  if (typeof userId === 'string' || (typeof userId === 'number' && Number.isFinite(userId))) {
    return;
  }
  throw new TypeError(`userId must be a string or finite number; got ${typeof userId}`);
}
