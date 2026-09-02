<script lang="ts">
  /**
   * Inline "working…" indicator.
   *
   * Every button that fires a device command shows one while the request is in
   * flight — a Tapo command goes through the hub and can easily take a second
   * or two, and without feedback the UI looks like the click was lost.
   * Inherits `currentColor`, so it picks up the colour of whatever contains it.
   */
  let { size = 16, class: cls = '' }: { size?: number; class?: string } = $props();
</script>

<svg class="animate-spin shrink-0 {cls}" width={size} height={size} viewBox="0 0 24 24"
     fill="none" aria-hidden="true" focusable="false">
  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" opacity="0.25" />
  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
</svg>
