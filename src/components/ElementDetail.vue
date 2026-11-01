<script setup lang="ts">
import { computed, defineAsyncComponent, h, onBeforeUnmount, ref, watch } from 'vue'

/** three.js 体积较大，3D 模型按需异步加载，避免拖慢首屏 */
const AtomModel3D = defineAsyncComponent({
  loader: () => import('./AtomModel3D.vue'),
  loadingComponent: {
    render: () =>
      h('div', { class: 'atom-loading' }, [
        h('span', { class: 'atom-spinner' }),
        '正在加载 3D 模型…',
      ]),
  },
  delay: 100,
})
import {
  CATEGORY_MAP,
  ELEMENT_BY_NUMBER,
  PHASE_LABEL,
  formatConfig,
  massNumber,
  type ElementInfo,
} from '../data/elements'

const props = defineProps<{
  element: ElementInfo | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', n: number): void
}>()

const bodyEl = ref<HTMLElement | null>(null)

const meta = computed(() => (props.element ? CATEGORY_MAP[props.element.category] : null))

const neighbors = computed(() => {
  const n = props.element?.number
  if (!n) return { prev: null, next: null }
  return {
    prev: ELEMENT_BY_NUMBER[n - 1] ?? null,
    next: ELEMENT_BY_NUMBER[n + 1] ?? null,
  }
})

function kToC(k: number | null): string {
  if (k == null) return '—'
  return (k - 273.15).toFixed(Math.abs(k) < 100 ? 2 : 0)
}

function fmt(v: number | null, digits = 2, suffix = ''): string {
  if (v == null) return '—'
  return `${Number(v.toFixed(digits))}${suffix}`
}

/** 气体密度用 g/L 显示更直观 */
function densityText(el: ElementInfo): string {
  if (el.density == null) return '—'
  if (el.phase === 'gas') return `${(el.density * 1000).toFixed(3)} g/L`
  return `${Number(el.density.toFixed(3))} g/cm³`
}

const facts = computed(() => {
  const el = props.element
  if (!el) return []
  return [
    { k: '原子序数', v: String(el.number) },
    { k: '相对原子质量', v: String(el.mass) },
    { k: '质量数（常见同位素）', v: String(massNumber(el)) },
    { k: '分类', v: meta.value?.label ?? '—' },
    { k: '周期 / 族', v: `${el.period} / ${el.group ?? '—（镧锕系）'}` },
    { k: '区块', v: `${el.block} 区` },
    { k: '常温状态', v: PHASE_LABEL[el.phase] },
    { k: '电子排布', v: formatConfig(el.electronConfig), mono: true },
  ]
})

const physical = computed(() => {
  const el = props.element
  if (!el) return []
  return [
    { k: '熔点', v: el.melting == null ? '—' : `${el.melting} K（${kToC(el.melting)} ℃）` },
    { k: '沸点', v: el.boiling == null ? '—' : `${el.boiling} K（${kToC(el.boiling)} ℃）` },
    { k: '密度', v: densityText(el) },
  ]
})

