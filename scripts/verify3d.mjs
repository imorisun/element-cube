/**
 * 3D 交互修复验证脚本（临时）
 * 覆盖：原子模型滚轮缩放 / 缩放上下限、立方体导航顺序、边界禁用、回到中心
 * 用法：先用远程调试模式启动 Edge（9222），再 node scripts/verify3d.mjs
 */
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page' && (t.url ?? '').includes('5173'))
if (!page) throw new Error('未找到目标页面')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
function send(method, params = {}) {
  const m = ++id
  ws.send(JSON.stringify({ id: m, method, params }))
  return new Promise((res) => {
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (d.id === m) res(d)
    }
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass++
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}
await send('Runtime.enable')
await send('Log.enable')
const consoleErrors = []
ws.addEventListener('message', (e) => {
  const d = JSON.parse(e.data)
  if (d.method === 'Log.entryAdded' && d.params?.entry?.level === 'error') {
    consoleErrors.push(String(d.params.entry.text).slice(0, 200))
  }
  if (d.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXC: ' + JSON.stringify(d.params.exceptionDetails?.text ?? '').slice(0, 200))
  }
})
await send('Page.navigate', { url: process.env.EC_URL ?? 'http://127.0.0.1:5173/element-cube/' })
await sleep(3000)
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(function(){ ${expr} })()`, returnByValue: true })
  if (r.result?.exceptionDetails) console.log('EVAL ERR:', JSON.stringify(r.result.exceptionDetails).slice(0, 200))
  return r.result?.result?.value
}
async function rc(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}
async function clickSel(sel, idx = 0) {
  const box = await ev(`const n=document.querySelectorAll('${sel}')[${idx}]; if(!n) return null; const r=n.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}`)
  if (!box) return false
  await rc(Math.round(box.x), Math.round(box.y))
  return true
}
async function wheel(sel, deltaY, times = 1) {
  const box = await ev(`const n=document.querySelector('${sel}'); if(!n) return null; const r=n.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}`)
  if (!box) return false
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(box.x),
      y: Math.round(box.y),
      deltaX: 0,
      deltaY,
    })
    await sleep(120)
  }
  return true
}

/* ================= 1. 原子模型滚轮缩放 ================= */
console.log('\n===== 原子模型缩放 =====')
await ev(`const b=[...document.querySelectorAll('.segment button')].find(n=>n.textContent.includes('周期表')); b.click(); return 1`)
await sleep(500)
await ev(`document.querySelectorAll('.tile')[25].click(); return 1`) // Fe
await sleep(3500)
const atomDist = () => ev(`
  const d = window.__EC_ATOM_DBG__; if(!d) return null;
  const c = d.camera(); const ct = d.controls();
  return c && ct ? +(c.position.distanceTo(ct.target)).toFixed(3) : null
`)
const limits = await ev(`const d=window.__EC_ATOM_DBG__; return d ? d.limits() : null`)
console.log('缩放上下限:', JSON.stringify(limits))
const d0 = await atomDist()
console.log('初始距离:', d0)
await wheel('.panel .stage', -240, 5) // 滚轮向上 → 放大
await sleep(900)
const d1 = await atomDist()
console.log('放大后距离:', d1)
check('滚轮可放大（距离变小）', d1 != null && d0 != null && d1 < d0 - 0.3, `${d0} → ${d1}`)
await sleep(1200)
const d1s = await atomDist()
check('放大后距离稳定保持（不再被拉回）', Math.abs(d1s - d1) < 0.25, `${d1} → ${d1s}`)
await wheel('.panel .stage', 240, 5) // 缩小
await sleep(900)
const d2 = await atomDist()
console.log('缩小后距离:', d2)
check('滚轮可缩小（距离变大）', d2 != null && d2 > d1 + 0.3, `${d1} → ${d2}`)
// 极限：疯狂放大
await wheel('.panel .stage', -240, 30)
await sleep(1200)
const d3 = await atomDist()
check('放大有下限（不穿模）', d3 != null && d3 >= limits.min - 0.05, `d=${d3} ≥ min=${limits.min.toFixed(2)}`)
await wheel('.panel .stage', 240, 60)
await sleep(1200)
const d4 = await atomDist()
check('缩小有上限（不过小）', d4 != null && d4 <= limits.max + 0.05, `d=${d4} ≤ max=${limits.max.toFixed(2)}`)
// 重置视角
await clickSel('.panel .mini', 3)
await sleep(1200)
const d5 = await atomDist()
check('重置视角回到构图距离', d5 != null && Math.abs(d5 - limits.fit) < 1.2, `d=${d5} fit=${limits.fit.toFixed(2)}`)
// 切换元素后缩放倍率是否保持
await wheel('.panel .stage', -240, 6)
await sleep(800)
const dz = await atomDist()
await ev(`document.querySelectorAll('.panel .nav-btn')[1].click(); return 1`)
await sleep(1500)
const dz2 = await atomDist()
check('切换元素后保留缩放手感', Math.abs(dz2 - dz) < Math.abs(dz) * 0.45, `${dz} → ${dz2}`)
await ev(`document.querySelector('.panel .close')?.click(); return 1`)
await sleep(600)

/* ================= 2. 3D 立方导航 ================= */
console.log('\n===== 3D 立方导航 =====')
await ev(`const b=[...document.querySelectorAll('.segment button')].find(n=>n.textContent.includes('3D')); b.click(); return 1`)
await sleep(4500)
const navState = () => ev(`
  const bs=[...document.querySelectorAll('.nav-bar .step')];
  return bs.map(b=>b.textContent.trim().replace(/\\s+/g,'')+ (b.disabled?'(禁用)':'(可点)')).join(' | ')
