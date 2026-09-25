<script setup lang="ts">
type Trip = {
  id: string
  origin: string
  destination: string
  departureAt: string
  price: number
  currency: string
  seatQuota: number
  remainingSeats: number
}

type Hold = {
  id: string
  expiresAt: string
  seatCount: number
}

type Payment = {
  id: string
  holdId: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  rejectionReason: string | null
}

type Booking = {
  id: string
  status: 'CONFIRMED' | 'PAYMENT_REJECTED'
  seatCount: number
  invoice: { amount: number; currency: string; status: 'ISSUED' } | null
}

definePageMeta({ layout: 'marketing' })
useHead({ title: 'Book your next trip' })

const { public: { apiUrl } } = useRuntimeConfig()
const trips = ref<Trip[]>([])
const loading = ref(true)
const error = ref('')
const customerRef = useLocalStorage('palawa-customer-ref', '')
const selectedTripId = ref('')
const seatCount = ref(1)
const hold = ref<Hold | null>(null)
const payment = ref<Payment | null>(null)
const booking = ref<Booking | null>(null)
const proofKey = ref('')
const bookingId = ref('')
const busy = ref(false)

const selectedTrip = computed(() => trips.value.find(trip => trip.id === selectedTripId.value))
const step = computed(() => booking.value ? 4 : payment.value ? 3 : hold.value ? 2 : 1)

function messageFor(errorValue: unknown) {
  return errorValue instanceof Error ? errorValue.message : 'Something went wrong. Please try again.'
}

async function loadTrips() {
  loading.value = true
  error.value = ''
  try {
    trips.value = await $fetch<Trip[]>('/trips', { baseURL: apiUrl })
    if (!selectedTripId.value) selectedTripId.value = trips.value[0]?.id ?? ''
  } catch (errorValue) {
    error.value = messageFor(errorValue)
  } finally {
    loading.value = false
  }
}

async function createHold() {
  if (!selectedTrip.value || !customerRef.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    hold.value = await $fetch<Hold>('/holds', {
      baseURL: apiUrl,
      method: 'POST',
      body: {
        tripId: selectedTrip.value.id,
        customerRef: customerRef.value.trim(),
        seatCount: seatCount.value,
        idempotencyKey: `web-hold-${selectedTrip.value.id}-${customerRef.value.trim()}-${seatCount.value}`
      }
    })
  } catch (errorValue) {
    error.value = messageFor(errorValue)
  } finally {
    busy.value = false
  }
}

async function submitPayment() {
  if (!hold.value || !customerRef.value.trim() || !proofKey.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    payment.value = await $fetch<Payment>('/payments', {
      baseURL: apiUrl,
      method: 'POST',
      body: {
        holdId: hold.value.id,
        customerRef: customerRef.value.trim(),
        proofKey: proofKey.value.trim(),
        idempotencyKey: `web-payment-${hold.value.id}`
      }
    })
  } catch (errorValue) {
    error.value = messageFor(errorValue)
  } finally {
    busy.value = false
  }
}

async function checkBooking() {
  if (!bookingId.value.trim() || !customerRef.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const result = await $fetch<Booking | { error: string }>(`/bookings/${bookingId.value.trim()}`, {
      baseURL: apiUrl,
      query: { customerRef: customerRef.value.trim() }
    })
    if ('error' in result) throw new Error(result.error)
    booking.value = result
  } catch (errorValue) {
    error.value = messageFor(errorValue)
  } finally {
    busy.value = false
  }
}

