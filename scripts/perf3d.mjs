/**
 * 3D 性能探针
 *
 * 读取 renderer.info 统计 draw call / 三角面数 / GPU 资源数量，并在真实渲染循环中
 * 采样帧率。用于验证「118 个元素合并到单张图集」「逐骨骼共享几何体」等优化是否生效。
 *
 * 前置：以调试模式打开浏览器（同 smoke.mjs），然后运行 node scripts/perf3d.mjs
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
      /* 等待浏览器就绪 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('无法连接调试端口')
}

const target = await getTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res) => {
  ws.onopen = res
})

let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg.result)
  }
}

function send(method, params = {}) {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method, params }))
  return new Promise((resolve) => {
    pending.set(mid, { resolve })
    setTimeout(() => resolve({}), 30000)
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){ ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: APP_URL })
await sleep(3000)

function info(key) {
  return evaluate(`
    const r = window.${key};
    if (!r) return null;
    const i = r.info;
    return {
      calls: i.render.calls,
      triangles: i.render.triangles,
      points: i.render.points,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs ? i.programs.length : -1,
      pixelRatio: r.getPixelRatio(),
      drawingBuffer: [r.domElement.width, r.domElement.height],
    };
  `)
}

async function fps(seconds = 3) {
  return evaluate(`
    return new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      function loop() {
        n++;
        if (performance.now() - t0 < ${seconds * 1000}) requestAnimationFrame(loop);
        else res(Math.round((n / (performance.now() - t0)) * 1000));
      }
      requestAnimationFrame(loop);
    });
  `)
}

console.log('\n===== 3D 周期表（118 立方体）=====')
await evaluate(`
  Array.from(document.querySelectorAll('.segment button')).find(b => b.textContent.includes('3D')).click();
  return true;
`)
await sleep(4500)
console.log('GPU 资源：', JSON.stringify(await info('__EC_CUBE__')))
console.log('帧率：', (await fps(3)), 'fps')
// 旋转 1.5 秒后再测一次，覆盖交互过程
await evaluate(`
  const host = document.querySelector('.canvas-host');
  const r = host.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  host.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true, pointerId: 1, isPrimary: true }));
  host.dispatchEvent(new PointerEvent('pointermove', { clientX: cx + 120, clientY: cy + 40, bubbles: true, pointerId: 1, isPrimary: true }));
  host.dispatchEvent(new PointerEvent('pointerup', { clientX: cx + 120, clientY: cy + 40, bubbles: true, pointerId: 1, isPrimary: true }));
  return true;
`)
await sleep(800)
console.log('拖拽后 GPU 资源：', JSON.stringify(await info('__EC_CUBE__')))
console.log('拖拽后帧率：', (await fps(3)), 'fps')

console.log('\n===== 3D 原子模型（随机重元素）=====')
await evaluate(`
  Array.from(document.querySelectorAll('.segment button')).find(b => b.textContent.includes('列表')).click();
  return true;
`)
await sleep(600)
// 打开第 25 个元素，避开缓存
await evaluate(`document.querySelectorAll('.card')[25].click(); return true`)
await sleep(3000)
console.log('GPU 资源：', JSON.stringify(await info('__EC_ATOM__')))
console.log('帧率：', (await fps(3)), 'fps')

// 连续切换元素，检查资源是否被正确释放（几何体不应增长、贴图应回到基线）
console.log('\n===== 连续切换元素后的资源占用 =====')
const base = await info('__EC_ATOM__')
console.log(
  `基线         → geometries=${base.geometries} textures=${base.textures} calls=${base.calls} triangles=${base.triangles}`,
)
for (let k = 0; k < 40; k++) {
  await evaluate(`document.querySelectorAll('.panel .nav-btn')[1].click(); return true`)
  await sleep(120)
}
await sleep(600)
const fwd = await info('__EC_ATOM__')
console.log(
  `前进 40 次   → geometries=${fwd.geometries} textures=${fwd.textures} calls=${fwd.calls} triangles=${fwd.triangles}`,
)
for (let k = 0; k < 40; k++) {
  await evaluate(`document.querySelectorAll('.panel .nav-btn')[0].click(); return true`)
  await sleep(120)
}
await sleep(600)
const back = await info('__EC_ATOM__')
console.log(
  `回到原点     → geometries=${back.geometries} textures=${back.textures} calls=${back.calls} triangles=${back.triangles}`,
)
const noLeak = Math.abs(back.textures - base.textures) <= 2 && back.geometries === base.geometries
console.log(noLeak ? '✅ 往返切换后资源回到基线（无泄漏）' : '❌ 资源未回收')

// 反复开关详情面板，检查 WebGL 上下文是否泄漏
await evaluate(`document.querySelector('.panel .close').click(); return true`)
await sleep(500)
for (let i = 0; i < 8; i++) {
  await evaluate(`document.querySelectorAll('.card')[${i}].click(); return true`)
  await sleep(320)
  await evaluate(`document.querySelector('.panel .close').click(); return true`)
  await sleep(280)
}
await sleep(500)
const canvases = await evaluate(`return document.querySelectorAll('canvas').length`)
console.log('开关 8 次后页面残留 canvas：', canvases)

ws.close()
process.exit(0)
