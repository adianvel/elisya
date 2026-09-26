<script setup lang="ts">
type VehicleStatus = 'AVAILABLE' | 'ASSIGNED' | 'MAINTENANCE'
type Operations = {
  trips: Array<{
    id: string
    origin: string
    destination: string
    departureAt: string
    status: string
    seatQuota: number
    reservedSeats: number
    remainingSeats: number
    vehicleId: string | null
    vehicleName: string | null
    plateNumber: string | null
    vehicleStatus: VehicleStatus | null
  }>
  activeHolds: Array<{ id: string; tripId: string; customerRef: string; seatCount: number; expiresAt: string }>
  confirmedBookings: Array<{ id: string; tripId: string; customerRef: string; seatCount: number; confirmedAt: string | null; invoiceAmount: number | null; currency: string | null }>
  pendingPaymentReviews: Array<{ id: string; holdId: string; tripId: string; customerRef: string; submittedAt: string; origin: string; destination: string }>
  cancellationCases: Array<{ id: string; bookingId: string | null; paymentId: string | null; customerRef: string; source: string; status: string; requestedAt: string }>
  vehicles: Array<{ id: string; name: string; plateNumber: string; status: VehicleStatus }>
}

const emptyOperations = (): Operations => ({
  trips: [], activeHolds: [], confirmedBookings: [], pendingPaymentReviews: [], cancellationCases: [], vehicles: [],
})
const authClient = useAuthClient()
const activeOrganization = authClient?.useActiveOrganization()
const { public: { apiUrl } } = useRuntimeConfig()
const toast = useToast()
const organizationId = computed(() => activeOrganization?.value?.data?.id ?? null)
const data = ref<Operations>(emptyOperations())
const vehicleForm = reactive({ name: '', plateNumber: '' })
const loading = ref(false)
const savingVehicle = ref(false)
const vehicleStatuses: VehicleStatus[] = ['AVAILABLE', 'ASSIGNED', 'MAINTENANCE']

async function refresh() {
  if (!organizationId.value) {
    data.value = emptyOperations()
    return
  }
  loading.value = true
  try {
    data.value = await $fetch<Operations>('/dashboard/operations', { baseURL: apiUrl, credentials: 'include', query: { organizationId: organizationId.value } })
  } catch (error) {
    handleError(error)
  } finally {
    loading.value = false
  }
}

async function createVehicle() {
  if (!organizationId.value) return
  savingVehicle.value = true
  try {
    await $fetch('/vehicles', {
      baseURL: apiUrl,
      credentials: 'include',
      method: 'POST',
      body: { organizationId: organizationId.value, ...vehicleForm },
    })
    Object.assign(vehicleForm, { name: '', plateNumber: '' })
    toast.add({ description: 'Vehicle created' })
    await refresh()
  } catch (error) {
    handleError(error)
  } finally {
    savingVehicle.value = false
  }
}

async function updateVehicleStatus(vehicle: Operations['vehicles'][number], status: VehicleStatus) {
  if (!organizationId.value) return
  try {
    await $fetch(`/vehicles/${vehicle.id}/status`, {
      baseURL: apiUrl,
      credentials: 'include',
      method: 'PATCH',
      body: { organizationId: organizationId.value, status },
    })
    toast.add({ description: 'Vehicle status updated' })
    await refresh()
  } catch (error) {
    handleError(error)
  }
}

async function assignVehicle(trip: Operations['trips'][number], vehicleId: string) {
  if (!organizationId.value) return
  try {
    await $fetch(`/trips/${trip.id}`, {
      baseURL: apiUrl,
      credentials: 'include',
      method: 'PATCH',
      body: { organizationId: organizationId.value, vehicleId: vehicleId || null },
    })
    toast.add({ description: vehicleId ? 'Vehicle assigned to Trip' : 'Vehicle removed from Trip' })
    await refresh()
  } catch (error) {
    handleError(error)
    await refresh()
  }
}