function reset() {
  hold.value = null
  payment.value = null
  booking.value = null
  proofKey.value = ''
  bookingId.value = ''
  error.value = ''
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
        <p class="mb-5 text-sm font-medium text-[#c2792c]">Travel from the first click</p>
        <h1 class="max-w-2xl text-5xl font-semibold leading-[0.98] tracking-[-0.06em] text-[#103f38] sm:text-7xl">Your next route, held while you get ready.</h1>
        <p class="mt-6 max-w-xl text-lg leading-8 text-[#52706a]">Choose a published trip, reserve your seats for 15 minutes, then send your transfer proof. Your booking is confirmed as soon as the travel team verifies it.</p>
      </div>
      <div class="rounded-[2rem] bg-[#103f38] p-6 text-[#f4f7f5] shadow-[0_20px_60px_rgba(16,63,56,0.18)] sm:p-8">
        <div class="flex items-center justify-between text-sm text-[#b9d0c8]"><span>Simple booking</span><span>{{ step }}/4</span></div>
        <div class="mt-5 h-1.5 rounded-full bg-[#315f57]"><div class="h-full rounded-full bg-[#f5c96a] transition-all" :style="{ width: `${step * 25}%` }" /></div>
        <div class="mt-8 flex items-center gap-4 text-sm text-[#d7e5df]"><span class="grid size-9 place-items-center rounded-full bg-[#f5c96a] font-semibold text-[#103f38]">{{ step }}</span><span>{{ booking ? 'Booking ready' : payment ? 'Payment received' : hold ? 'Seats held' : 'Choose your trip' }}</span></div>
      </div>
    </section>

    <section class="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
      <div class="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div class="rounded-[1.75rem] border border-[#d6e3de] bg-white p-5 shadow-sm sm:p-8">
          <div class="flex items-end justify-between gap-4 border-b border-[#e5eeeb] pb-5">
            <div><p class="text-sm font-medium text-[#c2792c]">Available routes</p><h2 class="mt-1 text-2xl font-semibold tracking-tight text-[#103f38]">Where are you going?</h2></div>
            <button class="text-sm text-[#52706a] underline-offset-4 hover:underline" @click="loadTrips">Refresh</button>
          </div>
          <div v-if="loading" class="py-14 text-center text-[#6d8580]">Loading routes…</div>
          <div v-else-if="!trips.length" class="py-14 text-center text-[#6d8580]">No published trips yet. Check back soon.</div>
          <div v-else class="mt-6 space-y-3">
            <button v-for="trip in trips" :key="trip.id" class="w-full rounded-2xl border p-4 text-left transition hover:border-[#77a99b]" :class="selectedTripId === trip.id ? 'border-[#103f38] bg-[#eff7f3]' : 'border-[#dce9e4]'" @click="selectedTripId = trip.id">
              <div class="flex items-center justify-between gap-4"><div class="flex min-w-0 items-center gap-3"><span class="size-2 rounded-full bg-[#c2792c]" /><span class="truncate font-semibold text-[#103f38]">{{ trip.origin }}</span><span class="text-[#8aa39c]">→</span><span class="truncate font-semibold text-[#103f38]">{{ trip.destination }}</span></div><span class="shrink-0 font-semibold text-[#103f38]">{{ formatPrice(trip.price, trip.currency) }}</span></div>
              <div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-[#6d8580]"><span>{{ formatDate(trip.departureAt) }}</span><span>{{ trip.remainingSeats }} seats left</span></div>
            </button>
          </div>
        </div>

        <div class="rounded-[1.75rem] bg-[#fffaf0] p-5 ring-1 ring-[#f0dfb9] sm:p-8">
          <p class="text-sm font-medium text-[#c2792c]">Reserve your seat</p>
          <h2 class="mt-1 text-2xl font-semibold tracking-tight text-[#103f38]">Keep your route close</h2>
          <p class="mt-3 text-sm leading-6 text-[#6d8580]">Use an email or WhatsApp number so the team can match your booking.</p>
          <label class="mt-6 block text-sm font-medium text-[#103f38]">Your contact</label>
          <input v-model="customerRef" class="mt-2 w-full rounded-xl border border-[#d9d3c2] bg-white px-4 py-3 outline-none ring-[#103f38] focus:ring-2" placeholder="you@example.com or +62…" type="text">
          <label class="mt-4 block text-sm font-medium text-[#103f38]">Seats</label>
          <input v-model.number="seatCount" class="mt-2 w-full rounded-xl border border-[#d9d3c2] bg-white px-4 py-3 outline-none ring-[#103f38] focus:ring-2" min="1" :max="selectedTrip?.remainingSeats ?? 1" type="number">
          <button class="mt-5 w-full rounded-xl bg-[#103f38] px-4 py-3 font-semibold text-white transition hover:bg-[#1a554b] disabled:cursor-not-allowed disabled:opacity-40" :disabled="busy || !selectedTrip || !customerRef.trim()" @click="createHold">{{ busy ? 'Working…' : 'Hold these seats' }}</button>
          <p v-if="selectedTrip" class="mt-4 text-xs text-[#6d8580]">Selected: {{ selectedTrip.origin }} → {{ selectedTrip.destination }}</p>
        </div>
      </div>

      <div v-if="hold" class="mt-6 grid gap-6 rounded-[1.75rem] border border-[#bcd8cc] bg-[#eff7f3] p-5 sm:p-8 lg:grid-cols-[1fr_0.8fr]">
        <div><p class="text-sm font-medium text-[#2d7c68]">Seats held until {{ formatDate(hold.expiresAt) }}</p><h2 class="mt-1 text-2xl font-semibold tracking-tight text-[#103f38]">Send your payment proof</h2><p class="mt-3 text-sm leading-6 text-[#52706a]">The MVP accepts a proof reference or uploaded-file key. Your travel team will verify it from the owner dashboard.</p></div>
        <div><label class="block text-sm font-medium text-[#103f38]">Proof reference</label><input v-model="proofKey" class="mt-2 w-full rounded-xl border border-[#c7ddd4] bg-white px-4 py-3 outline-none ring-[#103f38] focus:ring-2" placeholder="transfer-2026-001.jpg" type="text"><button class="mt-4 w-full rounded-xl bg-[#2d7c68] px-4 py-3 font-semibold text-white transition hover:bg-[#246653] disabled:opacity-40" :disabled="busy || !proofKey.trim()" @click="submitPayment">Submit proof</button></div>
      </div>

      <div v-if="payment" class="mt-6 rounded-[1.75rem] border border-[#d6e3de] bg-white p-5 sm:p-8">
        <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-sm font-medium text-[#2d7c68]">Payment {{ payment.status.toLowerCase() }}</p><h2 class="mt-1 text-2xl font-semibold tracking-tight text-[#103f38]">Your proof is with the team</h2><p class="mt-3 text-sm text-[#6d8580]">Keep this contact and hold information. Once approved, check your booking below.</p></div><span class="rounded-full bg-[#fff4d5] px-3 py-1 text-sm text-[#98611f]">{{ payment.id }}</span></div>
      </div>

      <div class="mt-6 rounded-[1.75rem] border border-[#d6e3de] bg-white p-5 sm:p-8">
        <div class="flex flex-wrap items-end justify-between gap-4"><div><p class="text-sm font-medium text-[#c2792c]">After approval</p><h2 class="mt-1 text-2xl font-semibold tracking-tight text-[#103f38]">Check your booking</h2></div><button class="text-sm text-[#52706a] underline-offset-4 hover:underline" @click="reset">Start another booking</button></div>
        <div class="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"><label class="text-sm font-medium text-[#103f38]">Booking ID<input v-model="bookingId" class="mt-2 block w-full rounded-xl border border-[#d6e3de] px-4 py-3 outline-none ring-[#103f38] focus:ring-2" placeholder="Paste the booking ID" type="text"></label><button class="rounded-xl bg-[#103f38] px-5 py-3 font-semibold text-white transition hover:bg-[#1a554b] disabled:opacity-40" :disabled="busy || !bookingId.trim() || !customerRef.trim()" @click="checkBooking">Check status</button></div>
        <div v-if="booking" class="mt-6 rounded-2xl bg-[#eff7f3] p-5"><div class="flex flex-wrap justify-between gap-3"><span class="font-semibold text-[#103f38]">{{ booking.status === 'CONFIRMED' ? 'Booking confirmed' : 'Payment rejected' }}</span><span class="text-sm text-[#52706a]">{{ booking.seatCount }} seat(s)</span></div><p v-if="booking.invoice" class="mt-3 text-lg font-semibold text-[#103f38]">Invoice: {{ formatPrice(booking.invoice.amount, booking.invoice.currency) }}</p></div>
      </div>
      <p v-if="error" class="mt-5 rounded-xl border border-[#e3b8b0] bg-[#fff3f1] px-4 py-3 text-sm text-[#9b3b2f]">{{ error }}</p>
    </section>
  </main>
</template>