`)
console.log('初始导航:', await navState())
const host = await ev(`const r=document.querySelector('.canvas-host').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}`)
await rc(Math.round(host.x + host.w * 0.5), Math.round(host.y + host.h * 0.55))
await sleep(700)
const sym = () => ev(`return document.querySelector('.cube-card .card-sym')?.textContent ?? '无卡片'`)
const num = () => ev(`return document.querySelector('.cube-card .card-num')?.textContent ?? '无卡片'`)
console.log('点击方块 → 卡片:', await sym(), await num())
check('点击立方体弹出详情卡', (await sym()) !== '无卡片')

// 真实鼠标点击卡片内的「下一个」三次
const seq = [await num()]
for (let i = 0; i < 3; i++) {
  const ok = await clickSel('.cube-card .card-nav button', 1)
  await sleep(700)
  seq.push(await num())
}
console.log('卡片内 下一个 序列:', seq.join(' → '))
const nums = seq.map(Number).filter((n) => !Number.isNaN(n))
check(
  '卡片内「下一个」按原子序数递增',
  nums.length === 4 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1),
  seq.join(' → '),
)
// 真实鼠标点击卡片内的「上一个」两次
const seq2 = [await num()]
for (let i = 0; i < 2; i++) {
  await clickSel('.cube-card .card-nav button', 0)
  await sleep(700)
  seq2.push(await num())
}
console.log('卡片内 上一个 序列:', seq2.join(' → '))
const nums2 = seq2.map(Number).filter((n) => !Number.isNaN(n))
check(
  '卡片内「上一个」按原子序数递减',
  nums2.length === 3 && nums2.every((n, i) => i === 0 || n === nums2[i - 1] - 1),
  seq2.join(' → '),
)
// 卡片资料完整性
const cardText = await ev(`return document.querySelector('.cube-card')?.innerText ?? ''`)
console.log('卡片文本片段:', cardText.replace(/\n+/g, ' / ').slice(0, 320))
check('卡片含电子排布', cardText.includes('电子排布'))
check('卡片含相对原子质量', cardText.includes('相对原子质量'))
check('卡片含各层电子数', cardText.includes('各层电子数'))
const cfg = await ev(`return document.querySelector('.card-config b')?.textContent ?? ''`)
console.log('电子排布值:', cfg)

/* ================= 3. 边界禁用 ================= */
console.log('\n===== 边界行为 =====')
await ev(`const i=document.querySelector('.jump input'); i.value='1'; i.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.jump button').click(); return 1`)
await sleep(1200)
console.log('跳到 1 号后:', await sym(), await navState())
check('1 号时「上一个」禁用', (await navState()).includes('←上一个(禁用)'))
await ev(`const i=document.querySelector('.jump input'); i.value='Og'; i.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.jump button').click(); return 1`)
await sleep(1200)
console.log('跳到 118 号后:', await sym(), await navState())
check('118 号时「下一个」禁用', (await navState()).includes('下一个→(禁用)'))
check('118 号卡片为 Og', (await sym()) === 'Og')

