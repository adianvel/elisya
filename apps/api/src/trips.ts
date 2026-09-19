import { zenstack } from '@repo/db'

export type TripStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'

export type Trip = {
  id: string
  organizationId: string
  origin: string
  destination: string
  departureAt: Date
  price: number
  currency: string
  seatQuota: number
  status: TripStatus
}

export type TripInput = {
  origin: string
  destination: string
  departureAt: Date
  price: number
  currency?: string
  seatQuota: number
}

export type TripPatch = Partial<TripInput> & { status?: TripStatus }

export type TripActor = {
  userId: string
  organizationId: string
}

export type TripStore = {
  isOwner(userId: string, organizationId: string): Promise<boolean>
  create(input: TripInput & { organizationId: string; currency: string; status: TripStatus }): Promise<Trip>
  update(organizationId: string, id: string, input: TripPatch): Promise<Trip | null>
  findMany(organizationId: string): Promise<Trip[]>
}

export function configuredOrganizationId(): string {
  const organizationId = process.env.PALAWA_ORGANIZATION_ID
  if (!organizationId) throw new Error('PALAWA_ORGANIZATION_ID is required')
  return organizationId
}

const store: TripStore = {
  isOwner: async (userId, organizationId) => Boolean(await zenstack.member.findFirst({
    where: { userId, organizationId, role: 'owner' },
    select: { id: true },
  })),
  create: async (input) => zenstack.trip.create({ data: input }) as Promise<Trip>,
  update: async (organizationId, id, input) => zenstack.trip.update({
    where: { id, organizationId },
    data: input,
  }) as Promise<Trip>,
  findMany: async (organizationId) => zenstack.trip.findMany({
    where: { organizationId },
    orderBy: { departureAt: 'asc' },
  }) as Promise<Trip[]>,
}

function validateTrip(input: TripInput): void {
  if (!input.origin.trim() || !input.destination.trim()) throw new Error('origin and destination are required')
  if (!(input.departureAt instanceof Date) || Number.isNaN(input.departureAt.getTime())) throw new Error('departureAt must be a valid date')
  if (!Number.isInteger(input.price) || input.price < 0) throw new Error('price must be a non-negative integer')
  if (!Number.isInteger(input.seatQuota) || input.seatQuota < 1) throw new Error('seatQuota must be a positive integer')
}

async function requireOwner(actor: TripActor, tripStore: TripStore): Promise<void> {
  if (!await tripStore.isOwner(actor.userId, actor.organizationId)) throw new Error('Owner access required')
}

export function createTripService(tripStore: TripStore = store) {
  return {
    async create(actor: TripActor, input: TripInput): Promise<Trip> {
      await requireOwner(actor, tripStore)
      validateTrip(input)
      return tripStore.create({
        ...input,
        organizationId: actor.organizationId,
        currency: input.currency ?? 'IDR',
        status: 'DRAFT',
      })
    },

    async update(actor: TripActor, id: string, input: TripPatch): Promise<Trip> {
      await requireOwner(actor, tripStore)
      const current = (await tripStore.findMany(actor.organizationId)).find((trip) => trip.id === id)
      if (!current) throw new Error('Trip not found')
      validateTrip({ ...current, ...input })
      const updated = await tripStore.update(actor.organizationId, id, input)
      if (!updated) throw new Error('Trip not found')
      return updated
    },

    async listAvailable({ organizationId, now = new Date() }: { organizationId: string; now?: Date }): Promise<Trip[]> {
      const trips = await tripStore.findMany(organizationId)
      return trips.filter((trip) => trip.status === 'PUBLISHED' && trip.departureAt > now)
    },

    async listOwner(actor: TripActor): Promise<Trip[]> {
      await requireOwner(actor, tripStore)
      return tripStore.findMany(actor.organizationId)
    },
  }
}

export const trips = createTripService()
