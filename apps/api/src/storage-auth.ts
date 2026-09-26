function safeSegments(path: string): boolean {
  return path.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

export function isUserStorageKey(key: string, userId: string): boolean {
  return key.startsWith(`${userId}/`) && safeSegments(key)
}

export function userStoragePrefix(requested: string | undefined, userId: string): string | null {
  const scope = `${userId}/`
  const prefix = !requested ? scope : requested.startsWith(scope) ? requested : `${scope}${requested}`
  const path = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return prefix.startsWith(scope) && safeSegments(path) ? prefix : null
}
