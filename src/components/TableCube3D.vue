<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  CATEGORIES,
  CATEGORY_MAP,
  ELEMENTS,
  ELEMENT_BY_NUMBER,
  PHASE_LABEL,
  formatConfig,
  type ElementInfo,
} from '../data/elements'
import {
  PerfGuard,
  createRenderer,
  detectWebGL,
  disposeSubtree,
  exposeDebug,
  teardownRenderer,
} from '../three/gl'
import { makeLabel, setLabelText } from '../three/label'

const emit = defineEmits<{
  (e: 'open', el: ElementInfo): void
}>()

const props = defineProps<{
  selected: number | null
  hit: Set<number>
  filterActive: boolean
}>()

const METRICS = [
  { key: 'radius', label: '原子半径', unit: 'pm', get: (e: ElementInfo) => e.radius },
  { key: 'mass', label: '相对原子质量', unit: '', get: (e: ElementInfo) => e.mass },
  { key: 'en', label: '电负性', unit: '', get: (e: ElementInfo) => e.electronegativity },
  { key: 'melting', label: '熔点', unit: 'K', get: (e: ElementInfo) => e.melting },
  { key: 'boiling', label: '沸点', unit: 'K', get: (e: ElementInfo) => e.boiling },
  { key: 'ionization', label: '第一电离能', unit: 'eV', get: (e: ElementInfo) => e.ionization },
] as const

const metricKey = ref<string>('radius')
function currentMetric() {
  return METRICS.find((m) => m.key === metricKey.value) ?? METRICS[0]
}

/* ================= 视图状态 ================= */
const container = ref<HTMLDivElement | null>(null)
const autoRotate = ref(true)
const supported = ref(true)
const labelsOn = ref(true)
const contextLost = ref(false)
const building = ref(true)
const hovered = ref<ElementInfo | null>(null)
const picked = ref<ElementInfo | null>(null)
const tipPos = ref({ x: 0, y: 0 })
const tipFlip = ref(false)
const jumpText = ref('')
const jumpError = ref('')

/* ================= 标签图集 ================= */
/**
 * 118 个元素若各自生成一张 128² 贴图，会产生 118 次 Canvas 绘制与 118 次 GPU 上传，
 * 首屏构建阻塞明显、显存占用约 10 MB。
 *
 * 这里改为绘制一张 2048×1024 的图集（16×8 格，每格 128px），
 * 每个立方体使用 `texture.clone()` 并设置 offset/repeat 指向自己的格子。
 * three.js 会按 `texture.source` 复用同一份 GPU 纹理（差别只体现在采样矩阵上），
 * 因此最终只有 1 个 WebGLTexture，且-edge bleed 被限制在 1 像素内。
 */
const ATLAS_TILE = 128
const ATLAS_COLS = 16
const ATLAS_ROWS = 8

let atlasCanvas: HTMLCanvasElement | null = null

function drawTile(ctx: CanvasRenderingContext2D, el: ElementInfo, ox: number, oy: number) {
  const size = ATLAS_TILE
  const color = CATEGORY_MAP[el.category].color

  ctx.save()
  ctx.beginPath()
  ctx.rect(ox, oy, size, size)
  ctx.clip()
  ctx.translate(ox, oy)

  ctx.fillStyle = color
  ctx.fillRect(0, 0, size, size)

  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, 'rgba(255,255,255,0.28)')
  grad.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)

  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = '600 24px Inter, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(String(el.number), 8, 7)

  ctx.fillStyle = '#ffffff'
  ctx.font = '700 46px Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(el.symbol, size / 2, size / 2 + 4)

  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = '500 20px "PingFang SC","Microsoft YaHei",system-ui,sans-serif'
  ctx.fillText(el.name, size / 2, size - 20)

  ctx.restore()
}

function getAtlasCanvas(): HTMLCanvasElement {
  if (atlasCanvas) return atlasCanvas
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_TILE * ATLAS_COLS
  canvas.height = ATLAS_TILE * ATLAS_ROWS
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#101423'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ELEMENTS.forEach((el, i) => {
    const col = i % ATLAS_COLS
    const row = Math.floor(i / ATLAS_COLS)
    drawTile(ctx, el, col * ATLAS_TILE, row * ATLAS_TILE)
  })
  atlasCanvas = canvas
  return canvas
}

/** 为第 index 个元素创建指向图集对应格子的纹理（共享同一份 GPU 纹理） */
function makeTileTexture(base: THREE.CanvasTexture, index: number): THREE.Texture {
  const col = index % ATLAS_COLS
  const row = Math.floor(index / ATLAS_COLS)
  const tex = base.clone()
  tex.offset.set(col / ATLAS_COLS, 1 - (row + 1) / ATLAS_ROWS)
  tex.repeat.set(1 / ATLAS_COLS, 1 / ATLAS_ROWS)
  tex.needsUpdate = false
  return tex
}