const chemical = computed(() => {
  const el = props.element
  if (!el) return []
  return [
    { k: '电负性（鲍林）', v: el.electronegativity == null ? '—' : String(el.electronegativity) },
    { k: '第一电离能', v: fmt(el.ionization, 3, ' eV') },
    { k: '原子半径', v: fmt(el.radius, 0, ' pm') },
    { k: '电子层数', v: String(el.shells.length) },
  ]
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  if (!props.element) return
  if (e.key === 'ArrowLeft' && neighbors.value.prev) emit('select', neighbors.value.prev.number)
  if (e.key === 'ArrowRight' && neighbors.value.next) emit('select', neighbors.value.next.number)
}

watch(
  () => props.element?.number,
  () => {
    bodyEl.value?.scrollTo({ top: 0, behavior: 'smooth' })
  },
)

const open = computed(() => !!props.element)

watch(open, (v) => {
  if (v) {
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
  } else {
    document.removeEventListener('keydown', onKey)
    document.body.style.overflow = ''
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Transition name="fade">
    <div v-if="open && element" class="backdrop" @click.self="emit('close')"></div>
  </Transition>

  <Transition name="slide">
    <aside
      v-if="open && element"
      class="panel glass"
      role="dialog"
      aria-modal="true"
      :aria-label="`${element.name} 详细信息`"
      :style="{ '--c': meta?.color }"
    >
      <button class="close" aria-label="关闭详情" @click="emit('close')">✕</button>

      <header class="head">
        <div class="badge">
          <span class="badge-num">{{ element.number }}</span>
          <span class="badge-sym">{{ element.symbol }}</span>
          <span class="badge-mass">{{ element.mass }}</span>
        </div>
        <div class="titles">
          <h2>{{ element.name }}</h2>
          <p class="en">{{ element.enName }}</p>
          <div class="chips">
            <span class="chip cat">{{ meta?.label }}</span>
            <span class="chip">{{ element.period }} 周期</span>
            <span class="chip" v-if="element.group">{{ element.group }} 族</span>
            <span class="chip">{{ element.block }} 区</span>
            <span class="chip" v-if="element.synthetic">人工合成</span>
          </div>
        </div>
      </header>

      <div ref="bodyEl" class="body">
        <section class="block">
          <h3>原子结构 · 3D 模型</h3>
          <AtomModel3D :element="element" :color="meta?.color ?? '#4f7cff'" />
        </section>

        <section class="block">
          <h3>基本信息</h3>
          <dl class="facts">
            <div v-for="f in facts" :key="f.k" class="fact">
              <dt>{{ f.k }}</dt>
              <dd :class="{ mono: f.mono }">{{ f.v }}</dd>
            </div>
          </dl>
          <div class="shell-row">
            <span class="shell-label">各层电子数</span>
            <span v-for="(c, i) in element.shells" :key="i" class="shell-pill">{{ c }}</span>
          </div>
        </section>

        <section class="block two-col">
          <div>
            <h3>物理性质</h3>
            <dl class="facts">
              <div v-for="f in physical" :key="f.k" class="fact">
                <dt>{{ f.k }}</dt>
                <dd>{{ f.v }}</dd>
              </div>
            </dl>
          </div>
          <div>
            <h3>化学性质</h3>
            <dl class="facts">
              <div v-for="f in chemical" :key="f.k" class="fact">
                <dt>{{ f.k }}</dt>
                <dd>{{ f.v }}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section class="block">
          <h3>发现历史</h3>
          <dl class="facts">
            <div class="fact">
              <dt>发现年份</dt>
              <dd>{{ element.discovered }}</dd>
            </div>
            <div class="fact">
              <dt>发现者</dt>
              <dd>{{ element.discoverer }}</dd>
            </div>
          </dl>
        </section>

        <section class="block">
          <h3>简介</h3>
          <p class="prose">{{ element.summary }}</p>
        </section>

        <section class="block">
          <h3>主要用途</h3>
          <ul class="uses">
            <li v-for="u in element.uses" :key="u">{{ u }}</li>
          </ul>
        </section>
      </div>

      <footer class="nav">
        <button
          class="nav-btn"
          :disabled="!neighbors.prev"
          @click="neighbors.prev && emit('select', neighbors.prev.number)"
        >
          ← {{ neighbors.prev ? `${neighbors.prev.number} ${neighbors.prev.name}` : '已是首个' }}
        </button>
        <button
          class="nav-btn"
          :disabled="!neighbors.next"
          @click="neighbors.next && emit('select', neighbors.next.number)"
        >
          {{ neighbors.next ? `${neighbors.next.number} ${neighbors.next.name}` : '已是最后' }} →
        </button>
      </footer>
    </aside>
  </Transition>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(6, 10, 20, 0.5);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

.panel {
  position: fixed;
  z-index: 41;
  top: 0;
  right: 0;
  height: 100dvh;
  width: min(560px, 100vw);
  display: flex;
  flex-direction: column;
  background: var(--surface-solid);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
}

.close {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 2;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 14px;
  color: var(--text-dim);
  background: var(--surface-2);
  border: 1px solid var(--border);
  transition: all 0.18s ease;
}

.close:hover {
  color: var(--text);
  border-color: var(--border-strong);
  transform: rotate(90deg);
}

.head {
  position: relative;
  display: flex;
  gap: 16px;
  padding: 22px 60px 18px 22px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(
    120deg,
    color-mix(in srgb, var(--c) 16%, transparent),
    transparent 70%
  );
}

.badge {
  flex: 0 0 auto;
  width: 92px;
  height: 92px;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--c) 26%, var(--surface-solid)),
    var(--surface-solid)
  );
  box-shadow: 0 8px 20px color-mix(in srgb, var(--c) 26%, transparent);
}

.badge-num {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.badge-sym {
  font-size: 34px;
  font-weight: 700;
  line-height: 1;
  color: color-mix(in srgb, var(--c) 65%, var(--text));
}

.badge-mass {
  font-size: 10.5px;
  color: var(--text-faint);
}

.titles {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  min-width: 0;
}

.titles h2 {
  font-size: 27px;
  line-height: 1.15;
  letter-spacing: -0.01em;
}

.en {
  font-size: 13.5px;
  color: var(--text-dim);
  letter-spacing: 0.02em;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.chip {
  padding: 3px 9px;
  font-size: 11.5px;
  border-radius: 99px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  background: var(--surface-2);
}

.chip.cat {
  color: color-mix(in srgb, var(--c) 75%, var(--text));
  border-color: color-mix(in srgb, var(--c) 45%, transparent);
  background: color-mix(in srgb, var(--c) 12%, transparent);
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px 26px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.block h3 {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: 10px;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
}

.fact {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px dashed var(--border);
}

.fact:last-child {
  border-bottom: none;
}

.fact dt {
  font-size: 12.5px;
  color: var(--text-dim);
  white-space: nowrap;
}

.fact dd {
  margin: 0;
  font-size: 13px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.fact dd.mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px;
}

.shell-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.shell-label {
  font-size: 12.5px;
  color: var(--text-dim);
  margin-right: 4px;
}

.shell-pill {
  min-width: 26px;
  text-align: center;
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--c) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--c) 30%, transparent);
  color: color-mix(in srgb, var(--c) 55%, var(--text));
}

.prose {
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--text-dim);
}

