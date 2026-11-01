/** 视觉检查：通过 CDP 截取各视图与断点截图到 .screenshots/ */
import { mkdirSync, writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const APP_URL = process.env.EC_URL ?? 'http://127.0.0.1:5173/element-cube/'
const OUT = new URL('../.screenshots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
mkdirSync(OUT, { recursive: true })

const list = await (await fetch(`${CDP}/json`)).json()
const page = list.find((t) => t.type === 'page' && (t.url ?? '').includes('5173'))
if (!page) throw new Error('未找到应用页面')

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
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const m = ++id
    pending.set(m, res)
    ws.send(JSON.stringify({ id: m, method, params }))
  })
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: `(function(){ ${expr} })()`, returnByValue: true }))
    .result.result.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = `${OUT}${name}.png`
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log('📷', file)
}

async function setViewport(w, h, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile,
  })
  await sleep(600)
}

await send('Runtime.enable')
await send('Page.enable')

// ---- 桌面端 ----
await setViewport(1600, 1000)
await send('Page.navigate', { url: APP_URL })
await sleep(2600)
await ev(`localStorage.setItem('ec-theme','light'); return 1`)
await send('Page.navigate', { url: APP_URL })
await sleep(2600)
await ev(`
  const b = [...document.querySelectorAll('.segment button')].find(n => n.textContent.includes('周期表'));
  if (b && !b.classList.contains('on')) b.click();
  return 1;
`)
await sleep(900)
await shot('01-desktop-grid-light')

// 打开铁元素详情
await ev(`
  const t = [...document.querySelectorAll('.tile')].find(n => n.querySelector('.sym')?.textContent === 'Fe');
  t.click();
  return 1;
`)
await sleep(4000)
await shot('02-desktop-detail-light')
await ev(`document.querySelector('.panel .close').click(); return 1`)
await sleep(600)

// 深色模式
await ev(`document.querySelector('.icon-btn').click(); return 1`)
await sleep(900)
await shot('03-desktop-grid-dark')
await ev(`
  const t = [...document.querySelectorAll('.tile')].find(n => n.querySelector('.sym')?.textContent === 'Au');
  t.click();
  return 1;
`)
await sleep(4000)
await shot('04-desktop-detail-dark')
await ev(`document.querySelector('.panel .close').click(); return 1`)
await sleep(600)
await ev(`document.querySelector('.icon-btn').click(); return 1`)
await sleep(700)

// 3D 立方视图
await ev(`
  [...document.querySelectorAll('.segment button')].find(b => b.textContent.includes('3D')).click();
  return 1;
`)
await sleep(5000)
await shot('05-desktop-cube3d')

// 3D 立方视图：跳转定位 + 详情卡 + 轴标注
await ev(`
  const inp = document.querySelector('.jump input');
  inp.value = 'Nd';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.jump button[type=submit]').click();
  return 1;
`)
await sleep(2200)
await shot('10-cube3d-detail-card')

// 3D 立方视图：搜索结果联动（非命中元素压暗）
await ev(`
  const el = document.querySelector('.search input');
  el.value = '卤素';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 1;
`)
await sleep(1600)
await shot('11-cube3d-search-dim')
await ev(`document.querySelector('.clear')?.click(); return 1`)
await sleep(600)

// 3D 原子模型：点击原子核热区弹出信息卡
await ev(`
  [...document.querySelectorAll('.segment button')].find(b => b.textContent.includes('周期表')).click();
  return 1;
`)
await sleep(800)
await ev(`
  const t = [...document.querySelectorAll('.tile')].find(n => n.querySelector('.sym')?.textContent === 'Fe');
  t.click();
  return 1;
`)
await sleep(4000)
await ev(`
  const host = document.querySelector('.panel .stage');
  const r = host.getBoundingClientRect();
  const opts = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1, isPrimary: true };
  host.dispatchEvent(new PointerEvent('pointerdown', opts));
  host.dispatchEvent(new PointerEvent('pointerup', opts));
  return 1;
`)
await sleep(900)
await shot('12-atom-hotspot-card')
await ev(`document.querySelector('.panel .close').click(); return 1`)
await sleep(600)

// 搜索 + 筛选
await ev(`
  [...document.querySelectorAll('.segment button')].find(b => b.textContent.includes('周期表')).click();
  return 1;
`)
await sleep(700)
await ev(`
  const el = document.querySelector('.search input');
  el.value = '金属';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.cat')].find(b => b.textContent.includes('过渡金属')).click();
  return 1;
`)
await sleep(900)
await shot('06-desktop-filter')

// ---- 移动端 ----
await setViewport(390, 844, true)
await send('Page.navigate', { url: APP_URL })
await sleep(2600)
await shot('07-mobile-list')
await ev(`
  const t = [...document.querySelectorAll('.card')].find(n => n.querySelector('.c-sym')?.textContent === 'Cu');
  (t || document.querySelector('.card')).click();
  return 1;
`)
await sleep(4000)
await shot('08-mobile-detail')
await ev(`document.querySelector('.panel .close').click(); return 1`)
await sleep(600)
await ev(`
  [...document.querySelectorAll('.segment button')].find(b => b.textContent.includes('周期表')).click();
  return 1;
`)
await sleep(900)
await shot('09-mobile-grid')

ws.close()
process.exit(0)
