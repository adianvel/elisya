import { getOwnerAuthorization } from '@repo/db'

export type OwnerActor = { userId: string; organizationId: string }

export async function isAuthorizedOwner(userId: string, organizationId: string): Promise<boolean> {
  const access = await getOwnerAuthorization(userId, organizationId)
  if (access === 'two-factor-required') throw new Error('Owner two-factor authentication required')
  return access === 'authorized'
}

export async function requireOwner(actor: OwnerActor): Promise<void> {
  if (!await isAuthorizedOwner(actor.userId, actor.organizationId)) throw new Error('Owner access required')
}
