/**
 * Share in-flight organization-region lookups without sharing product-specific
 * cache keys, region trust, discovery, or fallback policies.
 */
export function resolveCachedRegion<Value>(
  cache: Map<string, Promise<Value>>,
  key: string,
  lookup: () => Promise<Value>,
  isCacheable: (value: Value) => boolean = () => true,
): Promise<Value> {
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }

  // Start before returning so the lookup sees the source identity that keyed
  // this cache entry, even if a caller changes credentials in the same tick.
  const pending = (async () => lookup())()
    .then((value) => {
      if (!isCacheable(value) && cache.get(key) === pending) {
        cache.delete(key);
      }
      return value;
    })
    .catch((error: unknown) => {
      if (cache.get(key) === pending) {
        cache.delete(key);
      }
      throw error;
    });
  cache.set(key, pending);
  return pending;
}
