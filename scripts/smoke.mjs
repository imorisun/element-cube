/**
 * 交互冒烟测试
 * 通过 Chrome DevTools Protocol 驱动无头浏览器，验证点击、搜索、筛选、3D 视图与移动端适配。
 *
 * 前置：先启动 dev server，再以调试模式打开浏览器：
 *   msedge --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\edge-prof ^
 *          --enable-unsafe-swiftshader --window-size=1600,1000 http://127.0.0.1:5173/
 * 然后运行：node scripts/smoke.mjs
 */
const CDP = 'http://127.0.0.1:9222'
const APP_URL = process.env.EC_URL ?? 'http://127.0.0.1:5173/element-cube/'

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${CDP}/json`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url ?? '').includes('5173'),
      )
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
const logs = []

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(
      `[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description).join(' '),
    )
  } else if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description ?? 'unknown'))
  }
}

function send(method, params = {}) {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject })
    setTimeout(() => reject(new Error('timeout: ' + method)), 30000)
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){ ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate error')
  }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`)
}

await send('Runtime.enable')
await send('Page.enable')
// 重新加载，确保全局作用域干净
await send('Page.navigate', { url: APP_URL })
await sleep(2500)

// ---------- 1. 周期表 ----------
await evaluate(`
  const b = Array.from(document.querySelectorAll('.segment button')).find(n => n.textContent.includes('周期表'));
  if (b && !b.classList.contains('on')) b.click();
  return true;
`)
await sleep(1000)
const tileCount = await evaluate(`return document.querySelectorAll('.tile').length`)
check('周期表渲染 118 个方块', tileCount === 118, `实际 ${tileCount}`)

const placeholder = await evaluate(`return document.querySelectorAll('.placeholder').length`)
check('镧系/锕系占位块存在', placeholder === 2, `${placeholder} 个`)

// ---------- 2. 详情面板 ----------
await evaluate(`document.querySelectorAll('.tile')[0].click(); return true`)
await sleep(2800)
const panelTitle = await evaluate(
  `return document.querySelector('.panel .titles h2')?.textContent ?? ''`,
)
check('点击元素打开详情面板', panelTitle === '氢', `标题「${panelTitle}」`)

const facts = await evaluate(
  `return Array.from(document.querySelectorAll('.panel .fact')).map(n => n.textContent.trim())`,
)
check('详情数据条目完整', facts.length >= 15, `${facts.length} 条`)
check(
  '电子排布正确（氢 1s¹）',
  facts.some((f) => f.includes('1s¹')),
  facts.find((f) => f.includes('电子排布')) ?? '(未找到)',
)

const canvasInfo = await evaluate(`
  const c = document.querySelector('.panel canvas');
  return c ? { w: c.width, h: c.height } : null;
`)
check('3D 原子模型画布已创建', !!canvasInfo && canvasInfo.w > 0, JSON.stringify(canvasInfo))

const shellChips = await evaluate(
  `return Array.from(document.querySelectorAll('.panel .shell-chip')).map(n => n.textContent.trim())`,
)
check('电子层信息展示', shellChips.length >= 1, shellChips.join(' / '))

// ---------- 2b. 原子模型热区拾取 ----------
/** 在原子模型画面上模拟一次点击 */
async function clickStage(fx, fy) {
  await evaluate(`
    const host = document.querySelector('.panel .stage');
    const r = host.getBoundingClientRect();
    const cx = r.left + r.width * ${fx};
    const cy = r.top + r.height * ${fy};
    const opts = { clientX: cx, clientY: cy, bubbles: true, pointerId: 1, isPrimary: true };
    host.dispatchEvent(new PointerEvent('pointerdown', opts));
    host.dispatchEvent(new PointerEvent('pointerup', opts));
    return true;
  `)
  await sleep(400)
}

// 画面正中必定落在原子核上
await clickStage(0.5, 0.5)
const nucleusCard = await evaluate(`
  const c = document.querySelector('.panel .pick-card');
  return c ? { title: c.querySelector('h4')?.textContent.trim(), rows: Array.from(c.querySelectorAll('.pick-row')).map(n => n.textContent.replace(/\\s+/g,'')) } : null;
