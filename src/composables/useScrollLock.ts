import { onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * 锁滚动，同时保证「锁定前后布局完全一致」。
 *
 * 直接写 body.style.overflow = 'hidden' 会让视口滚动条消失，
 * 可视宽度瞬间从 1404px 变成 1414px（本项目滚动条宽 10px）。
 * 周期表是 18 列 `minmax(0, 1fr)` 的栅格，宽度一变 118 个格子全部重新分配 ——
 * 这就是打开元素详情时整页「抖一下」的根因。
 *
 * 做法：把即将消失的滚动条宽度补到 body 的 padding-right 上，
 * 内容盒宽度与基线保持一致，因此不产生任何重排。
 * 对 macOS 这类悬浮滚动条（宽度为 0）不会做补偿，天然无副作用。
 */
let holders = 0
let saved: { overflow: string; paddingRight: string } | null = null

/** 视口滚动条实际占用的宽度（无滚动条 / 悬浮滚动条时为 0） */
function scrollbarWidth(): number {
  return Math.max(0, window.innerWidth - document.documentElement.clientWidth)
}

function acquire() {
  if (holders++ > 0) return
  const body = document.body
  saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight }

  const gap = scrollbarWidth()
  if (gap > 0) {
    // 叠加而非覆盖，避免覆盖页面自身已有的右内边距
    const base = Number.parseFloat(getComputedStyle(body).paddingRight) || 0
    body.style.paddingRight = `${base + gap}px`
  }
  body.style.overflow = 'hidden'
}

function release() {
  if (holders === 0) return
  if (--holders > 0) return

  const body = document.body
  body.style.overflow = saved?.overflow ?? ''
  body.style.paddingRight = saved?.paddingRight ?? ''
  saved = null
}

/** active 为 true 时锁定页面滚动，为 false 或组件卸载时还原 */
export function useScrollLock(active: Ref<boolean>) {
  // 每个实例只持有一次引用，避免重复 lock/unlock 让全局计数错乱
  let held = false

  const take = () => {
    if (held) return
    held = true
    acquire()
  }

  const drop = () => {
    if (!held) return
    held = false
    release()
  }

  watch(active, (v) => (v ? take() : drop()), { immediate: true })
  onBeforeUnmount(drop)
}
