<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const authClient = useAuthClient()
const route = useRoute()
const { fetchSession } = useUserSession()
const code = ref('')
const loading = ref(false)
const errorMessage = ref('')
const useBackupCode = ref(false)

async function verify() {
  if (!authClient) return
  loading.value = true
  errorMessage.value = ''
  try {
    const result = useBackupCode.value
      ? await authClient.twoFactor.verifyBackupCode({ code: code.value.trim() })
      : await authClient.twoFactor.verifyTotp({ code: code.value.trim() })
    if (result.error) throw new Error(result.error.message)
    await fetchSession({ force: true })
    await navigateTo(typeof route.query.redirect === 'string' ? route.query.redirect : '/core')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'The authenticator code could not be verified.'
  } finally {
    loading.value = false
  }
}

useHead({ title: 'Verify sign-in' })
</script>

<template>
  <UPageCard title="Verify sign-in" description="Enter the current code from your authenticator app.">
    <form class="space-y-4" @submit.prevent="verify">
      <UFormField :label="useBackupCode ? 'Backup code' : 'Authenticator code'" name="code">
        <UInput
          v-model="code"
          :inputmode="useBackupCode ? 'text' : 'numeric'"
          :autocomplete="useBackupCode ? 'off' : 'one-time-code'"
          :maxlength="useBackupCode ? 16 : 8"
          required
        />
      </UFormField>
      <UAlert v-if="errorMessage" color="error" :description="errorMessage" />
      <UButton type="submit" label="Verify" :loading="loading" block />
      <UButton
        type="button"
        variant="link"
        :label="useBackupCode ? 'Use authenticator code' : 'Use a backup code'"
        class="px-0"
        @click="useBackupCode = !useBackupCode"
      />
    </form>
    <template #footer>
      <NuxtLink to="/auth/signin" class="text-primary font-medium">Return to sign in</NuxtLink>
    </template>
  </UPageCard>
</template>
