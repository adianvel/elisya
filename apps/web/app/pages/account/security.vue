<script setup lang="ts">
definePageMeta({ auth: { only: 'user', redirectTo: '/auth/signin' } })

const authClient = useAuthClient()
const { user, fetchSession } = useUserSession()
const toast = useToast()
const password = ref('')
const code = ref('')
const totpSecret = ref('')
const backupCodes = ref<string[]>([])
const enrollmentStarted = ref(false)
const loading = ref(false)
const twoFactorEnabled = computed(() => user.value?.twoFactorEnabled === true)

async function beginEnrollment() {
  if (!authClient) return
  loading.value = true
  try {
    const result = await authClient.twoFactor.enable({ password: password.value, method: 'totp', issuer: 'Palawa' })
    if (result.error) throw new Error(result.error.message)
    if (result.data.method !== 'totp') throw new Error('Authenticator setup is unavailable')
    totpSecret.value = new URL(result.data.totpURI).searchParams.get('secret') ?? ''
    backupCodes.value = result.data.backupCodes
    enrollmentStarted.value = true
    password.value = ''
  } catch (error) {
    handleError(error)
  } finally {
    loading.value = false
  }
}

async function verifyEnrollment() {
  if (!authClient) return
  loading.value = true
  try {
    const result = await authClient.twoFactor.verifyTotp({ code: code.value.trim() })
    if (result.error) throw new Error(result.error.message)
    await fetchSession({ force: true })
    code.value = ''
    toast.add({ description: 'Two-factor authentication enabled' })
  } catch (error) {
    handleError(error)
  } finally {
    loading.value = false
  }
}

async function copySecret() {
  await navigator.clipboard.writeText(totpSecret.value)
  toast.add({ description: 'Authenticator key copied' })
}

useHead({ title: 'Account Security' })
</script>

<template>
  <div class="flex flex-1 overflow-auto">
    <UDashboardPanel id="account-security">
      <template #header>
        <UDashboardNavbar title="Account security">
          <template #leading><UDashboardSidebarCollapse /></template>
        </UDashboardNavbar>
      </template>
      <template #body>
        <UContainer class="max-w-3xl space-y-6">
          <UPageCard title="Two-factor authentication" description="Owners need an authenticator code to access business operations and financial records.">
            <UAlert
              v-if="twoFactorEnabled"
              color="success"
              title="Two-factor authentication is enabled"
              description="Sign-ins require a code from your authenticator app."
            />
            <form v-else-if="!enrollmentStarted" class="max-w-lg space-y-4" @submit.prevent="beginEnrollment">
              <p class="text-sm text-muted">Use an authenticator app such as 1Password, Google Authenticator, or Microsoft Authenticator.</p>
              <UFormField label="Account password" name="password">
                <UInput v-model="password" type="password" autocomplete="current-password" required />
              </UFormField>
              <UButton type="submit" label="Set up authenticator" :loading="loading" />
            </form>
            <div v-else class="max-w-lg space-y-5">
              <div class="space-y-2">
                <p class="text-sm">Add this key to your authenticator app:</p>
                <div class="flex items-center gap-2">
                  <code class="rounded bg-elevated px-3 py-2 text-sm break-all">{{ totpSecret }}</code>
                  <UButton icon="i-lucide-copy" variant="ghost" aria-label="Copy authenticator key" @click="copySecret" />
                </div>
              </div>
              <UAlert
                color="warning"
                title="Save your backup codes"
                description="Each code works once if you lose access to your authenticator. Store them somewhere private."
              />
              <ul class="grid grid-cols-2 gap-2 rounded bg-elevated p-3 font-mono text-sm">
                <li v-for="backupCode in backupCodes" :key="backupCode">{{ backupCode }}</li>
              </ul>
              <form class="space-y-3" @submit.prevent="verifyEnrollment">
                <UFormField label="Authenticator code" name="code">
                  <UInput v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required />
                </UFormField>
                <UButton type="submit" label="Verify and enable" :loading="loading" />
              </form>
            </div>
          </UPageCard>
        </UContainer>
      </template>
    </UDashboardPanel>
  </div>
</template>