/* ================= 场景对象 ================= */
interface CubeRec {
  mesh: THREE.Mesh
  el: ElementInfo
  baseColor: THREE.Color
}

const SPACING = 1.0
const cubes: CubeRec[] = []
const cubeMeshes: THREE.Mesh[] = []
const cubeByNumber = new Map<number, CubeRec>()
const targets = new Float32Array(ELEMENTS.length)
const heights = new Float32Array(ELEMENTS.length)

let scene: THREE.Scene | null = null
let root: THREE.Group | null = null
let renderer: THREE.WebGLRenderer | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let axesGroup: THREE.Group | null = null
let selectionLabel: THREE.Sprite | null = null
let boxGeo: THREE.BoxGeometry | null = null

let raf = 0
let resizeObs: ResizeObserver | null = null
let ioObs: IntersectionObserver | null = null
let perfGuard: PerfGuard | null = null
let visible = true
let dragging = false
let lastFrame = 0
let heightsSettled = false
let stylesDirty = true

const raycaster = new THREE.Raycaster()
const pointerNdc = new THREE.Vector2()
let pointerInside = false
let pointerDirty = false
let lastPointer: PointerEvent | null = null
let downPos = { x: 0, y: 0 }
let focusTo: THREE.Vector3 | null = null
let desiredCam: THREE.Vector3 | null = null

/* ================= 柱高与样式 ================= */
function computeTargets() {
  const m = currentMetric()
  const values = ELEMENTS.map((e) => m.get(e)).filter((v): v is number => v != null)
  const min = Math.min(...values)
  const max = Math.max(...values)
  ELEMENTS.forEach((el, i) => {
    const v = m.get(el)
    const t = v == null ? 0 : (v - min) / (max - min || 1)
    targets[i] = 0.22 + t * 3.4
  })
  heightsSettled = false
}

/**
 * 统一刷新所有立方体的外观：选中 / 悬停 / 同行同族 / 搜索命中。
 * 通过 stylesDirty 标记驱动，而不是每帧无脑写材质属性。
 */
function applyStyles() {
  const pickN = picked.value?.number ?? null
  const selN = props.selected
  const hovN = hovered.value?.number ?? null
  const focus = pickN != null ? ELEMENT_BY_NUMBER[pickN] : selN != null ? ELEMENT_BY_NUMBER[selN] : null
  const dimming = props.filterActive

  for (const c of cubes) {
    const n = c.el.number
    const isFocus = focus?.number === n
    const isHover = hovN === n
    const sameRow = !!focus && focus.period === c.el.period
    const sameCol = !!focus && focus.group != null && focus.group === c.el.group
    const related = !!focus && (sameRow || sameCol) && !isFocus
    const missed = dimming && !props.hit.has(n)

    let glow = 0.28
    if (related) glow = 0.42
    if (isHover) glow = 0.6
    if (isFocus) glow = 0.9

    const mat = c.mesh.material as THREE.MeshStandardMaterial
    mat.emissive.copy(c.baseColor).multiplyScalar(missed ? 0 : glow)
    // 未命中搜索结果的整体压暗（含贴图），比开透明混合更省开销
    mat.color.setScalar(missed ? 0.32 : 1)
  }
  stylesDirty = false
}

function updateHeights(dt: number) {
  const k = Math.min(1, dt * 5)
  let settled = true
  for (let i = 0; i < cubes.length; i++) {
    const diff = targets[i] - heights[i]
    if (Math.abs(diff) > 0.0015) settled = false
    heights[i] += diff * k
    cubes[i].mesh.scale.y = Math.max(0.001, heights[i])
  }
  if (settled) {
    for (let i = 0; i < cubes.length; i++) cubes[i].mesh.scale.y = Math.max(0.001, targets[i])
    heightsSettled = true
  }
}

