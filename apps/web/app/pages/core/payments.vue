<script setup lang="ts">
type Payment = {
  id: string
  holdId: string
  customerRef: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  rejectionReason: string | null
  submittedAt: string
  reviewedAt: string | null
}

const authClient = useAuthClient()
const activeOrganization = authClient?.useActiveOrganization()
const { public: { apiUrl } } = useRuntimeConfig()
const toast = useToast()
const organizationId = computed(() => activeOrganization?.value?.data?.id ?? null)
const rows = ref<Payment[]>([])
const loading = ref(false)

async function refresh() {
  if (!organizationId.value) return
  loading.value = true
  try {
    rows.value = await $fetch<Payment[]>('/payments/manage', {
      baseURL: apiUrl,
      credentials: 'include',
      query: { organizationId: organizationId.value },
    })
  } catch (error) {
    handleError(error)
  } finally {
    loading.value = false
  }
}

async function review(payment: Payment, status: 'APPROVED' | 'REJECTED') {
  if (!organizationId.value) return
  const reason = status === 'REJECTED' ? window.prompt('Why is this payment being rejected?')?.trim() : undefined
  if (status === 'REJECTED' && !reason) return
  try {
    await $fetch(`/payments/${payment.id}/review`, {
      baseURL: apiUrl,
      credentials: 'include',
      method: 'PATCH',
      query: { organizationId: organizationId.value },
      body: { status, reason },
    })
    toast.add({ description: `Payment ${status.toLowerCase()}` })
    await refresh()
  } catch (error) {
    handleError(error)
  }
}

function proofUrl(payment: Payment) {
  return `${apiUrl}/payments/${payment.id}/proof?organizationId=${organizationId.value}`
}

watch(organizationId, refresh, { immediate: true })
useHead({ title: 'Payments' })
</script>

<template>
  <div class="flex flex-1 overflow-auto">
    <UDashboardPanel>
      <template #header>
        <UDashboardNavbar title="Payments">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #right>
            <UButton icon="i-lucide-refresh-cw" variant="ghost" :loading="loading" @click="refresh" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <UContainer class="max-w-6xl">
          <UPageCard title="Pending payment proof" :description="`${rows.length} payment(s) awaiting review`">
            <UTable :data="rows" :columns="[
              { accessorKey: 'customerRef', header: 'Customer' },
              { accessorKey: 'holdId', header: 'Hold' },
              { accessorKey: 'submittedAt', header: 'Submitted' },
              { accessorKey: 'status', header: 'Status' },
              { id: 'actions', header: 'Actions' },
            ]">
              <template #submittedAt-cell="{ row }">
                {{ new Date(row.original.submittedAt).toLocaleString() }}
              </template>
              <template #actions-cell="{ row }">
                <div class="flex gap-2">
                  <UButton :to="proofUrl(row.original)" target="_blank" size="sm" variant="soft" label="View proof" />
                  <UButton size="sm" label="Approve" @click="review(row.original, 'APPROVED')" />
                  <UButton size="sm" color="error" variant="soft" label="Reject" @click="review(row.original, 'REJECTED')" />
                </div>
              </template>
            </UTable>
          </UPageCard>
        </UContainer>
      </template>
    </UDashboardPanel>
  </div>
</template>
