<script setup lang="ts">
type PaymentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REFUND_PENDING' | 'REFUNDED'
type CurrencyTotal = { currency: string, count: number, amount: number }
type Moneyflow = {
  payments: Record<PaymentStatus, number>
  invoiceCount: number
  invoiceTotals: CurrencyTotal[]
  approvedPaymentTotals: CurrencyTotal[]
  refundTotals: Array<CurrencyTotal & { status: 'PENDING' | 'COMPLETED' }>
  invoices: Array<{ id: string, bookingId: string, amount: number, currency: string, issuedAt: string }>
  refunds: Array<{
    id: string
    bookingId: string | null
    paymentId: string | null
    amount: number
    currency: string
    status: 'PENDING' | 'COMPLETED'
    transferredAt: string | null
    transferReference: string | null
    recordedBy: string | null
    createdAt: string
  }>
  auditEvents: Array<{
    id: string
    actorId: string | null
    actorName: string | null
    action: string
    entityType: string
    entityId: string
    createdAt: string
  }>
}

const emptyMoneyflow = (): Moneyflow => ({
  payments: { PENDING: 0, APPROVED: 0, REJECTED: 0, REFUND_PENDING: 0, REFUNDED: 0 },
  invoiceCount: 0,
  invoiceTotals: [],
  approvedPaymentTotals: [],
  refundTotals: [],
  invoices: [],
  refunds: [],
  auditEvents: []
})
const authClient = useAuthClient()
const activeOrganization = authClient?.useActiveOrganization()
const { public: { apiUrl } } = useRuntimeConfig()
const organizationId = computed(() => activeOrganization?.value?.data?.id ?? null)
const data = ref<Moneyflow>(emptyMoneyflow())
const loading = ref(false)
const statuses: PaymentStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'REFUND_PENDING', 'REFUNDED']

function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${amount.toLocaleString('id-ID')} ${currency}`
  }
}

async function refresh() {
  if (!organizationId.value) {
    data.value = emptyMoneyflow()
    return
  }
  loading.value = true
  try {
    data.value = await $fetch<Moneyflow>('/dashboard/moneyflow', { baseURL: apiUrl, credentials: 'include', query: { organizationId: organizationId.value } })
  } catch (error) {
    handleError(error)
  } finally {
    loading.value = false
  }
}

function totalsFor(status: 'PENDING' | 'COMPLETED') {
  return data.value.refundTotals.filter(total => total.status === status)
}

watch(organizationId, refresh, { immediate: true })
useHead({ title: 'Moneyflow' })
</script>

<template>
  <div class="flex flex-1 overflow-auto">
    <UDashboardPanel>
      <template #header>
        <UDashboardNavbar title="Moneyflow">
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
        <UContainer class="max-w-7xl space-y-6">
          <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <UPageCard
              title="Invoice value"
              :description="`${data.invoiceCount} invoices issued`"
            >
              <p
                v-for="total in data.invoiceTotals"
                :key="total.currency"
                class="text-sm text-muted"
              >
                {{ money(total.amount, total.currency) }} across {{ total.count }} invoices
              </p>
              <p
                v-if="!data.invoiceTotals.length"
                class="text-sm text-muted"
              >
                No invoices yet
              </p>
            </UPageCard>
            <UPageCard
              title="Approved transfers"
              description="Payments approved by the Owner"
            >
              <p
                v-for="total in data.approvedPaymentTotals"
                :key="total.currency"
                class="text-sm text-muted"
              >
                {{ money(total.amount, total.currency) }} across {{ total.count }} Payments
              </p>
              <p
                v-if="!data.approvedPaymentTotals.length"
                class="text-sm text-muted"
              >
                No approved Payments yet
              </p>
            </UPageCard>
            <UPageCard
              title="Refunds pending"
              description="Approved, awaiting manual transfer"
            >
              <p
                v-for="total in totalsFor('PENDING')"
                :key="total.currency"
                class="text-sm text-muted"
              >
                {{ money(total.amount, total.currency) }} across {{ total.count }} Refunds
              </p>
              <p
                v-if="!totalsFor('PENDING').length"
                class="text-sm text-muted"
              >
                No pending Refunds
              </p>
            </UPageCard>
            <UPageCard
              title="Refunds completed"
              description="Manual transfers recorded"
            >
              <p
                v-for="total in totalsFor('COMPLETED')"
                :key="total.currency"
                class="text-sm text-muted"
              >
                {{ money(total.amount, total.currency) }} across {{ total.count }} Refunds
              </p>
              <p
                v-if="!totalsFor('COMPLETED').length"
                class="text-sm text-muted"
              >
                No completed Refunds
              </p>
            </UPageCard>
          </div>

          <UPageCard title="Payment status">
            <UTable
              :data="statuses.map(status => ({ status, count: data.payments[status] }))"
              :columns="[
                { accessorKey: 'status', header: 'Status' },
                { accessorKey: 'count', header: 'Payments' }
              ]"
            />
          </UPageCard>

          <UPageCard
            title="Invoices"
            description="Issued amounts, grouped by currency. Invoice value is not cash received."
          >
            <UTable
              :data="data.invoices"
              :columns="[
                { accessorKey: 'id', header: 'Invoice' },
                { accessorKey: 'bookingId', header: 'Booking' },
                { accessorKey: 'amount', header: 'Amount' },
                { accessorKey: 'issuedAt', header: 'Issued' }
              ]"
            >
              <template #amount-cell="{ row }">
                {{ money(row.original.amount, row.original.currency) }}
              </template>
              <template #issuedAt-cell="{ row }">
                {{ new Date(row.original.issuedAt).toLocaleString() }}
              </template>
            </UTable>
          </UPageCard>

          <UPageCard
            title="Refund records"
            description="Each Refund stays pending until its transfer date and reference are recorded."
          >
            <UTable
              :data="data.refunds"
              :columns="[
                { accessorKey: 'id', header: 'Refund' },
                { id: 'target', header: 'Booking or Payment' },
                { accessorKey: 'amount', header: 'Amount' },
                { accessorKey: 'status', header: 'Status' },
                { accessorKey: 'transferredAt', header: 'Transferred' },
                { accessorKey: 'transferReference', header: 'Reference' }
              ]"
            >
              <template #target-cell="{ row }">
                {{ row.original.bookingId ?? row.original.paymentId }}
              </template>
              <template #amount-cell="{ row }">
                {{ money(row.original.amount, row.original.currency) }}
              </template>
              <template #transferredAt-cell="{ row }">
                {{ row.original.transferredAt ? new Date(row.original.transferredAt).toLocaleDateString() : 'Pending' }}
              </template>
            </UTable>
          </UPageCard>

          <UPageCard
            title="Audit history"
            description="Recent operational and financial changes"
          >
            <UTable
              :data="data.auditEvents"
              :columns="[
                { accessorKey: 'action', header: 'Action' },
                { id: 'target', header: 'Target' },
                { id: 'actor', header: 'Actor' },
                { accessorKey: 'createdAt', header: 'Time' }
              ]"
            >
              <template #target-cell="{ row }">
                {{ row.original.entityType }} {{ row.original.entityId }}
              </template>
              <template #actor-cell="{ row }">
                {{ row.original.actorName ?? row.original.actorId ?? 'System' }}
              </template>
              <template #createdAt-cell="{ row }">
                {{ new Date(row.original.createdAt).toLocaleString() }}
              </template>
            </UTable>
          </UPageCard>
        </UContainer>
      </template>
    </UDashboardPanel>
  </div>
</template>