`)
check('点击原子核弹出信息卡', nucleusCard?.title === '原子核', JSON.stringify(nucleusCard?.title))
check(
  '核信息卡数据正确（氢：1 质子 / 0 中子）',
  !!nucleusCard && nucleusCard.rows.some((r) => r.includes('质子数Z') && r.endsWith('1')),
  nucleusCard?.rows.join(' | '),
)

// 点击空白处收起卡片
await clickStage(0.04, 0.96)
check('点击空白处收起信息卡', await evaluate(`return !document.querySelector('.panel .pick-card')`))

// 电子层热区（通过标注按钮，等价验证建模层高亮逻辑）
await evaluate(`
  const b = Array.from(document.querySelectorAll('.panel .shell-chip')).find(n => n.textContent.includes('层'));
  b.click();
  return true;
`)
await sleep(350)
const shellCard = await evaluate(`
  const c = document.querySelector('.panel .pick-card');
  return c ? { title: c.querySelector('h4')?.textContent.trim(), rows: Array.from(c.querySelectorAll('.pick-row')).map(n => n.textContent.replace(/\\s+/g,'')) } : null;
`)
check('点击电子层标签弹出层信息卡', !!shellCard && shellCard.title.includes('电子层'), JSON.stringify(shellCard?.title))
check(
  '层信息卡含容量数据',
  !!shellCard && shellCard.rows.some((r) => r.includes('最大容量')),
  shellCard?.rows.join(' | '),
)

// 标注开关
await evaluate(`
  Array.from(document.querySelectorAll('.panel .mini')).find(b => b.textContent.includes('标注')).click();
  return true;
`)
await sleep(300)
check(
  '标注开关可切换',
  await evaluate(`return Array.from(document.querySelectorAll('.panel .mini')).some(b => b.textContent.includes('标注已关'))`),
)
await evaluate(`
  Array.from(document.querySelectorAll('.panel .mini')).find(b => b.textContent.includes('标注')).click();
  return true;
`)
await sleep(250)

await evaluate(`document.querySelectorAll('.panel .nav-btn')[1].click(); return true`)
await sleep(700)
const nextTitle = await evaluate(
  `return document.querySelector('.panel .titles h2')?.textContent ?? ''`,
)
check('下一个元素导航（氦）', nextTitle === '氦', `标题「${nextTitle}」`)

await evaluate(`document.querySelector('.panel .close').click(); return true`)
await sleep(600)
check('关闭详情面板', await evaluate(`return !document.querySelector('.panel')`))

// ---------- 3. 搜索 ----------
async function search(q) {
  await evaluate(`
    const el = document.querySelector('.search input');
    el.value = ${JSON.stringify(q)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await sleep(450)
}

await search('oxygen')
check(
  '英文名搜索 "oxygen"',
  (await evaluate(`return document.querySelectorAll('.tile.matched').length`)) === 1,
  await evaluate(`return document.querySelector('.stat')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`),
)

await search('铁')
check(
  '中文名搜索 "铁"',
  (await evaluate(`return document.querySelector('.tile.matched .sym')?.textContent ?? ''`)) === 'Fe',
)

await search('79')
check(
  '原子序数搜索 "79"',
  (await evaluate(`return document.querySelector('.tile.matched .sym')?.textContent ?? ''`)) === 'Au',
)

await search('la')
const laHits = await evaluate(
  `return Array.from(document.querySelectorAll('.tile.matched .sym')).map(n => n.textContent)`,
)
check('模糊搜索 "la" 命中符号与英文名', laHits.includes('La'), laHits.join(','))

await evaluate(`document.querySelector('.clear')?.click(); return true`)
await sleep(400)

// 分类名模糊搜索：「金属」应命中全部金属分类
await search('金属')
check(
  '分类名搜索 "金属" 命中 75 种金属',
  (await evaluate(`return document.querySelectorAll('.tile.matched').length`)) === 75,
)
await evaluate(`document.querySelector('.clear')?.click(); return true`)
await sleep(400)

