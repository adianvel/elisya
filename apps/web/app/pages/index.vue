<script setup lang="ts">
type Trip = {
  id: string
  origin: string
  destination: string
  departureAt: string
  price: number
  currency: string
  remainingSeats: number
}

definePageMeta({ layout: 'marketing' })
useHead({ title: 'Palawa trips' })

const { public: { apiUrl } } = useRuntimeConfig()
const trips = ref<Trip[]>([])
const loading = ref(true)
const error = ref('')

async function loadTrips() {
  loading.value = true
  error.value = ''
  try {
    trips.value = await $fetch<Trip[]>('/trips', { baseURL: apiUrl })
  } catch (errorValue) {
    error.value = errorValue instanceof Error ? errorValue.message : 'Could not load trips.'
  } finally {
    loading.value = false
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatPrice(price: number, currency: string) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency, maximumFractionDigits: 0 }).format(price)
}

loadTrips()
</script>

<template>
  <main>
    <section class="mx-auto grid max-w-6xl gap-10 px-5 pb-14 pt-10 sm:px-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:pt-20">
      <div>
        <p class="mb-5 text-sm font-medium text-[#c2792c]">
          Travel from the first click
        </p>
        <h1 class="max-w-2xl text-5xl font-semibold leading-[0.98] tracking-[-0.06em] text-[#103f38] sm:text-7xl">
          Your next route starts here.
        </h1>
        <p class="mt-6 max-w-xl text-lg leading-8 text-[#52706a]">
          Browse available routes, then book and send your transfer receipt through WhatsApp. Your WhatsApp number keeps your booking connected to you.
        </p>
      </div>
      <div class="rounded-[2rem] bg-[#103f38] p-6 text-[#f4f7f5] shadow-[0_20px_60px_rgba(16,63,56,0.18)] sm:p-8">
        <p class="text-sm font-medium text-[#b9d0c8]">
          Booking happens in WhatsApp
        </p>
        <h2 class="mt-4 text-2xl font-semibold">
          Pick a route below
        </h2>
        <p class="mt-3 text-sm leading-6 text-[#d7e5df]">
          Message the Palawa travel team with your route and departure. They will help you reserve seats and send your payment proof in the same conversation.
        </p>
      </div>
    </section>

    <section class="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
      <div class="rounded-[1.75rem] border border-[#d6e3de] bg-white p-5 shadow-sm sm:p-8">
        <div class="flex items-end justify-between gap-4 border-b border-[#e5eeeb] pb-5">
          <div>
            <p class="text-sm font-medium text-[#c2792c]">
              Available routes
            </p><h2 class="mt-1 text-2xl font-semibold tracking-tight text-[#103f38]">
              Where are you going?
            </h2>
          </div>
          <button
            class="text-sm text-[#52706a] underline-offset-4 hover:underline"
            @click="loadTrips"
          >
            Refresh
          </button>
        </div>
        <div
          v-if="loading"
          class="py-14 text-center text-[#6d8580]"
        >
          Loading routes…
        </div>
        <div
          v-else-if="!trips.length"
          class="py-14 text-center text-[#6d8580]"
        >
          No published trips yet. Check back soon.
        </div>
        <div
          v-else
          class="mt-6 grid gap-3 sm:grid-cols-2"
        >
          <article
            v-for="trip in trips"
            :key="trip.id"
            class="rounded-2xl border border-[#dce9e4] p-4"
          >
            <div class="flex items-center justify-between gap-4">
              <div class="flex min-w-0 items-center gap-3">
                <span class="size-2 rounded-full bg-[#c2792c]" /><span class="truncate font-semibold text-[#103f38]">{{ trip.origin }}</span><span class="text-[#8aa39c]">→</span><span class="truncate font-semibold text-[#103f38]">{{ trip.destination }}</span>
              </div><span class="shrink-0 font-semibold text-[#103f38]">{{ formatPrice(trip.price, trip.currency) }}</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-[#6d8580]">
              <span>{{ formatDate(trip.departureAt) }}</span><span>{{ trip.remainingSeats }} seats left</span>
            </div>
          </article>
        </div>
        <p
          v-if="error"
          class="mt-5 rounded-xl border border-[#e3b8b0] bg-[#fff3f1] px-4 py-3 text-sm text-[#9b3b2f]"
        >
          {{ error }}
        </p>
      </div>
    </section>
  </main>
</template>
