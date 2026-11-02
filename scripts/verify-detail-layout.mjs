/**
 * 元素详情打开/关闭时的布局稳定性探针
 *
 * 用途：量化「打开元素详情时页面抖动」是否被消除，覆盖三件事：
 *   1) 页面级：锁滚动后 118 个格子 / 顶栏 / 周期表容器是否发生位移（根因：滚动条消失）
 *   2) 面板内：3D 组件异步加载时，占位块与真实舞台是否等高、下方内容是否被顶动
 *   3) 滚动锁：打开时页面滚不动且滚动位置不丢，关闭后滚动位置与内联样式都还原
 *
 * 前置：先启动 dev / preview server，再以调试模式打开浏览器：
 *   msedge --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\edge-prof ^
 *          --enable-unsafe-swiftshader --window-size=1440,900 http://127.0.0.1:5173/element-cube/
 * 然后运行：
 *   node scripts/verify-detail-layout.mjs                    # 默认 127.0.0.1:5199
 *   EC_URL=http://127.0.0.1:4173/element-cube/ npm run verify:layout
 *
 * 判定：页面级位移 < 0.5px，3D 占位与舞台高度差 < 1.5px，滚动锁与还原全部通过；
 *       panel.contentJumpPx 只作参考（面板内 3D 组件工具栏出现导致，预取生效时应为 0）。
 */
const CDP = process.env.EC_CDP ?? 'http://127.0.0.1:9222'
const APP_URL = process.env.EC_URL ?? 'http://127.0.0.1:5199/element-cube/'
const TOLERANCE = { page: 0.5, panel: 1.5 }

async function getTarget() {
  const port = new URL(APP_URL).port || '5199'
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${CDP}/json`)).json()
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      // 优先复用已指向目标端口的标签页，其次任意本地页面（随后会 Page.navigate 过去）
      const page =
        pages.find((t) => (t.url ?? '').includes(`:${port}/`)) ??
        pages.find((t) => (t.url ?? '').startsWith('http://127.0.0.1')) ??
        pages.find((t) => (t.url ?? '').startsWith('about:'))
      if (page) return page
    } catch {
      /* 浏览器尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('无法连接调试端口，请先以 --remote-debugging-port=9222 启动浏览器')
}

const target = await getTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
}

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? '页面执行异常')
  }
  return res.result.value
}

/* ---------------- 采样：打开详情 ---------------- */
const measureOpen = `(async () => {
  const $$ = (s) => [...document.querySelectorAll(s)]
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }
  }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // 重置到周期表视图
  const gridTab = $$('.segment button').find((b) => b.textContent.trim() === '周期表')
  gridTab?.click()
  await wait(120)

  const tiles = $$('.tile')
  const probeTiles = [tiles[0], tiles[Math.floor(tiles.length / 2)], tiles[tiles.length - 1]]
  const target = tiles.find((t) => t.title.startsWith('26 ')) ?? tiles[0]

  const before = {
    viewport: { inner: window.innerWidth, client: document.documentElement.clientWidth },
    scrollbar: window.innerWidth - document.documentElement.clientWidth,
    tiles: probeTiles.map(rect),
    topbar: rect(document.querySelector('.topbar')),
    table: rect(document.querySelector('.table')),
    scrollRow: rect(document.querySelector('.table-scroll')),
    panel: rect(document.querySelector('.panel')),
  }

  const shifts = []
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue
      shifts.push({
        value: +e.value.toFixed(4),
        sources: (e.sources ?? []).map((s) => s.node?.className ?? s.node?.nodeName ?? '?'),
      })
    }
  })
  try { po.observe({ type: 'layout-shift' }) } catch {}

  target.click()

  // 逐帧采样 1.2s：跟踪面板内部 3D 舞台高度与信息区位置
  const samples = []
  const t0 = performance.now()
  while (performance.now() - t0 < 1200) {
    await frame()
    const panel = document.querySelector('.panel')
    const body = document.querySelector('.panel .body')
    const stage = document.querySelector('.stage-wrap') || document.querySelector('.atom-loading')
    const facts = document.querySelector('.panel .facts')
    if (panel) {
      samples.push({
        t: Math.round(performance.now() - t0),
        stageH: stage ? +stage.getBoundingClientRect().height.toFixed(1) : null,
        factsY: facts ? +facts.getBoundingClientRect().y.toFixed(1) : null,
        bodyScrollH: body ? body.scrollHeight : null,
        bodyClientW: body ? body.clientWidth : null,
      })
    }
  }
  await wait(120)
  po.disconnect()

  const after = {
    viewport: { inner: window.innerWidth, client: document.documentElement.clientWidth },
    scrollbar: window.innerWidth - document.documentElement.clientWidth,
    tiles: probeTiles.map(rect),
    topbar: rect(document.querySelector('.topbar')),
    table: rect(document.querySelector('.table')),
    scrollRow: rect(document.querySelector('.table-scroll')),
    panel: rect(document.querySelector('.panel')),
  }

  return { before, after, samples, shifts }
})()`

/* ---------------- 采样：关闭详情 ---------------- */
const measureClose = `(async () => {
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const tiles = [...document.querySelectorAll('.tile')]
  const probeTiles = [tiles[0], tiles[Math.floor(tiles.length / 2)], tiles[tiles.length - 1]]
  const before = {
    scrollbar: window.innerWidth - document.documentElement.clientWidth,
    tiles: probeTiles.map(rect),
    topbar: rect(document.querySelector('.topbar')),
    table: rect(document.querySelector('.table')),
  }
  document.querySelector('.panel .close')?.click()
  await wait(900)
  const after = {
    scrollbar: window.innerWidth - document.documentElement.clientWidth,
    tiles: probeTiles.map(rect),
    topbar: rect(document.querySelector('.topbar')),
    table: rect(document.querySelector('.table')),
  }
  return { before, after }
})()`

/* ---------------- 采样：滚动锁定是否保住滚动位置、是否残留内联样式 ---------------- */
const measureScrollLock = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const scrollY = () => Math.round(window.scrollY)

  window.scrollTo(0, 0)
  await wait(120)
  window.scrollTo(0, 420)
  await wait(150)
  const beforeOpen = scrollY()

  const tile = [...document.querySelectorAll('.tile')].find((t) => t.title.startsWith('26 '))
  tile?.click()
  await wait(700)

  const locked = {
    scrollY: scrollY(),
    bodyOverflow: getComputedStyle(document.body).overflow,
    bodyPaddingRight: getComputedStyle(document.body).paddingRight,
  }
  // 锁定期间拖不动页面
  window.scrollBy(0, 300)
  await wait(120)
  const afterWheelLocked = scrollY()

  document.querySelector('.panel .close')?.click()
  await wait(800)

  const unlocked = {
    scrollY: scrollY(),
    bodyOverflow: getComputedStyle(document.body).overflow,
    bodyPaddingRight: getComputedStyle(document.body).paddingRight,
    bodyInlineStyle: document.body.getAttribute('style') ?? '',
  }
  window.scrollTo(0, 0)
  return { beforeOpen, locked, afterWheelLocked, unlocked }
})()`

