<script setup lang="ts">
import { computed, defineAsyncComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PeriodicTable from './components/PeriodicTable.vue'
import ElementListView from './components/ElementListView.vue'
import ElementDetail from './components/ElementDetail.vue'

/** 3D 立方视图依赖 three.js，按需异步加载 */
const TableCube3D = defineAsyncComponent({
  loader: () => import('./components/TableCube3D.vue'),
  loadingComponent: {
    render: () =>
      h('div', { class: 'cube-loading' }, [
        h('span', { class: 'cube-spinner' }),
        '正在构建 3D 周期表…',
      ]),
  },
  delay: 100,
})
import { useElementFilter } from './composables/useElementFilter'
import {
  CATEGORIES,
  ELEMENTS,
  ELEMENT_BY_NUMBER,
  type CategoryKey,
  type ElementInfo,
} from './data/elements'

type Mode = 'grid' | 'list' | 'cube'

const query = ref('')
const activeCats = ref<Set<CategoryKey>>(new Set())
const selected = ref<number | null>(null)
const hovered = ref<number | null>(null)
const mode = ref<Mode>('grid')
const theme = ref<'light' | 'dark'>('light')
const searchInput = ref<HTMLInputElement | null>(null)

const { hit, hitCount, filterActive } = useElementFilter(query, activeCats)

const selectedEl = computed<ElementInfo | null>(() =>
  selected.value ? ELEMENT_BY_NUMBER[selected.value] ?? null : null,
)

const MODES: { key: Mode; label: string }[] = [
  { key: 'grid', label: '周期表' },
  { key: 'list', label: '列表' },
  { key: 'cube', label: '3D 立方' },
]

function toggleCat(key: CategoryKey) {
  const next = new Set(activeCats.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  activeCats.value = next
}

function clearFilters() {
  query.value = ''
  activeCats.value = new Set()
}

function select(el: ElementInfo) {
  selected.value = el.number
}

function selectByNumber(n: number) {
  if (ELEMENT_BY_NUMBER[n]) selected.value = n
}

function pickSeries(series: 'lanthanide' | 'actinide') {
  selectByNumber(series === 'lanthanide' ? 57 : 89)
}

function randomElement() {
  const n = 1 + Math.floor(Math.random() * ELEMENTS.length)
  selectByNumber(n)
}

function applyTheme() {
  document.documentElement.dataset.theme = theme.value
}

function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
  if (e.key === '/' && !typing) {
    e.preventDefault()
    searchInput.value?.focus()
  }
  if (e.key === 'Escape' && typing) {
    ;(e.target as HTMLInputElement).blur()
  }
}

onMounted(() => {
  const saved = localStorage.getItem('ec-theme')
  if (saved === 'dark' || saved === 'light') theme.value = saved
  else theme.value = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyTheme()

  mode.value = window.innerWidth < 900 ? 'list' : 'grid'
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})

watch(theme, (v) => {
  applyTheme()
  localStorage.setItem('ec-theme', v)
})
</script>

<template>
  <div class="aurora" aria-hidden="true">
    <span class="blob b1"></span>
    <span class="blob b2"></span>
    <span class="blob b3"></span>
  </div>

  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="cube-logo" aria-hidden="true">
          <span class="f f1">C</span>
          <span class="f f2">u</span>
          <span class="f f3">b</span>
          <span class="f f4">e</span>
          <span class="f f5">6</span>
          <span class="f f6">C</span>
        </div>
        <div class="brand-text">
          <h1>元素立方</h1>
          <p>118 种元素 · 3D 原子模型 · 搜索与分类筛选</p>
        </div>
      </div>

      <div class="tools">
        <div class="search" :class="{ filled: query.length > 0 }">
          <span class="search-icon" aria-hidden="true">⌕</span>
          <input
            ref="searchInput"
            v-model="query"
            type="search"
            placeholder="搜索元素：氢 / He / oxygen / 26"
            aria-label="搜索元素"
            autocomplete="off"
          />
          <button v-if="query" class="clear" aria-label="清除搜索" @click="query = ''">✕</button>
          <kbd>/</kbd>
        </div>

        <div class="segment" role="tablist" aria-label="视图切换">
          <button
            v-for="m in MODES"
            :key="m.key"
            role="tab"
            :aria-selected="mode === m.key"
            :class="{ on: mode === m.key }"
            @click="mode = m.key"
          >
            {{ m.label }}
          </button>
        </div>

        <button
          class="icon-btn"
          :title="theme === 'light' ? '切换深色' : '切换浅色'"
          @click="theme = theme === 'light' ? 'dark' : 'light'"
        >
          {{ theme === 'light' ? '☾' : '☀' }}
        </button>
      </div>
    </header>

    <div class="toolbar glass">
      <div class="legend">
        <button
          v-for="c in CATEGORIES"
          :key="c.key"
          class="cat"
          :class="{ on: activeCats.has(c.key) }"
          :style="{ '--c': c.color }"
          :aria-pressed="activeCats.has(c.key)"
          @click="toggleCat(c.key)"
        >
          <i></i>{{ c.label }}
        </button>
      </div>
      <div class="toolbar-right">
        <span class="stat">
          <template v-if="filterActive">命中 <b>{{ hitCount }}</b> / 118</template>
          <template v-else>共 <b>118</b> 种元素</template>
        </span>
        <button class="ghost" @click="randomElement">⚄ 随机</button>
        <button v-if="filterActive" class="ghost" @click="clearFilters">清除筛选</button>
      </div>
    </div>

    <main class="content">
      <PeriodicTable
        v-if="mode === 'grid'"
        :hit="hit"
        :filter-active="filterActive"
        :selected="selected"
        :hovered="hovered"
        @select="select"
        @hover="hovered = $event ? $event.number : null"
        @pick-series="pickSeries"
      />
      <ElementListView
        v-else-if="mode === 'list'"
        :hit="hit"
        :filter-active="filterActive"
        :selected="selected"
        @select="select"
      />
      <TableCube3D
        v-else
        :selected="selected"
        :hit="hit"
        :filter-active="filterActive"
        @open="select"
      />
    </main>

    <p v-if="mode === 'grid'" class="swipe-tip">← 左右滑动查看完整周期表 →</p>

    <footer class="foot">
      <span>数据参考 IUPAC 相对原子质量与常用物性手册 · 部分超重元素为预测值</span>
      <span>Vue 3 · TypeScript · Vite · Three.js</span>
    </footer>
  </div>

  <ElementDetail :element="selectedEl" @close="selected = null" @select="selectByNumber" />
</template>

<style scoped>
.aurora {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}

.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.75;
}

