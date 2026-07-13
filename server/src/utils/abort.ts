export function abortSignalWithTimeout(external: unknown, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return external instanceof AbortSignal
    ? AbortSignal.any([external, timeout])
    : timeout
}
