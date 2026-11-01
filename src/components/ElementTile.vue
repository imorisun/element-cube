<script setup lang="ts">
import { computed } from 'vue'
import { CATEGORY_MAP, type ElementInfo } from '../data/elements'

const props = defineProps<{
  element: ElementInfo
  /** 搜索/筛选命中 */
  matched: boolean
  /** 有筛选条件但未命中 */
  dimmed: boolean
  /** 与当前悬停元素同行或同族 */
  related: boolean
  selected: boolean
}>()

const emit = defineEmits<{
  (e: 'select', el: ElementInfo): void
  (e: 'hover', el: ElementInfo | null): void
}>()

const meta = computed(() => CATEGORY_MAP[props.element.category])

const massText = computed(() => {
  const m = props.element.mass
  if (!m) return '—'
  return Number.isInteger(m) ? String(m) : m.toFixed(m < 100 ? 2 : 1)
})
</script>

<template>
  <button
    class="tile"
    :class="{
      matched,
      dimmed,
      related,
      selected,
      'is-f': element.block === 'f',
    }"
    :style="{
      '--c': meta.color,
      gridColumn: element.grid.col + 1,
      gridRow: element.grid.row,
    }"
    :title="`${element.number} ${element.name} ${element.symbol} · ${meta.label}`"
    :aria-label="`${element.number} ${element.name} ${element.enName}`"
    @click="emit('select', element)"
    @mouseenter="emit('hover', element)"
    @mouseleave="emit('hover', null)"
    @focus="emit('hover', element)"
    @blur="emit('hover', null)"
  >
    <span class="num">{{ element.number }}</span>
    <span class="sym">{{ element.symbol }}</span>
    <span class="name">{{ element.name }}</span>
    <span class="mass">{{ massText }}</span>
  </button>
</template>

<style scoped>
.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  aspect-ratio: 1 / 1;
  width: 100%;
  padding: 2px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--c) 34%, transparent);
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--c) 20%, var(--tile-bg)),
    var(--tile-bg)
  );
  overflow: hidden;
  transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.3, 1), box-shadow 0.18s ease,
    opacity 0.22s ease, border-color 0.18s ease, filter 0.22s ease;
  will-change: transform;
}

.tile::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(140deg, rgba(255, 255, 255, 0.45), transparent 55%);
  opacity: 0.5;
  pointer-events: none;
}

[data-theme='dark'] .tile::after {
  opacity: 0.12;
}

.num {
  font-size: clamp(8px, 0.62vw, 11px);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}

.sym {
  font-size: clamp(13px, 1.32vw, 24px);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.02em;
  color: color-mix(in srgb, var(--c) 62%, var(--text));
}

.name {
  font-size: clamp(8px, 0.62vw, 11.5px);
  line-height: 1.1;
  color: var(--text);
  white-space: nowrap;
}

.mass {
  font-size: clamp(7px, 0.5vw, 9px);
  line-height: 1;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.tile:hover {
  transform: translateY(-3px) scale(1.06);
  box-shadow: 0 10px 22px color-mix(in srgb, var(--c) 38%, transparent);
  border-color: var(--c);
  z-index: 3;
}

.tile.related {
  border-color: color-mix(in srgb, var(--c) 70%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--c) 30%, transparent) inset;
}

.tile.matched {
  border-color: var(--c);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 55%, transparent),
    0 8px 20px color-mix(in srgb, var(--c) 30%, transparent);
  z-index: 2;
}

.tile.dimmed {
  opacity: 0.16;
  filter: saturate(0.25);
}

.tile.dimmed:hover {
  opacity: 0.75;
  filter: saturate(1);
}

.tile.selected {
  transform: translateY(-2px) scale(1.04);
  border-color: var(--c);
  box-shadow: 0 0 0 2px var(--c), 0 12px 26px color-mix(in srgb, var(--c) 45%, transparent);
  z-index: 4;
}

@media (max-width: 900px) {
  .tile {
    border-radius: 8px;
  }
}
</style>