/* ================= 构建 ================= */
function buildCubes() {
  if (!scene || !root) return

  const atlas = new THREE.CanvasTexture(getAtlasCanvas())
  atlas.colorSpace = THREE.SRGBColorSpace
  atlas.generateMipmaps = true
  atlas.minFilter = THREE.LinearMipmapLinearFilter
  atlas.magFilter = THREE.LinearFilter
  atlas.anisotropy = 4
  atlas.userData.shared = true

  // 118 个立方体共享同一份几何体，只在销毁时释放一次
  boxGeo = new THREE.BoxGeometry(0.82, 1, 0.82)
  boxGeo.translate(0, 0.5, 0)

  ELEMENTS.forEach((el, i) => {
    const color = new THREE.Color(CATEGORY_MAP[el.category].color)
    const mat = new THREE.MeshStandardMaterial({
      map: makeTileTexture(atlas, i),
      roughness: 0.55,
      metalness: 0.05,
      emissive: color.clone().multiplyScalar(0.28),
    })
    const mesh = new THREE.Mesh(boxGeo!, mat)
    mesh.position.set((el.grid.col - 9.5) * SPACING, 0, (el.grid.row - 6.2) * SPACING)
    mesh.scale.y = 0.001
    mesh.userData.index = i
    root!.add(mesh)
    const rec: CubeRec = { mesh, el, baseColor: color }
    cubes.push(rec)
    cubeMeshes.push(mesh)
    cubeByNumber.set(el.number, rec)
  })

  buildAxes()
  buildPlate()

  // 随选中元素变化的文本不进缓存（每帧可能更新，必须自己持有并释放）
  selectionLabel = makeLabel('', { size: 0.5, padding: 12 }, { cache: false })
  selectionLabel.visible = false
  root!.add(selectionLabel)

  stylesDirty = true
}

/** 周期号 / 族号地面标注 */
function buildAxes() {
  if (!root) return
  axesGroup = new THREE.Group()
  const style = {
    size: 0.44,
    color: '#ffffff',
    background: 'rgba(12,16,32,0.62)',
    border: 'rgba(255,255,255,0.2)',
  }

  for (let g = 1; g <= 18; g++) {
    const s = makeLabel(String(g), style)
    s.position.set((g - 9.5) * SPACING, 0.02, (2 - 6.2 - 0.85) * SPACING)
    axesGroup.add(s)
  }
  for (let p = 1; p <= 7; p++) {
    const s = makeLabel(`第${p}周期`, { ...style, size: 0.36 })
    s.position.set((1 - 9.5 - 0.85) * SPACING, 0.02, (p + 1 - 6.2) * SPACING)
    axesGroup.add(s)
  }
  const la = makeLabel('镧系', { ...style, size: 0.36 })
  la.position.set((3 - 9.5 - 0.85) * SPACING, 0.02, (10 - 6.2) * SPACING)
  axesGroup.add(la)
  const ac = makeLabel('锕系', { ...style, size: 0.36 })
  ac.position.set((3 - 9.5 - 0.85) * SPACING, 0.02, (11 - 6.2) * SPACING)
  axesGroup.add(ac)

  axesGroup.visible = labelsOn.value
  root.add(axesGroup)
}

function buildPlate() {
  if (!root) return
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(21, 13.5),
    new THREE.MeshStandardMaterial({
      color: 0x8899bb,
      transparent: true,
      opacity: 0.14,
      roughness: 0.9,
      depthWrite: false,
    }),
  )
  plate.rotation.x = -Math.PI / 2
  plate.position.set(0, -0.01, 0)
  plate.raycast = () => {}
  root.add(plate)

  const grid = new THREE.GridHelper(21, 21, 0x8899bb, 0x8899bb)
  const gm = grid.material as THREE.Material
  gm.opacity = 0.12
  gm.transparent = true
  grid.position.y = 0
  grid.raycast = () => {}
  root.add(grid)
}

/* ================= 渲染循环 ================= */
function tick() {
  raf = requestAnimationFrame(tick)
  if (!renderer || !scene || !camera || !controls) return

  const now = performance.now()
  const dt = Math.min(0.05, (now - lastFrame) / 1000)
  lastFrame = now
  if (dt <= 0) return

  perfGuard?.update(dt)
  if (!visible || contextLost.value) return

  if (!heightsSettled) updateHeights(dt)
  if (stylesDirty) applyStyles()

  if (pointerDirty && pointerInside && !dragging) {
    pointerDirty = false
    updateHoverFromPointer()
  }

  if (focusTo && desiredCam) {
    const done =
      controls.target.distanceTo(focusTo) < 0.02 && camera.position.distanceTo(desiredCam) < 0.05
    const k = 0.14
    controls.target.lerp(focusTo, k)
    camera.position.lerp(desiredCam, k)
    if (done) {
      controls.target.copy(focusTo)
      camera.position.copy(desiredCam)
      focusTo = null
      desiredCam = null
    }
  }

  controls.autoRotate = autoRotate.value && !focusTo
  controls.update()
  updateSelectionLabel()
  renderer.render(scene, camera)
}

let selectionText = ''
let selectionAspect = 1

