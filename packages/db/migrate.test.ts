import { expect, test } from 'bun:test'
import { migrationChecksum } from './migrate'

test('migration checksums are stable SHA-256 hashes of the SQL bytes', () => {
  const sql = 'SELECT 1;\n'
  expect(migrationChecksum(sql)).toHaveLength(64)
  expect(migrationChecksum(sql)).toBe(migrationChecksum(sql))
  expect(migrationChecksum(sql)).not.toBe(migrationChecksum('SELECT 1;'))
})
