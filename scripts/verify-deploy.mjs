/**
 * 子路径部署运行时验证
 * 验证 dist 产物挂在 /element-cube/ 下能正常渲染、无 404、无控制台报错、3D 可用。
 *
 * 前置：
 *   npx vite build
 *   npx vite preview --port 4173 --host 127.0.0.1
 *   msedge.exe --headless=new --remote-debugging-port=9333 \
 *     --enable-unsafe-swiftshader http://127.0.0.1:4173/element-cube/
 * 运行：EC_URL=http://127.0.0.1:4173/element-cube/ node scripts/verify-deploy.mjs
 */
const BASE_URL = process.env.EC_URL ?? 'http://127.0.0.1:4173/element-cube/'
const CDP_PORT = process.env.EC_CDP ?? '9333'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
const page = list.find((t) => t.type === 'page' && (t.url ?? '').includes('4173'))
if (!page) {
  console.error(`未找到目标页面，请先启动调试浏览器打开 ${BASE_URL}`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const d = JSON.parse(e.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
  if (d.method === 'Network.responseReceived') {
    responses.push({ url: d.params.response.url, status: d.params.response.status })
  }
  if (d.method === 'Network.loadingFailed') {
    failures.push(d.params.errorText)
  }
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
    consoleErrors.push(
      (d.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
    )
  }
  if (d.method === 'Runtime.exceptionThrown') {
    exceptions.push(d.params.exceptionDetails?.exception?.description ?? 'unknown')
  }
}
let responses = []
let failures = []
let consoleErrors = []
let exceptions = []

function send(method, params = {}) {
  const m = ++id
  ws.send(JSON.stringify({ id: m, method, params }))
  return new Promise((res) => pending.set(m, res))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evaluate = async (expr) =>
  (await send('Runtime.evaluate', { expression: `(function(){ ${expr} })()`, returnByValue: true }))
    .result?.result?.value

console.log(`\n===== 子路径部署验证：${BASE_URL} =====\n`)

// 重新导航以捕获完整网络请求
responses = []
failures = []
consoleErrors = []
exceptions = []
await send('Network.enable')
await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: BASE_URL })
await sleep(4000)

const url = await evaluate('return location.href')
check('页面 URL 位于子路径', url === BASE_URL || url === BASE_URL.replace(/\/$/, ''), url)

const appRoot = await evaluate('return document.getElementById("app")?.children.length ?? 0')
check('Vue 应用已挂载', appRoot > 0, `#app 子节点 ${appRoot}`)

const bad = responses.filter((r) => r.status >= 400)
check('无 4xx/5xx 资源请求', bad.length === 0, bad.map((b) => `${b.status} ${b.url}`).join(', ') || '全部 200/304')

check('无网络加载失败', failures.length === 0, failures.join(', ') || '无')

const offBase = responses
  .map((r) => r.url)
  .filter((u) => u.startsWith('http://127.0.0.1:4173/') && !u.startsWith('http://127.0.0.1:4173/element-cube'))
check('所有资源都走在 /element-cube/ 前缀下', offBase.length === 0, offBase.join(', ') || '无越界请求')

// 首屏渲染
const tiles = await evaluate('return document.querySelectorAll(".tile").length')
check('周期表 118 个元素已渲染', tiles === 118, `${tiles} 个`)

const title = await evaluate('return document.title')
check('标题正确', title.includes('元素立方'), title)

const faviconHref = await evaluate(
  'return document.querySelector("link[rel=icon]")?.getAttribute("href") ?? ""',
)
check('favicon 路径带 base 前缀', faviconHref === '/element-cube/favicon.svg', faviconHref)

// 打开详情，验证异步 chunk（label-*.js 内含 three）在子路径下能正确加载
await evaluate(`
  const t = [...document.querySelectorAll('.tile')].find(n => n.textContent.includes('Fe'));
  (t ?? document.querySelector('.tile')).click();
  return 1
`)
await sleep(2500)
const atomCanvas = await evaluate(`
  const c = document.querySelector('.panel canvas');
  return c ? { w: c.width, h: c.height } : null
`)
check('3D 原子模型 chunk 在子路径下加载成功', !!atomCanvas && atomCanvas.w > 0, JSON.stringify(atomCanvas))

await evaluate('document.querySelector(".panel .nav-btn")?.click(); return 1')
await evaluate('document.querySelectorAll(".scrim")[0]?.click(); return 1')
await sleep(600)

// 3D 立方视图（动态 import 的 CSS + JS）
await evaluate(`
  const b = [...document.querySelectorAll('.segment button')].find(n => n.textContent.includes('3D'));
  b.click();
  return 1
`)
await sleep(5000)
const cubeCanvas = await evaluate(`
  const c = document.querySelector('.canvas-host canvas');
  return c ? { w: c.width, h: c.height } : null
`)
check('3D 立方周期表 chunk 在子路径下加载成功', !!cubeCanvas && cubeCanvas.w > 0, JSON.stringify(cubeCanvas))

const cubeCss = await evaluate(`
  const sheets = [...document.styleSheets].map(s => s.href).filter(Boolean);
  return sheets.length
`)
check('外部样式表已加载', cubeCss >= 1, `${cubeCss} 个`)

// 移动端
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await sleep(1200)
const overflow = await evaluate(`
  return document.documentElement.scrollWidth > window.innerWidth + 2
`)
check('移动端无横向溢出', !overflow, `scrollWidth=${await evaluate('return document.documentElement.scrollWidth')}`)

console.log('\n===== 控制台 =====')
check('无 JS 异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | ') || '无')
check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无')

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
ws.close()
process.exit(fail > 0 ? 1 : 0)