/* ================= 4. 回到中心 ================= */
console.log('\n===== 回到中心 =====')
const camInfo = () => ev(`
  const r = window.__EC_CUBE__; if(!r) return null;
  return null
`)
const cubeDbg = await ev(`
  const d = window.__EC_CUBE_DBG__; return d ? { ok:true } : { ok:false }
`)
console.log('立方调试钩子:', JSON.stringify(cubeDbg))
await clickSel('.nav-bar .step', 2) // ⌖ 回到中心
await sleep(1600)
const home = await ev(`
  const d = window.__EC_CUBE_DBG__; if(!d) return null;
  const c = d.camera(); const ct = d.controls();
  return {
    cam: [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)],
    target: [+ct.target.x.toFixed(2), +ct.target.y.toFixed(2), +ct.target.z.toFixed(2)],
  }
`)
console.log('复位后机位:', JSON.stringify(home))
check(
  '「⌖ 回到中心」把目标点复位到周期表中心',
  home != null && Math.abs(home.target[0]) < 0.1 && Math.abs(home.target[2]) < 0.1,
  JSON.stringify(home?.target),
)
const homeDist = home
  ? Math.hypot(home.cam[0] - home.target[0], home.cam[1] - home.target[1], home.cam[2] - home.target[2])
  : 0
// 自动旋转会让相机绕中心轻微转动，因此只校验高度与半径（x/z 允许随自转变化）
check(
  '复位后相机回到基准机位（高度与半径）',
  home != null && Math.abs(home.cam[1] - 13) < 0.4 && Math.abs(homeDist - 21.04) < 0.6,
  `y=${home?.cam[1]} 半径=${homeDist.toFixed(2)}（基准 21.04）`,
)

/* ================= 5. 其它交互回归 ================= */
console.log('\n===== 其它交互回归 =====')
const cubeDist = () => ev(`
  const d = window.__EC_CUBE_DBG__; if(!d) return null;
  const c = d.camera(); const ct = d.controls();
  return +(c.position.distanceTo(ct.target)).toFixed(2)
`)
const azim = () => ev(`
  const d = window.__EC_CUBE_DBG__; if(!d) return null;
  const c = d.camera(); const ct = d.controls();
  return +(Math.atan2(c.position.x - ct.target.x, c.position.z - ct.target.z)).toFixed(3)
`)
await ev(`const b=[...document.querySelectorAll('.mini')].find(n=>n.textContent.includes('暂停旋转')); if(b) b.click(); return 1`)
await sleep(600)
const cz0 = await cubeDist()
await wheel('.canvas-host', -240, 4)
await sleep(700)
const cz1 = await cubeDist()
check('立方视图滚轮可缩放', cz1 != null && cz0 != null && Math.abs(cz1 - cz0) > 0.5, `${cz0} → ${cz1}`)
const a0 = await azim()
const h2 = await ev(`const r=document.querySelector('.canvas-host').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(h2.x + h2.w * 0.3), y: Math.round(h2.y + h2.h * 0.5), button: 'left', clickCount: 1, buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(h2.x + h2.w * 0.55), y: Math.round(h2.y + h2.h * 0.5), button: 'left', buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(h2.x + h2.w * 0.55), y: Math.round(h2.y + h2.h * 0.5), button: 'left', clickCount: 1, buttons: 0 })
await sleep(800)
const a1 = await azim()
check('拖拽可旋转视角', a0 != null && a1 != null && Math.abs(a1 - a0) > 0.05, `${a0} → ${a1}`)
// 点击卡片非按钮区域不应关闭卡片
const cardBox = await ev(`const c=document.querySelector('.cube-card'); if(!c) return null; const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}`)
if (cardBox) {
  await rc(Math.round(cardBox.x + cardBox.w / 2), Math.round(cardBox.y + cardBox.h - 30))
  await sleep(500)
  check('点击卡片内容区不会误关卡片', (await sym()) !== '无卡片')
}
// 点击空白处仍应关闭卡片
await rc(Math.round(h2.x + 14), Math.round(h2.y + h2.h - 14))
await sleep(500)
check('点击空白处关闭卡片（原有行为保留）', (await sym()) === '无卡片')
// 窗口缩放
await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false })
await sleep(1200)
const sized = await ev(`
  const c = document.querySelector('.canvas-host canvas');
  const h = document.querySelector('.canvas-host');
  return c ? { cw: c.clientWidth, hw: h.clientWidth, ch: c.clientHeight, hh: h.clientHeight } : null
`)
check('窗口缩放后画布跟随容器', sized != null && Math.abs(sized.cw - sized.hw) <= 2 && Math.abs(sized.ch - sized.hh) <= 2, JSON.stringify(sized))
await send('Emulation.clearDeviceMetricsOverride')
await sleep(800)

/* ================= 6. 控制台 ================= */
console.log('\n===== 控制台 =====')
check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
ws.close()
process.exit(fail ? 1 : 0)