function updateSelectionLabel() {
  if (!selectionLabel || !camera) return
  // 悬浮标注跟随「当前聚焦元素」：优先 3D 内点击拾取，其次全局选中
  const n = picked.value?.number ?? props.selected
  const rec = n ? cubeByNumber.get(n) : undefined
  if (!rec) {
    if (selectionLabel.visible) {
      selectionLabel.visible = false
      selectionText = ''
    }
    return
  }
  selectionLabel.visible = labelsOn.value
  selectionLabel.position.set(
    rec.mesh.position.x,
    Math.max(0.6, rec.mesh.scale.y) + 0.45,
    rec.mesh.position.z,
  )
  // 只在文本真正变化时才重建贴图，避免每帧都画一张 canvas
  const text = `${rec.el.number} ${rec.el.name} · ${rec.el.symbol}`
  if (text !== selectionText) {
    selectionText = text
    selectionAspect = setLabelText(selectionLabel, text, { size: 0.5, padding: 12 }, { cache: false })
  }
  /**
   * 世界空间 Sprite 会随距离变小，靠近聚焦时（距离 6.4）又显得巨大。
   * 按相机到标注的距离做补偿缩放，近处收小、远处放大，视觉尺寸保持稳定。
   */
  const dist = camera.position.distanceTo(selectionLabel.position)
  const s = 0.46 * THREE.MathUtils.clamp(dist / 10, 0.55, 1.6)
  selectionLabel.scale.set(s * selectionAspect, s, 1)
}

/* ================= 拾取 ================= */
function pickAt(ev: PointerEvent): ElementInfo | null {
  const host = container.value
  if (!host || !camera || cubeMeshes.length === 0) return null
  const rect = host.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointerNdc, camera)
  const hits = raycaster.intersectObjects(cubeMeshes, false)
  if (!hits.length) return null
  const idx = hits[0].object.userData.index as number | undefined
  return idx == null ? null : ELEMENTS[idx] ?? null
}

function updateHoverFromPointer() {
  if (!lastPointer) return
  const next = pickAt(lastPointer)
  if (next?.number !== hovered.value?.number) {
    hovered.value = next
    stylesDirty = true
  }
  const host = container.value
  if (host) {
    const rect = host.getBoundingClientRect()
    tipPos.value = { x: lastPointer.clientX - rect.left, y: lastPointer.clientY - rect.top }
    tipFlip.value = tipPos.value.x > rect.width - 230
  }
}

/**
 * 只处理真正落在画布上的指针事件。
 *
 * 详情卡是画布容器内部的覆盖层，若不过滤，点击卡片上的「上一个 / 下一个」
 * 会先被容器的 pointerup 拾取逻辑吃掉（命中空白 → 清空选中 → 卡片消失），
 * 浏览器随后再也找不到按钮节点，click 处理函数根本不会执行 —— 表现为按钮失效。
 */
function fromCanvas(ev: PointerEvent): boolean {
  const canvas = renderer?.domElement
  return !!canvas && ev.target === canvas
}

function onPointerMove(ev: PointerEvent) {
  if (!fromCanvas(ev)) {
    if (hovered.value) {
      hovered.value = null
      stylesDirty = true
    }
    return
  }
  lastPointer = ev
  pointerInside = true
  pointerDirty = true
}

function onPointerLeave() {
  pointerInside = false
  lastPointer = null
  if (hovered.value) {
    hovered.value = null
    stylesDirty = true
  }
}

function onPointerDown(ev: PointerEvent) {
  if (!fromCanvas(ev)) return
  downPos = { x: ev.clientX, y: ev.clientY }
  dragging = true
}

/**
 * 点击落点决定相机去向：
 *  - 命中立方体 → 平滑聚焦到该元素，卡片跟着弹出
 *  - 未命中任何东西（空白区域）→ 收起卡片，同时把相机拉回周期表中心视角
 * 原先「⌖ 回到中心 / ⤾ 重置视角」两个按钮的职责，已由后者统一承担。
 */
function onPointerUp(ev: PointerEvent) {
  dragging = false
  if (!fromCanvas(ev)) return
  if (Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) > 6) return
  const el = pickAt(ev)
  if (!el) {
    if (picked.value) {
      picked.value = null
      stylesDirty = true
    }
    resetView()
    return
  }
  // 再次点击同一元素则收起卡片（相机仍停在该元素上）
  picked.value = picked.value?.number === el.number ? null : el
  stylesDirty = true
  focusElement(el.number)
}

/* ================= 导航 ================= */
function resolveJump(raw: string): ElementInfo | null {
  const t = raw.trim().toLowerCase()
  if (!t) return null
  const exact = ELEMENTS.find(
    (e) =>
      String(e.number) === t ||
      e.symbol.toLowerCase() === t ||
      e.name === t ||
      e.enName.toLowerCase() === t,
  )
  if (exact) return exact
  return (
    ELEMENTS.find(
      (e) =>
        e.symbol.toLowerCase().startsWith(t) ||
        e.enName.toLowerCase().includes(t) ||
        e.name.includes(t),
    ) ?? null
  )
}

