import { describe, expect, it } from 'bun:test'
import { isUserStorageKey, userStoragePrefix } from './storage-auth'

describe('private storage scope', () => {
  it('accepts only object keys under the current user prefix', () => {
    expect(isUserStorageKey('user-a/report.pdf', 'user-a')).toBe(true)
    expect(isUserStorageKey('user-b/report.pdf', 'user-a')).toBe(false)
    expect(isUserStorageKey('user-a/../user-b/report.pdf', 'user-a')).toBe(false)
  })

  it('scopes listings to the current user and rejects path traversal', () => {
    expect(userStoragePrefix(undefined, 'user-a')).toBe('user-a/')
    expect(userStoragePrefix('folder/', 'user-a')).toBe('user-a/folder/')
    expect(userStoragePrefix('../user-b/', 'user-a')).toBeNull()
  })
})
