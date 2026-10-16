export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'sync failed';
  const redacted = raw
    .replace(/ya29\.[A-Za-z0-9._~+/-]+=*/g, '[redacted]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[redacted]',
    )
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return redacted.length > 300 ? redacted.slice(0, 300) : redacted;
}