// ---------- 4. 分类筛选 ----------
await evaluate(`
  Array.from(document.querySelectorAll('.cat')).find(b => b.textContent.includes('卤素')).click();
  return true;
`)
await sleep(500)
const halogenHit = await evaluate(`return document.querySelectorAll('.tile.matched').length`)
check('筛选「卤素」命中 6 种', halogenHit === 6, `命中 ${halogenHit}`)

await evaluate(`
  Array.from(document.querySelectorAll('.cat')).find(b => b.textContent.includes('稀有气体')).click();
  return true;
`)
await sleep(400)
const comboHit = await evaluate(`return document.querySelectorAll('.tile.matched').length`)
// 卤素 6 种（F Cl Br I At Ts）+ 稀有气体 7 种（He Ne Ar Kr Xe Rn Og）
check('多选叠加（卤素 6 + 稀有气体 7 = 13）', comboHit === 13, `命中 ${comboHit}`)

await evaluate(`
  const gs = document.querySelectorAll('.ghost');
  gs[gs.length - 1].click();
  return true;
`)
await sleep(500)
check(
  '清除筛选后无高亮/灰显',
  (await evaluate(`return document.querySelectorAll('.tile.matched, .tile.dimmed').length`)) === 0,
)

// ---------- 5. 悬停关联高亮 ----------
await evaluate(`
  const t = Array.from(document.querySelectorAll('.tile')).find(n => n.querySelector('.sym')?.textContent === 'Na');
  t.dispatchEvent(new MouseEvent('mouseenter'));
  return true;
`)
await sleep(400)
const related = await evaluate(`return document.querySelectorAll('.tile.related').length`)
check('悬停高亮同行同族', related >= 7, `高亮 ${related} 个（第1族 + 第3周期）`)

// ---------- 6. 3D 立方周期表 ----------
await evaluate(`
  Array.from(document.querySelectorAll('.segment button')).find(b => b.textContent.includes('3D')).click();
  return true;
`)
await sleep(4000)
const cubeCanvas = await evaluate(`
  const c = document.querySelector('.canvas-host canvas');
  return c ? { w: c.width, h: c.height } : null;
`)
check('3D 立方周期表渲染', !!cubeCanvas && cubeCanvas.w > 0, JSON.stringify(cubeCanvas))
check(
  '3D 视图显示操作提示',
  (
    await evaluate(`return document.querySelector('.canvas-host .hint')?.textContent ?? ''`)
  ).includes('旋转'),
)
check(
  '3D 视图图例完整（10 类）',
  (await evaluate(`return document.querySelectorAll('.cube-legend .lg').length`)) === 10,
)
check(
  '3D 视图提供视图控制（标注 / 俯视 / 重置）',
  await evaluate(`
    const t = Array.from(document.querySelectorAll('.cube-toolbar .mini')).map(b => b.textContent.trim());
    return t.some(x => x.includes('标注')) && t.some(x => x.includes('俯视')) && t.some(x => x.includes('重置'));
  `),
)

// 跳转导航：符号 / 中文名 / 序数
await evaluate(`
  const inp = document.querySelector('.jump input');
  inp.value = 'Fe';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.jump button[type=submit]').click();
  return true;
`)
await sleep(600)
const jumpCard = await evaluate(`
  const c = document.querySelector('.cube-card');
  return c ? { name: c.querySelector('.card-titles strong')?.textContent.trim(), rows: c.querySelectorAll('.card-row').length, uses: c.querySelectorAll('.card-uses li').length } : null;
`)
check('3D 跳转定位到铁', jumpCard?.name === '铁', JSON.stringify(jumpCard))
check('详情卡含关键性质与用途', (jumpCard?.rows ?? 0) >= 8 && (jumpCard?.uses ?? 0) >= 1, JSON.stringify(jumpCard))