const delta = (a, b, key) => (a && b ? Math.abs(b[key] - a[key]) : null)

const contentJump = (open) => {
  const ys = open.samples.map((s) => s.factsY).filter((v) => v != null)
  return ys.length ? +(Math.max(...ys) - Math.min(...ys)).toFixed(1) : null
}

const stageRange = (open) => {
  const hs = open.samples.map((s) => s.stageH).filter((v) => v != null)
  return hs.length ? +(Math.max(...hs) - Math.min(...hs)).toFixed(1) : null
}

function pageShiftsOf(open, close) {
  const rows = []
  for (const key of ['topbar', 'table', 'scrollRow']) {
    rows.push({
      key,
      openX: delta(open.before[key], open.after[key], 'x'),
      openY: delta(open.before[key], open.after[key], 'y'),
      closeX: delta(close.before[key], close.after[key], 'x'),
      closeY: delta(close.before[key], close.after[key], 'y'),
    })
  }
  open.before.tiles.forEach((t, i) => {
    rows.push({
      key: `tile#${i}`,
      openX: delta(t, open.after.tiles[i], 'x'),
      openY: delta(t, open.after.tiles[i], 'y'),
      closeX: delta(close.before.tiles[i], close.after.tiles[i], 'x'),
      closeY: delta(close.before.tiles[i], close.after.tiles[i], 'y'),
    })
  })
  return rows
}

/**
 * @param cold 首轮（3D chunk 尚未预取完，代表「首屏后立刻点开」的最坏情况）
 * @param warm 次轮（chunk 已在内存中，代表正常浏览时的稳定状态 → 作为严格判定基准）
 */