function focusElement(n: number) {
  const rec = cubeByNumber.get(n)
  if (!rec || !camera || !controls) return
  const p = rec.mesh.position
  focusTo = new THREE.Vector3(p.x, Math.max(0.5, rec.mesh.scale.y * 0.35), p.z)
  const dir = camera.position.clone().sub(controls.target)
  if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1)
  dir.normalize()
  dir.y = Math.max(dir.y, 0.45)
  dir.normalize()
  desiredCam = focusTo.clone().add(dir.multiplyScalar(6.4))
}

function doJump() {
  const el = resolveJump(jumpText.value)
  if (!el) {
    jumpError.value = '未找到匹配的元素'
    return
  }
  jumpError.value = ''
  jumpText.value = ''
  picked.value = el
  stylesDirty = true
  focusElement(el.number)
}

/** 当前导航基准：3D 内点击选中的 > 全局选中的 > 氢（1 号） */
const currentNumber = computed(() => picked.value?.number ?? props.selected ?? 1)

/**
 * 按原子序数前后切换。
 * 到达首尾（1 / 118）时不再前进，按钮同时置灰，不做循环跳转，
 * 免得从 118 一下子跳回 1 让人以为出了错。
 */
function step(dir: -1 | 1) {
  const next = ELEMENT_BY_NUMBER[currentNumber.value + dir]
  if (!next) return
  picked.value = next
  stylesDirty = true
  focusElement(next.number)
}

function closeCard() {
  picked.value = null
  stylesDirty = true
}

function toggleLabels() {
  labelsOn.value = !labelsOn.value
  if (axesGroup) axesGroup.visible = labelsOn.value
  if (selectionLabel) selectionLabel.visible = labelsOn.value && !!(props.selected || picked.value)
}

/** 俯瞰整个周期表时的基准机位：目标点落在底盘中心，保证「中心」稳定 */
const HOME_TARGET = new THREE.Vector3(0, 0.6, 0)
const HOME_CAM = new THREE.Vector3(0, 13, 17)

/** 平滑飞向指定机位（tick 中逐帧插值）；用户一旦操作即被取消 */
function flyTo(target: THREE.Vector3, cam: THREE.Vector3) {
  if (!camera || !controls) return
  focusTo = target
  desiredCam = cam
}

/**
 * 复位到周期表中心。
 * 逐个切换元素会把轨道中心移到元素身上，这里把 target 与相机一起拉回基准机位，
 * 保证任何时候都能回到「整张表居中」的视角 —— 由点击空白区域触发。
 */
function resetView() {
  flyTo(HOME_TARGET.clone(), HOME_CAM.clone())
}

function topView() {
  flyTo(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 22, 0.4))
}

function resize() {
  const host = container.value
  if (!host || !renderer || !camera) return
  const w = host.clientWidth
  const h = host.clientHeight
  if (!w || !h) return
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

/* ================= 详情卡数据 ================= */
const card = computed(() => {
  const el = picked.value
  if (!el) return null
  const rows = [
    ['相对原子质量', String(el.mass)],
    ['常温状态', PHASE_LABEL[el.phase]],
    ['密度', el.density == null ? '—' : `${el.phase === 'gas' ? `${(el.density * 1000).toFixed(3)} g/L` : `${el.density} g/cm³`}`],
    ['熔点', el.melting == null ? '—' : `${el.melting} K`],
    ['沸点', el.boiling == null ? '—' : `${el.boiling} K`],
    ['电负性', el.electronegativity == null ? '—' : String(el.electronegativity)],
    ['原子半径', el.radius == null ? '—' : `${el.radius} pm`],
    ['第一电离能', el.ionization == null ? '—' : `${el.ionization} eV`],
    ['各层电子数', el.shells.join(' · ')],
    ['族 / 周期 / 区', `${el.group == null ? '—' : `第 ${el.group} 族`} · 第 ${el.period} 周期 · ${el.block} 区`],
  ]
  return {
    el,
    meta: CATEGORY_MAP[el.category],
    /** 电子排布（上标排版），独立成块展示，避免挤在一行里被截断 */
    config: formatConfig(el.electronConfig),
    discovered: el.discovered,
    rows,
    uses: el.uses.slice(0, 3),
    metricLabel: currentMetric().label,
    metricValue: currentMetric().get(el),
    metricUnit: currentMetric().unit,
  }
})

/* ================= 生命周期 ================= */
function onContextLost(ev: Event) {
  ev.preventDefault()
  contextLost.value = true
  cancelAnimationFrame(raf)
}

function reboot() {
  shutdown()
  contextLost.value = false
  boot()
}

function boot() {
  const host = container.value
  if (!host) return
  try {
    if (!detectWebGL()) throw new Error('当前环境不支持 WebGL')

    renderer = createRenderer(host)
    perfGuard = new PerfGuard(renderer, Math.min(window.devicePixelRatio || 1, 2))

    scene = new THREE.Scene()
    root = new THREE.Group()
    scene.add(root)

    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300)
    camera.position.set(0, 13, 17)

    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.target.set(0, 0.6, 0)
    controls.minDistance = 3
    controls.maxDistance = 70
    controls.maxPolarAngle = Math.PI * 0.495
    controls.maxTargetRadius = 16
    controls.autoRotateSpeed = 0.7
    // 用户一上手（旋转 / 缩放 / 平移 / 点击）就取消正在进行的镜头飞行，避免打架
    controls.addEventListener('start', () => {
      dragging = true
      focusTo = null
      desiredCam = null
    })
    controls.addEventListener('end', () => (dragging = false))

    scene.add(new THREE.HemisphereLight(0xffffff, 0x223355, 1.35))
    const dir = new THREE.DirectionalLight(0xffffff, 1.5)
    dir.position.set(6, 14, 10)
    scene.add(dir)
    const dir2 = new THREE.DirectionalLight(0x88aaff, 0.6)
    dir2.position.set(-8, 6, -10)
    scene.add(dir2)

    computeTargets()
    buildCubes()
    resize()
    building.value = false

    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerleave', onPointerLeave)
    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)

    resizeObs = new ResizeObserver(() => resize())
    resizeObs.observe(host)

    ioObs = new IntersectionObserver((entries) => (visible = entries.some((e) => e.isIntersecting)), {
      threshold: 0.01,
    })
    ioObs.observe(host)

    lastFrame = performance.now()
    exposeDebug('__EC_CUBE__', renderer)
    exposeDebug('__EC_CUBE_DBG__', { camera: () => camera, controls: () => controls })
    tick()
  } catch {
    supported.value = false
    building.value = false
  }
}