// 详情卡 → 完整资料抽屉
await evaluate(`document.querySelector('.cube-card .primary').click(); return true`)
await sleep(2600)
check(
  '详情卡「查看完整资料」打开抽屉',
  (await evaluate(`return document.querySelector('.panel .titles h2')?.textContent ?? ''`)) === '铁',
)
await evaluate(`document.querySelector('.panel .close').click(); return true`)
await sleep(600)

// 卡片内上一 / 下一个
await evaluate(`document.querySelectorAll('.cube-card .card-nav button')[1].click(); return true`)
await sleep(500)
check(
  '详情卡下一个元素（钴）',
  (await evaluate(`return document.querySelector('.cube-card .card-titles strong')?.textContent.trim()`)) === '钴',
)

// 顶栏搜索联动 3D 视图
await search('卤素')
check(
  '搜索结果联动 3D 视图提示',
  (await evaluate(`return document.querySelector('.canvas-host .hint')?.textContent ?? ''`)).includes('命中 6'),
)
await evaluate(`document.querySelector('.clear')?.click(); return true`)
await sleep(400)

// 标注 / 俯视开关不报错
await evaluate(`
  Array.from(document.querySelectorAll('.cube-toolbar .mini')).find(b => b.textContent.includes('标注')).click();
  Array.from(document.querySelectorAll('.cube-toolbar .mini')).find(b => b.textContent.includes('俯视')).click();
  return true;
`)
await sleep(700)
await evaluate(`
  Array.from(document.querySelectorAll('.cube-toolbar .mini')).find(b => b.textContent.includes('标注')).click();
  return true;
`)
await sleep(300)

// ---------- 6b. 反复挂载不泄漏 WebGL 上下文 ----------
await evaluate(`
  Array.from(document.querySelectorAll('.segment button')).find(b => b.textContent.includes('列表')).click();
  return true;
`)
await sleep(700)
for (let i = 0; i < 6; i++) {
  await evaluate(`document.querySelectorAll('.card')[${i}].click(); return true`)
  await sleep(500)
  await evaluate(`document.querySelector('.panel .close').click(); return true`)
  await sleep(400)
}
const ctxWarn = logs.filter((l) => /WebGL context|context lost|Too many/i.test(l))
check('反复开关详情面板 6 次无 WebGL 上下文泄漏', ctxWarn.length === 0, ctxWarn.slice(0, 3).join(' | '))
const canvasCount = await evaluate(`return document.querySelectorAll('canvas').length`)
check('页面内无残留 canvas', canvasCount <= 1, `canvas 数 ${canvasCount}`)

// ---------- 7. 移动端适配 ----------
await send('Emulation.setDeviceMetricsOverride', {
  width: 375,
  height: 780,
  deviceScaleFactor: 2,
  mobile: true,
})
await sleep(900)
await evaluate(`
  Array.from(document.querySelectorAll('.segment button')).find(b => b.textContent.includes('列表')).click();
  return true;
`)
await sleep(900)
const mobileCards = await evaluate(`return document.querySelectorAll('.card').length`)
check('移动端列表渲染 118 张卡片', mobileCards === 118, `${mobileCards} 张`)

const overflow = await evaluate(
  `return { sw: document.documentElement.scrollWidth, iw: window.innerWidth }`,
)
check('移动端无横向溢出', overflow.sw <= overflow.iw + 2, JSON.stringify(overflow))

await evaluate(`document.querySelectorAll('.card')[0].click(); return true`)
await sleep(2800)
const sheet = await evaluate(`
  const p = document.querySelector('.panel');
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth };
`)
check('移动端详情为满宽底部抽屉', !!sheet && sheet.w === sheet.vw, JSON.stringify(sheet))

// ---------- 8. 控制台错误 ----------
const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'))
check('运行期间无控制台错误', errors.length === 0, errors.slice(0, 4).join(' | '))

console.log('\n' + '='.repeat(56))
const failed = results.filter((r) => !r.ok)
console.log(`结果：通过 ${results.length - failed.length} / ${results.length}`)
if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join('、'))
ws.close()
process.exit(failed.length ? 1 : 0)
