<script setup lang="ts">
import { computed } from 'vue'
import { CATEGORIES, ELEMENTS, type ElementInfo } from '../data/elements'

const props = defineProps<{
  hit: Set<number>
  filterActive: boolean
  selected: number | null
}>()

const emit = defineEmits<{
  (e: 'select', el: ElementInfo): void
}>()

const groups = computed(() =>
  CATEGORIES.map((meta) => {
    const all = ELEMENTS.filter((e) => e.category === meta.key)
    const items = props.filterActive ? all.filter((e) => props.hit.has(e.number)) : all
    return { meta, all, items }
  }).filter((g) => g.items.length > 0),
)

const total = computed(() => groups.value.reduce((s, g) => s + g.items.length, 0))
</script>

<template>
  <div class="list-view">
    <p v-if="total === 0" class="empty">没有符合条件的元素，试试其他关键词或清除筛选。</p>

    <section v-for="g in groups" :key="g.meta.key" class="group">
      <header class="group-head">
        <span class="swatch" :style="{ background: g.meta.color }"></span>
        <h3>{{ g.meta.label }}</h3>
        <span class="count">
          {{ props.filterActive ? `${g.items.length} / ${g.all.length}` : g.all.length }}
        </span>
        <p class="desc">{{ g.meta.desc }}</p>
      </header>
      <div class="cards">
        <button
          v-for="el in g.items"
          :key="el.number"
          class="card"
          :class="{ active: props.selected === el.number }"
          :style="{ '--c': g.meta.color }"
          @click="emit('select', el)"
        >
          <span class="c-num">{{ el.number }}</span>
          <span class="c-sym">{{ el.symbol }}</span>
          <span class="c-name">{{ el.name }}</span>
          <span class="c-en">{{ el.enName }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.list-view {
  display: flex;
  flex-direction: column;
  gap: 26px;
  padding: 8px 2px 20px;
}

.empty {
  padding: 40px 0;
  text-align: center;
  color: var(--text-dim);
  font-size: 14px;
}

.group-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.group-head h3 {
  font-size: 15px;
  font-weight: 600;
}

.count {
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 99px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.desc {
  flex: 1 1 100%;
  font-size: 12px;
  color: var(--text-faint);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 9px 11px 10px;
  border-radius: 12px;
  text-align: left;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--c) 30%, transparent);
  background: linear-gradient(
    155deg,
    color-mix(in srgb, var(--c) 16%, var(--tile-bg)),
    var(--tile-bg)
  );
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}

.card:hover {
  transform: translateY(-2px);
  border-color: var(--c);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--c) 32%, transparent);
}

.card.active {
  border-color: var(--c);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 60%, transparent);
}

.card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.c-num {
  font-size: 10.5px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.c-sym {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.15;
  color: color-mix(in srgb, var(--c) 62%, var(--text));
}

.c-name {
  font-size: 12.5px;
  color: var(--text);
}

.c-en {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

@media (max-width: 520px) {
  .cards {
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  }
}
</style>