function shutdown() {
  cancelAnimationFrame(raf)
  raf = 0
  const host = container.value
  if (host) {
    host.removeEventListener('pointermove', onPointerMove)
    host.removeEventListener('pointerleave', onPointerLeave)
    host.removeEventListener('pointerdown', onPointerDown)
    host.removeEventListener('pointerup', onPointerUp)
  }
  renderer?.domElement.removeEventListener('webglcontextlost', onContextLost)

  resizeObs?.disconnect()
  resizeObs = null
  ioObs?.disconnect()
  ioObs = null

  controls?.dispose()
  controls = null

  if (root) {
    disposeSubtree(root)
    scene?.remove(root)
  }
  root = null
  if (boxGeo) {
    boxGeo.dispose()
    boxGeo = null
  }
  cubes.length = 0
  cubeMeshes.length = 0
  cubeByNumber.clear()
  axesGroup = null
  selectionLabel = null
  selectionText = ''

  teardownRenderer(renderer, host)
  exposeDebug('__EC_CUBE__', null)
  exposeDebug('__EC_CUBE_DBG__', null)
  renderer = null
  scene = null
  camera = null
  perfGuard = null
}

onMounted(boot)
onBeforeUnmount(shutdown)

watch(metricKey, () => computeTargets())
watch(
  () => props.selected,
  () => (stylesDirty = true),
)
watch(
  () => props.hit,
  () => (stylesDirty = true),
  { deep: false },
)
watch(
  () => props.filterActive,
  () => (stylesDirty = true),
)
</script>

