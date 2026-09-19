<script setup lang="ts">
type Operations = {
  trips: Array<{ id: string; origin: string; destination: string; departureAt: string; status: string; seatQuota: number; vehicleName: string | null; plateNumber: string | null; vehicleStatus: string | null }>
  activeHolds: Array<{ id: string; tripId: string; customerRef: string; seatCount: number; expiresAt: string }>
  confirmedBookings: Array<{ id: string; tripId: string; customerRef: string; seatCount: number; confirmedAt: string | null; invoiceAmount: number | null; currency: string | null }>
  vehicles: Array<{ id: string; name: string; plateNumber: string; status: string }>
}

const authClient = useAuthClient()
const activeOrganization = authClient?.useActiveOrganization()
const { public: { apiUrl } } = useRuntimeConfig()
const organizationId = computed(() => activeOrganization?.value?.data?.id ?? null)
const data = ref<Operations>({ trips: [], activeHolds: [], confirmedBookings: [], vehicles: [] })
const loading = ref(false)

async function refresh() {
  if (!organizationId.value) return
  loading.value = true
  try {
    data.value = await $fetch<Operations>('/dashboard/operations', { baseURL: apiUrl, credentials: 'include', query: { organizationId: organizationId.value } })
  } catch (error) {
    handleError(error)
  } finally {
    loading.value = false
  }
}

watch(organizationId, refresh, { immediate: true })
useHead({ title: 'Operations' })
</script>

<template>
  <div class="flex flex-1 overflow-auto">
    <UDashboardPanel>
      <template #header>
        <UDashboardNavbar title="Operations">
          <template #leading><UDashboardSidebarCollapse /></template>
          <template #right><UButton icon="i-lucide-refresh-cw" variant="ghost" :loading="loading" @click="refresh" /></template>
        </UDashboardNavbar>
      </template>
      <template #body>
        <UContainer class="max-w-7xl space-y-6">
          <div class="grid gap-4 sm:grid-cols-4">
            <UPageCard title="Trips" :description="`${data.trips.length} total`" />
            <UPageCard title="Active holds" :description="`${data.activeHolds.length} reserved`" />
            <UPageCard title="Confirmed bookings" :description="`${data.confirmedBookings.length} confirmed`" />
            <UPageCard title="Vehicles" :description="`${data.vehicles.length} tracked`" />
          </div>

          <UPageCard title="Trips and assignments">
            <UTable :data="data.trips" :columns="[
              { accessorKey: 'origin', header: 'Origin' },
              { accessorKey: 'destination', header: 'Destination' },
              { accessorKey: 'departureAt', header: 'Departure' },
              { accessorKey: 'status', header: 'Status' },
              { id: 'vehicle', header: 'Vehicle' },
            ]">
              <template #departureAt-cell="{ row }">{{ new Date(row.original.departureAt).toLocaleString() }}</template>
              <template #vehicle-cell="{ row }">{{ row.original.vehicleName ? `${row.original.vehicleName} (${row.original.plateNumber})` : 'Unassigned' }}</template>
            </UTable>
          </UPageCard>

          <div class="grid gap-6 lg:grid-cols-2">
            <UPageCard title="Active holds">
              <UTable :data="data.activeHolds" :columns="[
                { accessorKey: 'customerRef', header: 'Customer' },
                { accessorKey: 'seatCount', header: 'Seats' },
                { accessorKey: 'expiresAt', header: 'Expires' },
              ]">
                <template #expiresAt-cell="{ row }">{{ new Date(row.original.expiresAt).toLocaleString() }}</template>
              </UTable>
            </UPageCard>
            <UPageCard title="Vehicles">
              <UTable :data="data.vehicles" :columns="[
                { accessorKey: 'name', header: 'Name' },
                { accessorKey: 'plateNumber', header: 'Plate' },
                { accessorKey: 'status', header: 'Status' },
              ]" />
            </UPageCard>
          </div>

          <UPageCard title="Confirmed bookings">
            <UTable :data="data.confirmedBookings" :columns="[
              { accessorKey: 'customerRef', header: 'Customer' },
              { accessorKey: 'tripId', header: 'Trip' },
              { accessorKey: 'seatCount', header: 'Seats' },
              { accessorKey: 'invoiceAmount', header: 'Invoice' },
            ]" />
          </UPageCard>
        </UContainer>
      </template>
    </UDashboardPanel>
  </div>
</template>
