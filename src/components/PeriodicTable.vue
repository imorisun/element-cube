<script setup lang="ts">
import { computed } from 'vue'
import ElementTile from './ElementTile.vue'
import { CATEGORY_MAP, ELEMENTS, type CategoryKey, type ElementInfo } from '../data/elements'

const props = defineProps<{
  /** 命中筛选的元素编号集合 */
  hit: Set<number>
  filterActive: boolean
  selected: number | null
  hovered: number | null
}>()

const emit = defineEmits<{
  (e: 'select', el: ElementInfo): void
  (e: 'hover', el: ElementInfo | null): void
  (e: 'pick-series', series: 'lanthanide' | 'actinide'): void
}>()

const groups = Array.from({ length: 18 }, (_, i) => i + 1)
const periods = Array.from({ length: 7 }, (_, i) => i + 1)

const hoveredEl = computed(() =>
  props.hovered ? ELEMENTS.find((e) => e.number === props.hovered) ?? null : null,
)

function isRelated(el: ElementInfo): boolean {
  const h = hoveredEl.value
  if (!h || h.number === el.number) return false
  if (h.category === 'lanthanide' || h.category === 'actinide') {
    return el.category === h.category
  }
  if (h.group != null && el.group === h.group) return true
  return el.period === h.period
}

function isMatched(el: ElementInfo): boolean {
  return props.filterActive && props.hit.has(el.number)
}

function isDimmed(el: ElementInfo): boolean {
  return props.filterActive && !props.hit.has(el.number)
}

const lanthanides = computed(() => ELEMENTS.filter((e) => e.category === 'lanthanide'))
const actinides = computed(() => ELEMENTS.filter((e) => e.category === 'actinide'))

function colorOf(cat: CategoryKey) {
  return CATEGORY_MAP[cat].color
}
</script>

<template>
  <div class="table-scroll">
    <div class="table">
      <div class="corner"></div>
      <div
        v-for="g in groups"
        :key="'g' + g"
        class="axis-label"
        :style="{ gridColumn: g + 1, gridRow: 1 }"
      >
        {{ g }}
      </div>
      <div
        v-for="p in periods"
        :key="'p' + p"
        class="axis-label row"
        :style="{ gridColumn: 1, gridRow: p + 1 }"
      >
        {{ p }}
      </div>

      <div class="axis-label row series" :style="{ gridColumn: 1, gridRow: 10 }">镧系</div>
      <div class="axis-label row series" :style="{ gridColumn: 1, gridRow: 11 }">锕系</div>

      <div class="gap" :style="{ gridColumn: '1 / -1', gridRow: 9 }"></div>

      <button
        class="placeholder"
        :style="{ gridColumn: 4, gridRow: 7, '--c': colorOf('lanthanide') }"
        @click="emit('pick-series', 'lanthanide')"
        @mouseenter="emit('hover', lanthanides[0])"
        @mouseleave="emit('hover', null)"
      >
        <span class="ph-range">57–71</span>
        <span class="ph-name">镧系</span>
      </button>
      <button
        class="placeholder"
        :style="{ gridColumn: 4, gridRow: 8, '--c': colorOf('actinide') }"
        @click="emit('pick-series', 'actinide')"
        @mouseenter="emit('hover', actinides[0])"
        @mouseleave="emit('hover', null)"
      >
        <span class="ph-range">89–103</span>
        <span class="ph-name">锕系</span>
      </button>

      <ElementTile
        v-for="el in ELEMENTS"
        :key="el.number"
        :element="el"
        :matched="isMatched(el)"
        :dimmed="isDimmed(el)"
        :related="!props.filterActive && isRelated(el)"
        :selected="props.selected === el.number"
        @select="emit('select', $event)"
        @hover="emit('hover', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.table-scroll {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 4px 2px 10px;
}

.table {
  display: grid;
  grid-template-columns: 36px repeat(18, minmax(0, 1fr));
  grid-template-rows: 18px repeat(7, auto) 14px auto auto;
  gap: clamp(3px, 0.32vw, 6px);
  min-width: 880px;
}

.axis-label {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
  user-select: none;
}

.axis-label.row {
  font-size: 11px;
  color: var(--text-dim);
}

.axis-label.series {
  font-size: 10px;
  line-height: 1.05;
  text-align: center;
  color: var(--text-faint);
}

.gap {
  height: 6px;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  aspect-ratio: 1 / 1;
  width: 100%;
  border-radius: 10px;
  border: 1px dashed color-mix(in srgb, var(--c) 55%, transparent);
  background: color-mix(in srgb, var(--c) 8%, transparent);
  transition: all 0.18s ease;
}

.placeholder:hover {
  background: color-mix(in srgb, var(--c) 18%, transparent);
  border-style: solid;
  transform: translateY(-2px);
}

.ph-range {
  font-size: clamp(7.5px, 0.55vw, 10px);
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}

.ph-name {
  font-size: clamp(8px, 0.6vw, 11px);
  color: color-mix(in srgb, var(--c) 65%, var(--text));
}

@media (max-width: 900px) {
  .table {
    gap: 3px;
  }
}
</style>
