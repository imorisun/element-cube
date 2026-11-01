/**
 * 主题默认值验证
 *
 * 校验点：
 *  1. 首次访问（无 localStorage）默认浅色，且 <html data-theme> 在首帧前就已确定
 *  2. body 实际计算样式为浅色背景 / 深色文字
 *  3. theme-color meta 同步为浅色
 *  4. 手动切到深色后写入 localStorage，刷新仍然保留（记忆生效）
 *  5. 清除记忆后刷新重新回到浅色
 *  6. 浅色 / 深色下均无控制台报错
 *
 * 前置：远程调试模式启动浏览器并打开站点
 *   msedge.exe --headless=new --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/edge-theme --enable-unsafe-swiftshader \
 *     --window-size=1600,1000 "http://127.0.0.1:5173/element-cube/"
 */

const CDP = 'http://127.0.0.1:9222'
const APP_URL = process.env.EC_URL ?? 'http://127.0.0.1:5173/element-cube/'

const list = await (await fetch(`${CDP}/json`)).json()
const page = list.find((t) => t.type === 'page' && (t.url ?? '').includes('5173')) ?? list[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))

let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
function send(method, params = {}) {
  const m = ++id
  ws.send(JSON.stringify({ id: m, method, params }))
  return new Promise((res) => pending.set(m, res))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){ ${expr} })()`,
    returnByValue: true,
  })
  return r.result?.result?.value
}

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`)
  }
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(m.params.entry.text)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.text)
  }
})

/* ---------- 1. 首次访问（清空记忆） ---------- */
console.log('\n===== 1. 首次访问默认主题 =====')
await send('Page.navigate', { url: APP_URL })
await sleep(2600)
await ev(`try { localStorage.removeItem('ec-theme') } catch (e) {}`)
await send('Page.navigate', { url: APP_URL })
await sleep(2600)

const themeAttr = await ev(`return document.documentElement.dataset.theme`)
check('默认 data-theme = light', themeAttr === 'light', `实际 ${themeAttr}`)

const stored = await ev(`try { return localStorage.getItem('ec-theme') } catch (e) { return 'ERR' }`)
check('首次访问不写入记忆（保留默认）', stored === null || stored === 'light', `实际 ${stored}`)

const bodyStyle = await ev(`
  const s = getComputedStyle(document.body);
  return { bg: s.backgroundColor, fg: s.color }
`)
const rgb = (s) => (s.match(/\d+/g) ?? []).map(Number)
const [br, bg_, bb] = rgb(bodyStyle.bg)
const [fr, fg_, fb] = rgb(bodyStyle.fg)
const bgLum = (br * 299 + bg_ * 587 + bb * 114) / 1000
const fgLum = (fr * 299 + fg_ * 587 + fb * 114) / 1000
check('body 背景为浅色', bgLum > 180, `bg=${bodyStyle.bg} 亮度=${bgLum.toFixed(0)}`)
check('body 文字为深色', fgLum < 90, `fg=${bodyStyle.fg} 亮度=${fgLum.toFixed(0)}`)

const themeColor = await ev(
  `return document.querySelector('meta[name="theme-color"]')?.getAttribute('content')`,
)
check('theme-color 已同步为浅色 #eef2f9', themeColor === '#eef2f9', `实际 ${themeColor}`)

await ev(`
  const b = [...document.querySelectorAll('.segment button')].find(n => n.textContent.includes('周期表'));
  if (b && !b.classList.contains('on')) b.click();
  return 1;
`)
await sleep(800)
const fs = await import('node:fs')
fs.mkdirSync('.screenshots', { recursive: true })
let shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('.screenshots/14-default-light-grid.png', Buffer.from(shot.result.data, 'base64'))
console.log('  📷 已保存 .screenshots/14-default-light-grid.png')

/* ---------- 2. 切换到深色 ---------- */
console.log('\n===== 2. 手动切换到深色 =====')
await ev(`document.querySelector('.icon-btn').click(); return 1`)
await sleep(900)
check(
  '切换后 data-theme = dark',
  (await ev(`return document.documentElement.dataset.theme`)) === 'dark',
)
check(
  'theme-color 同步为深色 #070b16',
  (await ev(
    `return document.querySelector('meta[name="theme-color"]')?.getAttribute('content')`,
  )) === '#070b16',
)
check(
  '记忆写入 localStorage',
  (await ev(`try { return localStorage.getItem('ec-theme') } catch (e) { return 'ERR' }`)) ===
    'dark',
)
shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('.screenshots/15-manual-dark-grid.png', Buffer.from(shot.result.data, 'base64'))
console.log('  📷 已保存 .screenshots/15-manual-dark-grid.png')

/* ---------- 3. 刷新保留记忆 ---------- */
console.log('\n===== 3. 刷新后保留记忆 =====')
await send('Page.navigate', { url: APP_URL })
await sleep(2600)
check(
  '刷新后仍为深色（记忆生效）',
  (await ev(`return document.documentElement.dataset.theme`)) === 'dark',
)

/* ---------- 4. 清除记忆回到浅色 ---------- */
console.log('\n===== 4. 清除记忆后回到浅色 =====')
await ev(`try { localStorage.removeItem('ec-theme') } catch (e) {}`)
await send('Page.navigate', { url: APP_URL })
await sleep(2600)
check(
  '清除记忆后回到浅色',
  (await ev(`return document.documentElement.dataset.theme`)) === 'light',
)

/* ---------- 5. 首帧前已确定主题（无闪烁） ---------- */
console.log('\n===== 5. 首帧前主题已确定 =====')
const htmlSnippet = await fetch(APP_URL).then((r) => r.text())
check(
  'index.html 静态默认 data-theme="light"',
  /<html[^>]*data-theme="light"/.test(htmlSnippet),
)
check(
  'index.html 含首帧前内联主题脚本',
  htmlSnippet.includes("localStorage.getItem('ec-theme')"),
)

/* ---------- 6. 控制台 ---------- */
console.log('\n===== 6. 控制台 =====')
check('无运行时报错', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
ws.close()
process.exit(fail === 0 ? 0 : 1)
