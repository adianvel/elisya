<template>
  <div class="min-h-screen bg-[#f4f7f5] text-[#102522]">
    <header class="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
      <NuxtLink
        to="/"
        class="flex items-center gap-3 font-semibold tracking-tight"
      >
        <span class="grid size-9 place-items-center rounded-xl bg-[#103f38] text-sm text-[#f5c96a]">P</span>
        <span>Palawa</span>
      </NuxtLink>
      <NuxtLink
        to="/core"
        class="text-sm text-[#52706a] transition hover:text-[#103f38]"
      >Owner login</NuxtLink>
    </header>
    <slot />
    <footer class="mx-auto max-w-6xl px-5 py-10 text-sm text-[#6d8580] sm:px-8">
      Travel simply. Arrive ready.
    </footer>
  </div>
</template>
