// Makes the optional peers unresolvable, so a probe can prove the package root never reaches for one.
const ABSENT = new Set(['mongodb', '@aws-sdk/client-bedrock-runtime', '@google-cloud/vertexai']);

export function resolve(specifier, context, nextResolve) {
  if (!ABSENT.has(specifier)) return nextResolve(specifier, context);

  const error = new Error(`Cannot find package '${specifier}'`);
  error.code = 'ERR_MODULE_NOT_FOUND';
  throw error;
}
