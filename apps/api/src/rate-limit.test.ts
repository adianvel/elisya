import { describe, expect, it } from 'bun:test'
import { createRateLimiter } from './rate-limit'

describe('public request limits', () => {
  it('limits a key within its window and resets it afterward', () => {
    const limited = createRateLimiter()

    expect(limited('GET:/trips:ip-a', 2, 1_000, 10_000)).toBe(false)
    expect(limited('GET:/trips:ip-a', 2, 1_000, 10_100)).toBe(false)
    expect(limited('GET:/trips:ip-a', 2, 1_000, 10_200)).toBe(true)
    expect(limited('GET:/trips:ip-b', 2, 1_000, 10_200)).toBe(false)
    expect(limited('GET:/trips:ip-a', 2, 1_000, 11_000)).toBe(false)
  })
})