<template>
  <div class="cube-wrap">
    <div class="cube-toolbar">
      <label class="metric">
        <span>柱高映射</span>
        <select v-model="metricKey" aria-label="选择柱高映射的属性">
          <option v-for="m in METRICS" :key="m.key" :value="m.key">{{ m.label }}</option>
        </select>
      </label>
      <button class="mini" :class="{ on: autoRotate }" @click="autoRotate = !autoRotate">
        {{ autoRotate ? '⟳ 自动旋转' : '⏸ 暂停旋转' }}
      </button>
      <button class="mini" :class="{ on: labelsOn }" @click="toggleLabels">
        {{ labelsOn ? '🏷 标注已开' : '🏷 标注已关' }}
      </button>
      <button class="mini" @click="topView">▣ 俯视</button>
    </div>

    <div class="nav-bar">
      <button
        class="mini step"
        :disabled="currentNumber <= 1"
        :title="currentNumber <= 1 ? '已经是 1 号氢' : `切换到 ${currentNumber - 1} 号`"
        @click="step(-1)"
      >
        ← 上一个
      </button>
      <form class="jump" @submit.prevent="doJump">
        <input
          v-model="jumpText"
          type="search"
          placeholder="跳转：Fe / 铁 / iron / 26"
          aria-label="跳转到元素"
          autocomplete="off"
          @input="jumpError = ''"
        />
        <button type="submit" aria-label="跳转">定位</button>
      </form>
      <button
        class="mini step"
        :disabled="currentNumber >= 118"
        :title="currentNumber >= 118 ? '已经是 118 号 Og' : `切换到 ${currentNumber + 1} 号`"
        @click="step(1)"
      >
        下一个 →
      </button>
    </div>
    <p v-if="jumpError" class="jump-error">{{ jumpError }}</p>

    <div
      ref="container"
      class="canvas-host"
      :class="{ grab: !hovered, picking: !!hovered }"
    >
      <div v-if="!supported" class="fallback">当前环境不支持 WebGL，无法渲染 3D 周期表。</div>
      <div v-else-if="contextLost" class="fallback">
        渲染上下文已丢失。<br /><button class="retry" @click="reboot">↻ 重新渲染</button>
      </div>
      <div v-else-if="building" class="fallback">正在构建 3D 周期表…</div>

      <div class="hint">
        拖拽旋转 · 滚轮 / 双指缩放 · 右键平移 · 点击方块聚焦到该元素并查看详情 · 点击空白处回到中心视角{{
          filterActive ? ` · 当前筛选命中 ${hit.size} 种` : ''
        }}
      </div>

      <div
        v-if="hovered && !card"
        class="tip"
        :style="{
          left: (tipFlip ? tipPos.x - 14 : tipPos.x + 14) + 'px',
          top: tipPos.y + 14 + 'px',
          transform: tipFlip ? 'translateX(-100%)' : 'none',
        }"
      >
        <strong>{{ hovered.number }} {{ hovered.name }}</strong>
        <span>{{ hovered.symbol }} · {{ CATEGORY_MAP[hovered.category].label }}</span>
        <span v-if="currentMetric().get(hovered) != null">
          {{ currentMetric().label }}：{{ currentMetric().get(hovered)
          }}{{ currentMetric().unit }}
        </span>
      </div>

      <Transition name="card">
        <aside v-if="card" class="cube-card" :style="{ '--c': card.meta.color }">
          <button class="card-close" aria-label="关闭详情卡" @click="closeCard">✕</button>

          <div class="card-scroll">
            <div class="card-head">
              <span class="card-sym">{{ card.el.symbol }}</span>
              <div class="card-titles">
                <strong>{{ card.el.name }}</strong>
                <span class="card-en">{{ card.el.enName }}</span>
              </div>
              <span class="card-num">{{ card.el.number }}</span>
            </div>
            <div class="card-chips">
              <span class="card-chip">{{ card.meta.label }}</span>
              <span class="card-chip">{{ card.discovered }}</span>
            </div>
            <div class="card-config">
              <span>电子排布</span>
              <b>{{ card.config }}</b>
            </div>
            <dl class="card-rows">
              <div v-for="r in card.rows" :key="r[0]" class="card-row">
                <dt>{{ r[0] }}</dt>
                <dd>{{ r[1] }}</dd>
              </div>
            </dl>
            <div class="card-metric">
              <span>当前柱高映射</span>
              <b>{{ card.metricLabel }}：{{ card.metricValue ?? '无数据' }}{{ card.metricUnit }}</b>
            </div>
            <div class="card-uses">
              <span class="u-label">主要用途</span>
              <ul>
                <li v-for="u in card.uses" :key="u">{{ u }}</li>
              </ul>
            </div>
          </div>

          <!-- 操作区固定在卡片底部：内容再长也不会把按钮挤出可视区 -->
          <div class="card-foot">
            <button class="primary" @click="emit('open', card.el)">查看完整资料 →</button>
            <div class="card-nav">
              <button :disabled="currentNumber <= 1" @click="step(-1)">← 上一个</button>
              <button :disabled="currentNumber >= 118" @click="step(1)">下一个 →</button>
            </div>
          </div>
        </aside>
      </Transition>
    </div>

    <div class="cube-legend">
      <span v-for="c in CATEGORIES" :key="c.key" class="lg">
        <i :style="{ background: c.color }"></i>{{ c.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.cube-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cube-toolbar,
.nav-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.nav-bar {
  gap: 6px;
}

.metric {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-dim);
}

.metric select {
  font: inherit;
  padding: 6px 10px;
  border-radius: 9px;
  color: var(--text);
  background: var(--surface-solid);
  border: 1px solid var(--border);
  cursor: pointer;
}

.mini {
  padding: 7px 12px;
  font-size: 12.5px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-dim);
  transition: all 0.2s ease;
  white-space: nowrap;
}

.mini:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.mini.on {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.mini:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.jump {
  display: flex;
  flex: 1 1 220px;
  min-width: 0;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-solid);
  overflow: hidden;
}

.jump:focus-within {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}

.jump input {
  flex: 1;
  min-width: 0;
  padding: 0 10px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
}

.jump input::placeholder {
  color: var(--text-faint);
}

.jump button {
  padding: 0 12px;
  font-size: 12.5px;
  color: var(--accent);
  border-left: 1px solid var(--border);
  background: var(--surface-2);
  white-space: nowrap;
}