function assignmentOptions(trip: Operations['trips'][number]) {
  return [
    { label: 'Unassigned', value: '' },
    ...data.value.vehicles
      .filter((vehicle) => vehicle.status !== 'MAINTENANCE' || vehicle.id === trip.vehicleId)
      .map((vehicle) => ({ label: `${vehicle.name} (${vehicle.plateNumber})`, value: vehicle.id })),
  ]
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
          <UPageCard title="Trips and vehicle assignments" :description="`${data.trips.length} Trips, capacity shown by Trip`">
            <UTable :data="data.trips" :columns="[
              { accessorKey: 'origin', header: 'Origin' },
              { accessorKey: 'destination', header: 'Destination' },
              { accessorKey: 'departureAt', header: 'Departure' },
              { id: 'capacity', header: 'Seats left' },
              { accessorKey: 'status', header: 'Status' },
              { id: 'vehicle', header: 'Vehicle' },
            ]">
              <template #departureAt-cell="{ row }">{{ new Date(row.original.departureAt).toLocaleString() }}</template>
              <template #capacity-cell="{ row }">
                {{ ['DRAFT', 'PUBLISHED'].includes(row.original.status) ? `${row.original.remainingSeats} / ${row.original.seatQuota}` : '—' }}
              </template>
              <template #vehicle-cell="{ row }">
                <USelect
                  :model-value="row.original.vehicleId ?? ''"
                  :items="assignmentOptions(row.original)"
                  value-key="value"
                  label-key="label"
                  :disabled="row.original.status === 'CANCELLED' || row.original.status === 'ARCHIVED'"
                  @update:model-value="value => assignVehicle(row.original, value as string)"
                />
              </template>
            </UTable>
          </UPageCard>

          <div class="grid gap-6 lg:grid-cols-2">
            <UPageCard title="Payment reviews" :description="`${data.pendingPaymentReviews.length} waiting for a decision`">
              <UTable :data="data.pendingPaymentReviews" :columns="[
                { accessorKey: 'customerRef', header: 'Customer' },
                { id: 'trip', header: 'Trip' },
                { accessorKey: 'submittedAt', header: 'Submitted' },
              ]">
                <template #trip-cell="{ row }">{{ row.original.origin }} to {{ row.original.destination }}</template>
                <template #submittedAt-cell="{ row }">{{ new Date(row.original.submittedAt).toLocaleString() }}</template>
              </UTable>
            </UPageCard>
            <UPageCard title="Cancellation cases" :description="`${data.cancellationCases.length} waiting for a decision`">
              <UTable :data="data.cancellationCases" :columns="[
                { accessorKey: 'source', header: 'From' },
                { id: 'target', header: 'Booking or Payment' },
                { accessorKey: 'customerRef', header: 'Customer' },
                { accessorKey: 'requestedAt', header: 'Requested' },
              ]">
                <template #target-cell="{ row }">{{ row.original.bookingId ?? row.original.paymentId }}</template>
                <template #requestedAt-cell="{ row }">{{ new Date(row.original.requestedAt).toLocaleString() }}</template>
              </UTable>
            </UPageCard>
          </div>

          <div class="grid gap-6 lg:grid-cols-2">
            <UPageCard title="Active Holds">
              <UTable :data="data.activeHolds" :columns="[
                { accessorKey: 'customerRef', header: 'Customer' },
                { accessorKey: 'seatCount', header: 'Seats' },
                { accessorKey: 'expiresAt', header: 'Expires' },
              ]">
                <template #expiresAt-cell="{ row }">{{ new Date(row.original.expiresAt).toLocaleString() }}</template>
              </UTable>
            </UPageCard>
            <UPageCard title="Confirmed Bookings">
              <UTable :data="data.confirmedBookings" :columns="[
                { accessorKey: 'customerRef', header: 'Customer' },
                { accessorKey: 'tripId', header: 'Trip' },
                { accessorKey: 'seatCount', header: 'Seats' },
                { accessorKey: 'invoiceAmount', header: 'Invoice' },
              ]" />
            </UPageCard>
          </div>

          <UPageCard title="Vehicles" description="Track each unit and assign it to an upcoming Trip.">
            <form class="mb-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto]" @submit.prevent="createVehicle">
              <UInput v-model="vehicleForm.name" placeholder="Vehicle name" required maxlength="100" aria-label="Vehicle name" />
              <UInput v-model="vehicleForm.plateNumber" placeholder="Plate number" required maxlength="32" aria-label="Plate number" />
              <UButton type="submit" icon="i-lucide-plus" label="Add Vehicle" :loading="savingVehicle" :disabled="!organizationId" />
            </form>
            <UTable :data="data.vehicles" :columns="[
              { accessorKey: 'name', header: 'Name' },
              { accessorKey: 'plateNumber', header: 'Plate' },
              { accessorKey: 'status', header: 'Status' },
            ]">
              <template #status-cell="{ row }">
                <USelect
                  :model-value="row.original.status"
                  :items="vehicleStatuses"
                  :disabled="row.original.status === 'ASSIGNED' && data.trips.some(trip => trip.vehicleId === row.original.id && ['DRAFT', 'PUBLISHED'].includes(trip.status))"
                  @update:model-value="value => updateVehicleStatus(row.original, value as VehicleStatus)"
                />
              </template>
            </UTable>
          </UPageCard>
        </UContainer>
      </template>
    </UDashboardPanel>
  </div>
</template>