function summarize(cold, warm) {
  const rows = [...pageShiftsOf(cold.open, cold.close), ...pageShiftsOf(warm.open, warm.close)]
  const allX = rows.map((r) => r.openX ?? 0).concat(rows.map((r) => r.closeX ?? 0))
  const allY = rows.map((r) => r.openY ?? 0).concat(rows.map((r) => r.closeY ?? 0))

  return {
    page: {
      scrollbarBefore: cold.open.before.scrollbar,
      scrollbarAfter: cold.open.after.scrollbar,
      scrollbarAfterClose: cold.close.after.scrollbar,
      maxShiftX: Math.max(...allX),
      maxShiftY: Math.max(...allY),
      details: rows,
    },
    panel: {
      stageHeightRange: Math.max(stageRange(cold.open) ?? 0, stageRange(warm.open) ?? 0),
      coldJumpPx: contentJump(cold.open),
      warmJumpPx: contentJump(warm.open),
      samples: warm.open.samples.filter((_, i) => i % 6 === 0),
    },
    layoutShiftEntries: [...cold.open.shifts, ...warm.open.shifts],
    passes: {
      pageStable: null,
      stageStable: null,
      warmContentStable: null,
    },
  }
}

await send('Runtime.enable')

// 每次都整页重载：避免 HMR 残留状态或上一轮遗留的打开面板影响基线
await send('Page.enable')
await send('Page.navigate', { url: APP_URL })
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250))
  const ready = await evaluate('document.querySelectorAll(".tile").length > 0')
  if (ready) break
}
await evaluate('new Promise(r => setTimeout(r, 500))')

const cold = { open: await evaluate(measureOpen), close: null }
cold.close = await evaluate(measureClose)
const scrollLock = await evaluate(measureScrollLock)
// 第二轮：chunk 已在内存中，代表正常浏览时的稳定状态
const warm = { open: await evaluate(measureOpen), close: null }
warm.close = await evaluate(measureClose)

const report = summarize(cold, warm)
report.scrollLock = scrollLock
report.passes.pageStable = report.page.maxShiftX < TOLERANCE.page && report.page.maxShiftY < TOLERANCE.page
report.passes.stageStable = report.panel.stageHeightRange < TOLERANCE.panel
report.passes.warmContentStable =
  report.panel.warmJumpPx == null || report.panel.warmJumpPx < TOLERANCE.panel
report.passes.scrollLocked =
  scrollLock.locked.bodyOverflow === 'hidden' &&
  scrollLock.locked.scrollY === scrollLock.beforeOpen &&
  scrollLock.afterWheelLocked === scrollLock.beforeOpen
report.passes.scrollRestored =
  scrollLock.unlocked.scrollY === scrollLock.beforeOpen &&
  scrollLock.unlocked.bodyOverflow !== 'hidden' &&
  scrollLock.unlocked.bodyPaddingRight === '0px'

console.log(JSON.stringify(report, null, 2))
console.log(
  `\n${report.passes.pageStable ? 'PASS' : 'FAIL'} 页面级位移: X ${report.page.maxShiftX}px / Y ${report.page.maxShiftY}px (容差 ${TOLERANCE.page}px)`,
)
console.log(
  `${report.passes.stageStable ? 'PASS' : 'FAIL'} 3D 占位与舞台等高: 高度变化 ${report.panel.stageHeightRange}px (容差 ${TOLERANCE.panel}px)`,
)
console.log(
  `${report.passes.warmContentStable ? 'PASS' : 'FAIL'} 面板内内容位移（热 chunk）: ${report.panel.warmJumpPx}px (容差 ${TOLERANCE.panel}px)`,
)
console.log(
  `INFO 面板内内容位移（首轮冷 chunk）: ${report.panel.coldJumpPx}px — 仅当 chunk 未预取完就点开时出现，来自 3D 组件工具栏/图例本身的高度`,
)
console.log(
  `${report.passes.scrollLocked ? 'PASS' : 'FAIL'} 锁滚动: 打开后 overflow=${scrollLock.locked.bodyOverflow}, scrollY ${scrollLock.beforeOpen}→${scrollLock.locked.scrollY}（滚动无效 ${scrollLock.afterWheelLocked}）`,
)
console.log(
  `${report.passes.scrollRestored ? 'PASS' : 'FAIL'} 解锁还原: scrollY ${scrollLock.unlocked.scrollY} (期望 ${scrollLock.beforeOpen}), paddingRight=${scrollLock.unlocked.bodyPaddingRight}`,
)
console.log(`滚动条宽度：打开前 ${report.page.scrollbarBefore}px → 打开后 ${report.page.scrollbarAfter}px → 关闭后 ${report.page.scrollbarAfterClose}px`)

ws.close()
process.exit(
  report.passes.pageStable &&
    report.passes.stageStable &&
    report.passes.warmContentStable &&
    report.passes.scrollLocked &&
    report.passes.scrollRestored
    ? 0
    : 1,
)
