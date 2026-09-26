<script setup lang="ts">
type TripStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'

type Trip = {
  id: string
  origin: string
  destination: string
  departureAt: string
  price: number
  currency: string
  seatQuota: number
  status: TripStatus
}

const authClient = useAuthClient()
const activeOrganization = authClient?.useActiveOrganization()
const { public: { apiUrl } } = useRuntimeConfig()
const toast = useToast()

const organizationId = computed(() => activeOrganization?.value?.data?.id ?? null)
const rows = ref<Trip[]>([])
const loading = ref(false)
const form = reactive({
  origin: '',
  destination: '',
  departureAt: '',
  price: 0,
  seatQuota: 1
})

async function refresh() {
  if (!organizationId.value) return
  loading.value = true
  try {
    rows.value = await $fetch<Trip[]>('/trips/manage', {
      baseURL: apiUrl,
      credentials: 'include',
      query: { organizationId: organizationId.value }
    })
  } catch (error) {
    handleError(error)
  } finally {
    loading.value = false
  }
}

async function createTrip() {
  if (!organizationId.value || !form.departureAt) return
  try {
    await $fetch('/trips', {
      baseURL: apiUrl,
      credentials: 'include',
      method: 'POST',
      body: {
        organizationId: organizationId.value,
        ...form,
        departureAt: new Date(form.departureAt).toISOString()
      }
    })
    Object.assign(form, { origin: '', destination: '', departureAt: '', price: 0, seatQuota: 1 })
    toast.add({ description: 'Trip created' })
    await refresh()
  } catch (error) {
    handleError(error)
  }
}

async function updateStatus(trip: Trip, status: Trip['status']) {
  await updateTrip(trip, { status })
}

async function updateTrip(trip: Trip, changes: Partial<Trip>) {
  if (!organizationId.value) return
  try {
    await $fetch(`/trips/${trip.id}`, {
      baseURL: apiUrl,
      credentials: 'include',
      method: 'PATCH',
      body: { organizationId: organizationId.value, ...changes }
    })
    await refresh()
  } catch (error) {
    handleError(error)
  }
}

watch(organizationId, refresh, { immediate: true })
useHead({ title: 'Trips' })
</script>

<template>
  <div class="flex flex-1 overflow-auto">
    <UDashboardPanel>
      <template #header>
        <UDashboardNavbar title="Trips">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #right>
            <UButton
              icon="i-lucide-refresh-cw"
              variant="ghost"
              :loading="loading"
              @click="refresh"
            />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <UContainer class="space-y-6 max-w-6xl">
          <UPageCard
            title="Create Trip"
            description="Add a scheduled route with a fixed price and seat quota."
          >
            <form
              class="grid gap-4 sm:grid-cols-2 lg:grid-cols-6"
              @submit.prevent="createTrip"
            >
              <UInput
                v-model="form.origin"
                placeholder="Origin"
                required
              />
              <UInput
                v-model="form.destination"
                placeholder="Destination"
                required
              />
              <UInput
                v-model="form.departureAt"
                type="datetime-local"
                required
              />
              <UInput
                v-model.number="form.price"
                type="number"
                min="0"
                placeholder="Price"
                required
              />
              <UInput
                v-model.number="form.seatQuota"
                type="number"
                min="1"
                placeholder="Seats"
                required
              />
              <UButton
                type="submit"
                label="Create"
                :disabled="!organizationId"
              />
            </form>
          </UPageCard>

          <UPageCard
            title="Trip catalog"
            :description="`${rows.length} Trip(s)`"
          >
            <UTable
              :data="rows"
              :columns="[
                { accessorKey: 'origin', header: 'Origin' },
                { accessorKey: 'destination', header: 'Destination' },
                { accessorKey: 'departureAt', header: 'Departure' },
                { accessorKey: 'price', header: 'Price' },
                { accessorKey: 'seatQuota', header: 'Seats' },
                { accessorKey: 'status', header: 'Status' }
              ]"
            >
              <template #origin-cell="{ row }">
                <UInput
                  v-model="row.original.origin"
                  size="sm"
                  @change="updateTrip(row.original, { origin: row.original.origin })"
                />
              </template>
              <template #destination-cell="{ row }">
                <UInput
                  v-model="row.original.destination"
                  size="sm"
                  @change="updateTrip(row.original, { destination: row.original.destination })"
                />
              </template>
              <template #departureAt-cell="{ row }">
                <UInput
                  type="datetime-local"
                  size="sm"
                  :model-value="new Date(row.original.departureAt).toISOString().slice(0, 16)"
                  @change="updateTrip(row.original, { departureAt: new Date(($event.target as HTMLInputElement).value).toISOString() })"
                />
              </template>
              <template #price-cell="{ row }">
                <UInput
                  v-model.number="row.original.price"
                  type="number"
                  min="0"
                  size="sm"
                  @change="updateTrip(row.original, { price: row.original.price })"
                />
              </template>
              <template #seatQuota-cell="{ row }">
                <UInput
                  v-model.number="row.original.seatQuota"
                  type="number"
                  min="1"
                  size="sm"
                  @change="updateTrip(row.original, { seatQuota: row.original.seatQuota })"
                />
              </template>
              <template #status-cell="{ row }">
                <USelect
                  :model-value="row.original.status"
                  :items="['DRAFT', 'PUBLISHED', 'ARCHIVED']"
                  @update:model-value="(value) => updateStatus(row.original, value as Trip['status'])"
                />
              </template>
            </UTable>
          </UPageCard>
        </UContainer>
      </template>
    </UDashboardPanel>
  </div>
</template>