.jump-error {
  font-size: 11.5px;
  color: #ff6b6b;
  margin: -4px 0 0;
}

.canvas-host {
  position: relative;
  width: 100%;
  height: clamp(380px, 58vh, 620px);
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: radial-gradient(circle at 50% 30%, rgba(79, 124, 255, 0.14), transparent 60%),
    var(--surface-2);
  touch-action: none;
  cursor: grab;
}

.canvas-host.picking {
  cursor: pointer;
}

.canvas-host :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
  outline: none;
  cursor: inherit !important;
}

.fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 10px;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
  background: var(--surface-solid);
}

.retry {
  justify-self: center;
  padding: 6px 14px;
  font-size: 12.5px;
  border-radius: 9px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
}

.hint {
  position: absolute;
  left: 12px;
  bottom: 10px;
  z-index: 2;
  font-size: 11px;
  color: var(--text-faint);
  pointer-events: none;
}

.tip {
  position: absolute;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 11px;
  border-radius: 10px;
  font-size: 12px;
  color: var(--text);
  background: var(--surface-solid);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow);
  pointer-events: none;
  white-space: nowrap;
}

.tip strong {
  font-size: 13px;
}

.tip span {
  color: var(--text-dim);
  font-size: 11.5px;
}

/* ---- 元素详情卡 ---- */
.cube-card {
  position: absolute;
  z-index: 4;
  top: 12px;
  right: 12px;
  width: min(300px, 62%);
  max-height: calc(100% - 24px);
  display: flex;
  flex-direction: column;
  padding: 13px 14px 12px;
  border-radius: 14px;
  background: var(--surface-solid);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-lg);
}

/* 资料区独立滚动，底部操作栏始终可见 —— 内容再长也不会把导航按钮顶出可视区 */
.card-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.card-foot {
  flex: 0 0 auto;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  margin-top: 8px;
}

.card-close {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 11px;
  display: grid;
  place-items: center;
  color: var(--text-faint);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.card-close:hover {
  color: var(--text);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 24px;
}

.card-sym {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  border-radius: 11px;
  display: grid;
  place-items: center;
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  background: var(--c);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--c) 34%, transparent);
}

.card-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.card-titles strong {
  font-size: 17px;
  line-height: 1.2;
}

.card-en {
  font-size: 11.5px;
  color: var(--text-dim);
}

.card-num {
  margin-left: auto;
  font-size: 13px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.card-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 8px;
}

.card-chip {
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 99px;
  border: 1px solid color-mix(in srgb, var(--c) 38%, transparent);
  background: color-mix(in srgb, var(--c) 12%, transparent);
  color: color-mix(in srgb, var(--c) 62%, var(--text));
}

.card-config {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0 0 8px;
  padding: 8px 9px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--c) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--c) 30%, transparent);
}

.card-config span {
  font-size: 11px;
  color: var(--text-dim);
}

.card-config b {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--text);
  word-break: break-word;
  font-variant-numeric: tabular-nums;
}

.card-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--border);
}

.card-row:last-child {
  border-bottom: none;
}

.card-row dt {
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: nowrap;
}

.card-row dd {
  margin: 0;
  font-size: 12px;
  color: var(--text);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.card-metric {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding: 7px 9px;
  border-radius: 9px;
  font-size: 11.5px;
  color: var(--text-dim);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.card-metric b {
  font-size: 12px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.card-uses {
  margin-top: 10px;
}

.u-label {
  font-size: 11.5px;
  color: var(--text-dim);
}

.card-uses ul {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.card-uses li {
  position: relative;
  padding-left: 13px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-dim);
}

.card-uses li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 7px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--c);
}

.primary {
  width: 100%;
  padding: 9px;
  font-size: 12.5px;
  border-radius: 10px;
  color: #fff;
  background: var(--c);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--c) 32%, transparent);
  transition: filter 0.18s ease;
}

.primary:hover {
  filter: brightness(1.08);
}

.card-nav {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.card-nav button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.card-nav button {
  flex: 1;
  padding: 7px;
  font-size: 11.5px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-dim);
}

.card-nav button:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
}

.card-nav button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.card-enter-active,
.card-leave-active {
  transition: opacity 0.2s ease, transform 0.24s cubic-bezier(0.22, 0.9, 0.28, 1);
}

.card-enter-from,
.card-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.97);
}

.cube-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.lg i {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
}

@media (max-width: 760px) {
  .cube-card {
    top: auto;
    bottom: 12px;
    left: 12px;
    right: 12px;
    width: auto;
    max-height: 62%;
  }

  .nav-bar {
    width: 100%;
  }

  .step {
    flex: 0 0 auto;
    padding: 7px 10px;
    font-size: 12px;
  }
}
</style>
