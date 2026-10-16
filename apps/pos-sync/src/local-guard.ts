const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

/** Throws unless `url` points at a loopback host. Call this before any admin request. */
export function assertLocalSupabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing non-local Supabase URL: ${url}`);
  }
  let hostname = parsed.hostname;
  // Node's URL hostname keeps the brackets around an IPv6 address.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (!localHosts.has(hostname)) {
    throw new Error(`Refusing non-local Supabase URL: ${url}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`Refusing non-local Supabase URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-local Supabase URL: ${url}`);
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`Refusing non-local Supabase URL: ${url}`);
  }
}
