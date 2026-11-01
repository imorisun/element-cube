/**
 * 图标导出流水线
 * 把 icons/*.svg 栅格化为多尺寸 PNG，并组装 favicon.ico，输出到 public/ 供 Vite 直接发布。
 *
 * 前置：先用远程调试模式启动一次浏览器（脚本会自动导航，不需要预先打开页面）
 *   msedge.exe --headless=new --remote-debugging-port=9222 \
 *     --enable-unsafe-swiftshader --user-data-dir=/tmp/edge-ico about:blank
 * 运行：node scripts/gen-icons.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SVG_DIR = join(ROOT, 'icons')
const OUT_DIR = join(ROOT, 'public')
const CDP_PORT = process.env.EC_CDP ?? '9222'

const read = (f) => readFileSync(join(SVG_DIR, f), 'utf8')

/** 内联 SVG 并改写尺寸，便于按目标分辨率渲染 */
function embed(markup, width, height) {
  const sized = markup
    .replace(/width="\d+"/, `width="${width}"`)
    .replace(/height="\d+"/, `height="${height}"`)
  return `<!doctype html><html><head><base href="file:///${SVG_DIR}/"><style>
    html,body{margin:0;padding:0;background:transparent}
    .wrap{width:${width}px;height:${height}px;line-height:0}
    svg{display:block}
  </style></head><body><div class="wrap">${sized}</div></body></html>`
}

/* ---------- 导出任务表 ---------- */
const TASKS = [
  { svg: 'icon.svg', file: 'icon-{n}.png', sizes: [32, 48, 64, 128, 256, 512] },
  { svg: 'icon-dark.svg', file: 'icon-dark-{n}.png', sizes: [512] },
  { svg: 'icon-compact.svg', file: 'icon-compact-{n}.png', sizes: [16, 24, 32, 48] },
  { svg: 'icon-mono.svg', file: 'icon-mono-{n}.png', sizes: [24, 512] },
  { svg: 'icon-app.svg', file: 'app-icon-{n}.png', sizes: [180, 192, 512] },
  { svg: 'icon-app-maskable.svg', file: 'app-icon-maskable-{n}.png', sizes: [512] },
  { svg: 'og-image.svg', file: 'og-image.png', sizes: [630], ratio: 1200 / 630 },
]

/* ---------- 连接浏览器 ---------- */
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
const target = list.find((t) => t.type === 'page') ?? list[0]
if (!target) {
  console.error(`无法连接调试端口 ${CDP_PORT}，请先以 --remote-debugging-port=${CDP_PORT} 启动浏览器`)
  process.exit(1)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
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
const send = (method, params = {}) => {
  const m = ++id
  ws.send(JSON.stringify({ id: m, method, params }))
  return new Promise((res) => pending.set(m, res))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')

mkdirSync(OUT_DIR, { recursive: true })
let count = 0

for (const task of TASKS) {
  const markup = read(task.svg)
  for (const size of task.sizes) {
    const w = Math.round(size * (task.ratio ?? 1))
    const h = size
    await send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    })
    const html = embed(markup, w, h)
    await send('Page.navigate', { url: 'about:blank' })
    await sleep(60)
    await send('Runtime.evaluate', {
      expression: `document.open();document.write(${JSON.stringify(html)});document.close()`,
    })
    await sleep(140)
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
      optimizeForSpeed: false,
    })
    const data = shot.result?.data
    if (!data) {
      console.error(`  ✗ ${task.file.replace('{n}', size)} 截图失败`)
      continue
    }
    const buf = Buffer.from(data, 'base64')
    const name = task.file.replace('{n}', size)
    writeFileSync(join(OUT_DIR, name), buf)
    count++
    console.log(`  ✓ ${name}  ${w}×${h}  ${(buf.length / 1024).toFixed(1)} KB`)
  }
}

/* ---------- 组装 favicon.ico（内嵌 PNG 条目，兼容性最好） ---------- */
function buildIco(entries) {
  const n = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(n, 4)
  const dir = Buffer.alloc(16 * n)
  let offset = 6 + 16 * n
  entries.forEach((e, i) => {
    const o = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(e.buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.buf.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)])
}

const icoSizes = [16, 32, 48]
const icoEntries = icoSizes.map((size) => ({
  size,
  buf: readFileSync(join(OUT_DIR, `icon-compact-${size}.png`)),
}))
const ico = buildIco(icoEntries)
writeFileSync(join(OUT_DIR, 'favicon.ico'), ico)
console.log(`  ✓ favicon.ico  ${icoSizes.join('/')}  ${(ico.length / 1024).toFixed(1)} KB`)

/* ---------- apple-touch-icon（惯例文件名） ---------- */
writeFileSync(
  join(OUT_DIR, 'apple-touch-icon.png'),
  readFileSync(join(OUT_DIR, 'app-icon-180.png')),
)
console.log('  ✓ apple-touch-icon.png  (from app-icon-180.png)')

/* ---------- 复制 SVG 到发布目录 ---------- */
const COPY = [
  ['icon-compact.svg', 'favicon.svg'],
  ['icon-compact-dark.svg', 'favicon-dark.svg'],
  ['icon.svg', 'icon.svg'],
  ['icon-dark.svg', 'icon-dark.svg'],
  ['icon-app.svg', 'app-icon.svg'],
  ['icon-app-maskable.svg', 'app-icon-maskable.svg'],
]
for (const [src, dst] of COPY) {
  writeFileSync(join(OUT_DIR, dst), read(src))
  console.log(`  ✓ ${dst}  (from ${src})`)
}

await send('Emulation.clearDeviceMetricsOverride')
console.log(`\n完成，共导出 ${count} 个 PNG + favicon.ico + ${COPY.length} 个 SVG 到 public/\n`)
ws.close()
process.exit(0)