.uses {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.uses li {
  position: relative;
  padding-left: 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-dim);
}

.uses li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 8px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--c);
}

.nav {
  display: flex;
  gap: 10px;
  padding: 12px 22px;
  border-top: 1px solid var(--border);
  background: var(--surface-solid);
}

.nav-btn {
  flex: 1;
  padding: 9px 10px;
  font-size: 12.5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-dim);
  transition: all 0.18s ease;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
}

.nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.28s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-enter-active,
.slide-leave-active {
  transition: transform 0.34s cubic-bezier(0.22, 0.9, 0.28, 1), opacity 0.28s ease;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
  opacity: 0.4;
}

@media (max-width: 700px) {
  .panel {
    top: auto;
    bottom: 0;
    width: 100vw;
    height: 90dvh;
    border-left: none;
    border-top: 1px solid var(--border);
    border-radius: 22px 22px 0 0;
  }

  .slide-enter-from,
  .slide-leave-to {
    transform: translateY(100%);
  }

  .head {
    padding: 20px 56px 16px 18px;
  }

  .badge {
    width: 74px;
    height: 74px;
  }

  .badge-sym {
    font-size: 27px;
  }

  .titles h2 {
    font-size: 23px;
  }

  .two-col {
    grid-template-columns: 1fr;
    gap: 18px;
  }

  .body {
    padding: 16px 18px 24px;
  }

  .nav {
    padding: 10px 18px calc(10px + env(safe-area-inset-bottom));
  }
}
</style>