.b1 {
  width: 46vw;
  height: 46vw;
  top: -14vw;
  left: -8vw;
  background: var(--bg-glow-1);
}

.b2 {
  width: 38vw;
  height: 38vw;
  top: 18vh;
  right: -10vw;
  background: var(--bg-glow-2);
}

.b3 {
  width: 30vw;
  height: 30vw;
  bottom: -12vw;
  left: 28vw;
  background: var(--bg-glow-1);
  opacity: 0.45;
}

.shell {
  max-width: 1440px;
  margin: 0 auto;
  padding: 22px clamp(12px, 2.4vw, 32px) 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---------- 顶栏 ---------- */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.brand {
  display: flex;
  align-items: center;
  gap: 13px;
}

.cube-logo {
  position: relative;
  width: 40px;
  height: 40px;
  transform-style: preserve-3d;
  animation: spin 16s linear infinite;
}

.cube-logo .f {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(79, 124, 255, 0.55);
}

.f1 {
  transform: translateZ(20px);
}
.f2 {
  transform: rotateY(90deg) translateZ(20px);
  background: rgba(56, 217, 169, 0.5);
}
.f3 {
  transform: rotateY(180deg) translateZ(20px);
  background: rgba(255, 107, 107, 0.5);
}
.f4 {
  transform: rotateY(-90deg) translateZ(20px);
  background: rgba(177, 151, 252, 0.5);
}
.f5 {
  transform: rotateX(90deg) translateZ(20px);
  background: rgba(255, 212, 59, 0.5);
}
.f6 {
  transform: rotateX(-90deg) translateZ(20px);
  background: rgba(244, 114, 182, 0.5);
}

@keyframes spin {
  from {
    transform: rotateX(-18deg) rotateY(0deg);
  }
  to {
    transform: rotateX(-18deg) rotateY(360deg);
  }
}

.brand-text h1 {
  font-size: clamp(20px, 2.1vw, 26px);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.brand-text p {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
}

.tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 38px;
  min-width: 260px;
  border-radius: 11px;
  border: 1px solid var(--border);
  background: var(--surface-solid);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.search:focus-within {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}

.search-icon {
  font-size: 15px;
  color: var(--text-faint);
}

.search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13.5px;
}

.search input::placeholder {
  color: var(--text-faint);
}

.search input::-webkit-search-cancel-button {
  display: none;
}

.search kbd {
  font-family: ui-monospace, monospace;
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 5px;
  color: var(--text-faint);
  border: 1px solid var(--border);
  background: var(--surface-2);
}

.search.filled kbd {
  display: none;
}

.clear {
  font-size: 11px;
  color: var(--text-faint);
  padding: 2px 4px;
}

.clear:hover {
  color: var(--text);
}

.segment {
  display: flex;
  padding: 3px;
  gap: 2px;
  border-radius: 11px;
  border: 1px solid var(--border);
  background: var(--surface-solid);
}

.segment button {
  padding: 6px 13px;
  font-size: 12.5px;
  border-radius: 8px;
  color: var(--text-dim);
  transition: all 0.18s ease;
  white-space: nowrap;
}

.segment button:hover {
  color: var(--text);
}

.segment button.on {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 40%, transparent);
}

.icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  border: 1px solid var(--border);
  background: var(--surface-solid);
  font-size: 15px;
  color: var(--text-dim);
  transition: all 0.18s ease;
}

.icon-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

/* ---------- 工具条 ---------- */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-radius: 14px;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  font-size: 12px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-dim);
  transition: all 0.18s ease;
}

.cat i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c);
  transition: transform 0.18s ease;
}

.cat:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.cat.on {
  color: color-mix(in srgb, var(--c) 72%, var(--text));
  border-color: color-mix(in srgb, var(--c) 55%, transparent);
  background: color-mix(in srgb, var(--c) 14%, transparent);
}

.cat.on i {
  transform: scale(1.35);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stat {
  font-size: 12.5px;
  color: var(--text-dim);
}

.stat b {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.ghost {
  padding: 6px 11px;
  font-size: 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-dim);
  transition: all 0.18s ease;
}

.ghost:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

/* ---------- 内容 ---------- */
.content {
  min-height: 58vh;
}

.swipe-tip {
  display: none;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-faint);
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 2px 20px;
  font-size: 11.5px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
}

@media (max-width: 980px) {
  .topbar {
    align-items: flex-start;
  }

  .tools {
    width: 100%;
  }

  .search {
    flex: 1 1 200px;
    min-width: 0;
  }

  .swipe-tip {
    display: block;
  }
}

@media (max-width: 620px) {
  .brand-text p {
    display: none;
  }

  .segment button {
    padding: 6px 10px;
    font-size: 12px;
  }

  .search kbd {
    display: none;
  }

  .toolbar {
    padding: 10px 11px;
  }

  .cat {
    padding: 4px 9px;
    font-size: 11.5px;
  }
}
</style>
