import { computed, ref, type Ref } from 'vue'
import { CATEGORY_MAP, ELEMENTS, type CategoryKey, type ElementInfo } from '../data/elements'

export function useElementFilter(query: Ref<string>, activeCats: Ref<Set<CategoryKey>>) {
  const q = computed(() => query.value.trim().toLowerCase())

  const matched = computed<Set<number>>(() => {
    const set = new Set<number>()
    const key = q.value
    if (!key) return set
    for (const el of ELEMENTS) {
      const catLabel = CATEGORY_MAP[el.category].label
      if (
        el.symbol.toLowerCase() === key ||
        el.symbol.toLowerCase().startsWith(key) ||
        el.enName.toLowerCase().includes(key) ||
        el.name.includes(key) ||
        catLabel.includes(key) ||
        String(el.number) === key ||
        (key.length >= 2 && String(el.number).startsWith(key))
      ) {
        set.add(el.number)
      }
    }
    return set
  })

  const filterActive = computed(() => q.value.length > 0 || activeCats.value.size > 0)

  /** 元素是否通过全部筛选条件 */
  function passes(el: ElementInfo): boolean {
    if (q.value && !matched.value.has(el.number)) return false
    if (activeCats.value.size > 0 && !activeCats.value.has(el.category)) return false
    return true
  }

  /** 命中的元素（用于高亮） */
  const hit = computed<Set<number>>(() => {
    if (!filterActive.value) return new Set<number>()
    const set = new Set<number>()
    for (const el of ELEMENTS) if (passes(el)) set.add(el.number)
    return set
  })

  const hitCount = computed(() => hit.value.size)

  return { matched, hit, hitCount, filterActive, passes }
}

export function useRecent() {
  const recent = ref<number[]>([])
  function push(n: number) {
    recent.value = [n, ...recent.value.filter((x) => x !== n)].slice(0, 12)
  }
  return { recent, push }
}
