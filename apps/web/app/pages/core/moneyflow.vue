<script setup lang="ts">
type Moneyflow = {
  payments: { PENDING: number; APPROVED: number; REJECTED: number }
  invoiceCount: number
  confirmedAmount: number
  invoices: Array<{ id: string; bookingId: string; amount: number; currency: string; issuedAt: string }>
  auditEvents: Array<{ id: string; actorId: string | null; action: string; entityType: string; entityId: string; createdAt: string }>
}

const authClient = useAuthClient()
const activeOrganization = authClient?.useActiveOrganization()
const { public: { apiUrl } } = useRuntimeConfig()
const organizationId = computed(() => activeOrganization?.value?.data?.id ?? null)
const data = ref<Moneyflow>({ payments: { PENDING: 0, APPROVED: 0, REJECTED: 0 }, invoiceCount: 0, confirmedAmount: 0, invoices: [], auditEvents: [] })
const loading = ref(false)
const money = (amount: number, currency = 'IDR') => new Intl.NumberFormat('id-ID', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)

async function refresh() {
  if (!organizationId.value) return
  loading.value = true
  try {
    data.value = await $fetch<Moneyflow>('/dashboard/moneyflow', { baseURL: apiUrl, credentials: 'include', query: { organizationId: organizationId.value } })
  } catch (error) {
    handleError(error)
  } finally {
    loading.value = false
  }
}

watch(organizationId, refresh, { immediate: true })
useHead({ title: 'Moneyflow' })
</script>

<template>
  <div class="flex flex-1 overflow-auto">
    <UDashboardPanel>
      <template #header>
        <UDashboardNavbar title="Moneyflow">
          <template #leading><UDashboardSidebarCollapse /></template>
          <template #right><UButton icon="i-lucide-refresh-cw" variant="ghost" :loading="loading" @click="refresh" /></template>
        </UDashboardNavbar>
      </template>
      <template #body>
        <UContainer class="max-w-7xl space-y-6">
          <div class="grid gap-4 sm:grid-cols-5">
            <UPageCard title="Confirmed amount" :description="money(data.confirmedAmount)" />
            <UPageCard title="Invoices" :description="`${data.invoiceCount} issued`" />
            <UPageCard title="Pending payments" :description="`${data.payments.PENDING}`" />
            <UPageCard title="Approved payments" :description="`${data.payments.APPROVED}`" />
            <UPageCard title="Rejected payments" :description="`${data.payments.REJECTED}`" />
          </div>

          <UPageCard title="Invoices">
            <UTable :data="data.invoices" :columns="[
              { accessorKey: 'id', header: 'Invoice' },
              { accessorKey: 'bookingId', header: 'Booking' },
              { accessorKey: 'amount', header: 'Amount' },
              { accessorKey: 'issuedAt', header: 'Issued' },
            ]">
              <template #amount-cell="{ row }">{{ money(row.original.amount, row.original.currency) }}</template>
              <template #issuedAt-cell="{ row }">{{ new Date(row.original.issuedAt).toLocaleString() }}</template>
            </UTable>
          </UPageCard>

          <UPageCard title="Audit history" description="Recent operational and financial actions">
            <UTable :data="data.auditEvents" :columns="[
              { accessorKey: 'action', header: 'Action' },
              { accessorKey: 'entityType', header: 'Target' },
              { accessorKey: 'actorId', header: 'Actor' },
              { accessorKey: 'createdAt', header: 'Time' },
            ]">
              <template #createdAt-cell="{ row }">{{ new Date(row.original.createdAt).toLocaleString() }}</template>
            </UTable>
          </UPageCard>
        </UContainer>
      </template>
    </UDashboardPanel>
  </div>
</template>
