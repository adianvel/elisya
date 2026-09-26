type Bucket = { count: number; resetAt: number }

export function createRateLimiter(maxKeys = 10_000) {
  // ponytail: process-local windows reset on restart; use shared storage if API replicas are added.
  const buckets = new Map<string, Bucket>()

  return (key: string, max: number, windowMs: number, now = Date.now()): boolean => {
    const bucket = buckets.get(key)
    if (bucket && bucket.resetAt > now) {
      if (bucket.count >= max) return true
      bucket.count++
      return false
    }

    if (buckets.size >= maxKeys) {
      for (const [expiredKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(expiredKey)
      }
      if (buckets.size >= maxKeys) return true
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
}
