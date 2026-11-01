<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { massNumber, type ElementInfo } from '../data/elements'
import {
  NUCLEON_CAP,
  nucleonLayout,
  nucleonRadius,
} from '../three/nucleus'
import {
  PerfGuard,
  createRenderer,
  detectWebGL,
  disposeSubtree,
  exposeDebug,
  teardownRenderer,
} from '../three/gl'
import { makeLabel } from '../three/label'

const props = defineProps<{
  element: ElementInfo
  color: string
}>()

const SHELL_LETTERS = ['K', 'L', 'M', 'N', 'O', 'P', 'Q']

/* ---------------- 视图状态 ---------------- */
const container = ref<HTMLDivElement | null>(null)
const supported = ref(true)
const failed = ref('')
const contextLost = ref(false)
const autoRotate = ref(true)
const labelsOn = ref(true)
const ready = ref(false)

type PickTarget = { kind: 'nucleus' } | { kind: 'shell'; index: number }
const picked = ref<PickTarget | null>(null)
const hovered = ref<PickTarget | null>(null)

/* ---------------- three 运行时 ---------------- */
interface ShellRec {
  group: THREE.Group
  ring: THREE.Mesh
  ringProxy: THREE.Mesh
  electrons: THREE.InstancedMesh
  label: THREE.Sprite
  radius: number
  count: number
  speed: number
}

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let content: THREE.Group | null = null
let modelRoot: THREE.Group | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let pointLight: THREE.PointLight | null = null
let nucleusGlow: THREE.Mesh | null = null
let nucleusLabel: THREE.Sprite | null = null

let shellRecs: ShellRec[] = []
let pickables: THREE.Object3D[] = []
let raf = 0
let resizeObs: ResizeObserver | null = null
let ioObs: IntersectionObserver | null = null
let perfGuard: PerfGuard | null = null
let visible = true
let dragging = false
/** 只在可见时累加，避免元素 ping-pong 导致电子瞬间跳位 */
let simTime = 0
let lastFrame = 0
/** 模型最外层半径，用于相机自动构图 */
let modelRadius = 6
/** 原子核半径，用于推导「不能穿进核里」的缩放下限 */
let nucleusRadius = 0.4
/** 最近一次建模的核子统计，调试脚本用 */
const nucleusInfo = { A: 0, drawn: 0, nucleon: 0, radius: 0 }
let desiredDistance = 14
let userZoom = 1
/** 缩放上下限：下限保证不穿进原子核，上限保证模型不会缩成一粒 */
let zoomMin = 0.9
let zoomMax = 60
/**
 * 平滑过渡的目标距离；null 表示不干预相机距离。
 *
 * 之前这里无条件把相机距离拉回 desiredDistance，
 * 而滚轮缩放只是瞬间触发 OrbitControls 的 start/end，下一帧 dragging 就变回 false，
 * 于是刚滚出来的缩放立刻被拉回去 —— 表现为「滚轮无法缩放」。
 */
let distanceAnim: number | null = null

const tmpMatrix = new THREE.Object3D()
/** 电子专用：核子实例会写 scale，混用会把电子也放大成核子大小 */
const tmpElectron = new THREE.Object3D()
const raycaster = new THREE.Raycaster()
const pointerNdc = new THREE.Vector2()
let pointerInside = false
let pointerDirty = false
let downPos = { x: 0, y: 0 }

/* ---------------- 拾取信息卡 ---------------- */
const pickCard = computed(() => {
  const p = picked.value
  if (!p) return null
  const el = props.element

  if (p.kind === 'nucleus') {
    const A = Math.max(1, massNumber(el))
    const N = Math.max(0, A - el.number)
    const drawn = Math.min(A, NUCLEON_CAP)
    return {
      title: '原子核',
      sub: `${el.symbol} · 由 ${A} 个核子组成${drawn < A ? `（示意绘制 ${drawn} 个）` : ''}`,
      rows: [
        ['质子数 Z', String(el.number)],
        ['中子数 N', String(N)],
        ['质量数 A', String(A)],
        ['中子 / 质子比', (N / Math.max(1, el.number)).toFixed(2)],
      ],
    }
  }

  const i = p.index
  const n = i + 1
  const cap = 2 * n * n
  const c = el.shells[i] ?? 0
  const isOuter = i === el.shells.length - 1
  return {
    title: `${SHELL_LETTERS[i] ?? n} 电子层`,
    sub: `主量子数 n = ${n}`,
    rows: [
      ['该层电子数', `${c} e⁻`],
      ['最大容量', `${cap} e⁻（2n²）`],
      ['填充程度', `${Math.round((c / cap) * 100)}%`],
      ['层类型', isOuter ? '最外层（价层）' : '内层'],
    ],
  }
})

/* ---------------- 建模 ---------------- */
function disposeModel() {
  if (!modelRoot) return
  disposeSubtree(modelRoot)
  content?.remove(modelRoot)
  modelRoot = null
  shellRecs = []
  pickables = []
  nucleusGlow = null
  nucleusLabel = null
}

function buildModel() {
  const el = props.element
  if (!scene || !content) return

  disposeModel()

  const root = new THREE.Group()
  content.add(root)
  modelRoot = root

  const accent = new THREE.Color(props.color)
  pointLight?.color.copy(accent)

  const A = Math.max(1, massNumber(el))
  const Z = el.number
  const N = Math.max(0, A - Z)

  /* ---- 原子核 ----
   * 排布（间距 / 半径 / 居中）全部由 nucleus.ts 决定：
   * 先在单位空间里 packing 出不重叠且紧凑的一簇，再按「随核子数平滑收敛」的
   * 核子半径整体缩放 —— 从 1 个核子到 300 个核子都不会松散或偏心。 */
  const layout = nucleonLayout(A)
  const drawCount = layout.count
  const nucleonR = nucleonRadius(drawCount)
  nucleusRadius = layout.bound * nucleonR
  nucleusInfo.A = A
  nucleusInfo.drawn = drawCount
  nucleusInfo.nucleon = nucleonR
  nucleusInfo.radius = nucleusRadius

  // 核子少时球面细分高一些（单个质子的轮廓要圆润），核子多时降面数省开销
  const seg = drawCount <= 12 ? 20 : drawCount <= 48 ? 14 : 10
  const nucleonGeo = new THREE.SphereGeometry(1, seg, Math.max(6, Math.round(seg * 0.7)))

  const protonMat = new THREE.MeshStandardMaterial({
    color: '#ff5b6e',
    emissive: new THREE.Color('#ff5b6e').multiplyScalar(0.35),
    roughness: 0.35,
    metalness: 0.05,
  })
  const neutronMat = new THREE.MeshStandardMaterial({
    color: '#4d7cff',
    emissive: new THREE.Color('#4d7cff').multiplyScalar(0.3),
    roughness: 0.45,
    metalness: 0.05,
  })

  // 实际绘制的质子 / 中子数（按真实比例分摊到 drawCount 个核子上）
  const zDrawn = THREE.MathUtils.clamp(Math.round((drawCount * Z) / A), 0, drawCount)
  const nDrawn = drawCount - zDrawn
  const protons = new THREE.InstancedMesh(nucleonGeo, protonMat, Math.max(1, zDrawn))
  const neutrons = new THREE.InstancedMesh(nucleonGeo, neutronMat, Math.max(1, nDrawn))
  protons.count = 0
  neutrons.count = 0

  // 单位空间坐标 × 核子半径 = 实际坐标，实例缩放同样是核子半径
  // （等比缩放不会破坏 packing 保证的最小间距，因此核子恒不重叠）
  tmpMatrix.scale.setScalar(nucleonR)
  for (let i = 0; i < drawCount; i++) {
    tmpMatrix.position.set(
      layout.positions[i * 3] * nucleonR,
      layout.positions[i * 3 + 1] * nucleonR,
      layout.positions[i * 3 + 2] * nucleonR,
    )
    tmpMatrix.updateMatrix()

    // 累计取整：恰好取到 zDrawn 个质子，且沿簇内顺序均匀交错，
    // 不会出现「质子全在内核、中子全在外壳」的错误观感
    const isProton = Math.floor(((i + 1) * zDrawn) / drawCount) > Math.floor((i * zDrawn) / drawCount)
    if (isProton) protons.setMatrixAt(protons.count++, tmpMatrix.matrix)
    else neutrons.setMatrixAt(neutrons.count++, tmpMatrix.matrix)
  }
  protons.instanceMatrix.needsUpdate = true
  neutrons.instanceMatrix.needsUpdate = true
  root.add(protons, neutrons)

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(nucleusRadius * 1.85, 20, 16),
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  root.add(glow)
  nucleusGlow = glow

  // 核的拾取代理：包住整个核（含核子间隙），保证任意角度都能点中。
  // 给一个下限，避免氢这种「只有一个质子」的核热区太小点不中
  const nucleusProxy = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(nucleusRadius * 1.1, 0.22), 16, 12),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  nucleusProxy.userData.pick = 'nucleus'
  root.add(nucleusProxy)
  pickables.push(nucleusProxy)

  // 随元素变化的文本不进缓存，否则浏览 118 个元素会累积上百张贴图
  const nLabel = makeLabel(
    `${Z}p⁺ · ${N}n⁰`,
    {
      size: 0.34,
      color: '#ffffff',
      background: 'rgba(12,16,32,0.7)',
      border: 'rgba(255,255,255,0.25)',
    },
    { cache: false },
  )
  // 标注贴在核的正上方，与核表面保持固定距离（核再大也不会压到核上）
  nLabel.position.set(0, nucleusRadius + 0.34, 0)
  nLabel.visible = labelsOn.value
  root.add(nLabel)
  nucleusLabel = nLabel

  /* ---- 电子层 ---- */
  const shells = el.shells
  // 核表面到 K 层的间隙随核增大而略微增大：小核不会显得空荡荡，大核也不会贴脸
  const FIRST_GAP = 0.62 + 0.3 * nucleusRadius
  const SPAN = 4.6
  const step = shells.length > 1 ? SPAN / (shells.length - 1) : 0
  // 共享电子几何体 / 材质，118 个电子只有一份 GPU 资源
  const electronGeo = new THREE.SphereGeometry(0.085, 10, 8)
  const electronMat = new THREE.MeshStandardMaterial({
    color: '#ffe27a',
    emissive: new THREE.Color('#ffd24a').multiplyScalar(0.9),
    roughness: 0.25,
    metalness: 0,
  })
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false })

  let outerRadius = nucleusRadius
  shells.forEach((count, i) => {
    const radius = nucleusRadius + FIRST_GAP + i * step
    outerRadius = Math.max(outerRadius, radius)

    const group = new THREE.Group()
    // 各层轨道倾角错开，避免所有圆环看起来重合成一个圆盘
    group.rotation.set(0.42 + i * 0.58, i * 0.92, i * 0.33)
    root.add(group)

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.008, 6, 96),
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    )
    group.add(ring)

    // 细环很难点中，配一根看不见的粗环做热区
    const ringProxy = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.13, 5, 40), proxyMat)
    ringProxy.userData.pick = `shell:${i}`
    group.add(ringProxy)
    pickables.push(ringProxy)

    const c = Math.max(1, count)
    const electrons = new THREE.InstancedMesh(electronGeo, electronMat, c)
    electrons.frustumCulled = false
    electrons.userData.pick = `shell:${i}`
    group.add(electrons)
    pickables.push(electrons)

    const label = makeLabel(
      `${SHELL_LETTERS[i] ?? i + 1} · ${count}e⁻`,
      {
        size: 0.3,
        color: '#ffffff',
        background: 'rgba(12,16,32,0.66)',
        border: 'rgba(255,255,255,0.22)',
      },
      { cache: false },
    )
    label.position.set(radius, 0.16, 0)
    label.visible = labelsOn.value
    group.add(label)

    shellRecs.push({ group, ring, ringProxy, electrons, label, radius, count: c, speed: 1.05 / Math.sqrt(i + 1) })
  })

  modelRadius = outerRadius + 0.5
  applyHighlight()
  refit(false)
}

/* ---------------- 高亮（仅在状态变化时执行） ---------------- */
function activeKind(t: PickTarget | null): string | null {
  if (!t) return null
  return t.kind === 'nucleus' ? 'nucleus' : `shell:${t.index}`
}

function applyHighlight() {
  const active = activeKind(picked.value)
  const hover = activeKind(hovered.value)

  const glowMat = nucleusGlow?.material as THREE.MeshBasicMaterial | undefined
  if (glowMat) glowMat.opacity = active === 'nucleus' ? 0.22 : hover === 'nucleus' ? 0.17 : 0.1

  shellRecs.forEach((s, i) => {
    const mat = s.ring.material as THREE.MeshBasicMaterial
    const k = `shell:${i}`
    mat.opacity = active === k ? 0.55 : hover === k ? 0.42 : 0.22
    s.label.material.opacity = active === k || hover === k ? 1 : 0.86
  })

  if (nucleusLabel) {
    nucleusLabel.material.opacity = active === 'nucleus' || hover === 'nucleus' ? 1 : 0.86
  }
}

/* ---------------- 相机 ---------------- */
function fitDistance(): number {
  if (!camera) return 14
  const vFov = THREE.MathUtils.degToRad(camera.fov)
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
  const fov = Math.min(vFov, hFov)
  return (modelRadius * 1.12) / Math.tan(fov / 2)
}

/**
 * 依据模型尺寸刷新缩放上下限。
 * 下限 = 核半径 × 2.2 + 余量，保证镜头停在核外（不会穿进核内部）；
 * 上限 = 适配距离 × 2.4，保证原子不会缩成看不清的一点。
 */
function updateZoomLimits() {
  if (!controls) return
  const fit = fitDistance()
  zoomMin = Math.max(0.9, nucleusRadius * 2.2 + 0.35)
  zoomMax = Math.max(zoomMin * 2, fit * 2.4)
  controls.minDistance = zoomMin
  controls.maxDistance = zoomMax
  controls.maxTargetRadius = modelRadius
}

/** 记录用户当前的缩放倍率（相对自动构图距离），窗口缩放后按比例还原 */
function syncUserZoom() {
  if (!camera || !controls) return
  const fit = fitDistance() || 1
  const d = camera.position.distanceTo(controls.target)
  userZoom = THREE.MathUtils.clamp(d / fit, 0.45, 2.2)
  desiredDistance = THREE.MathUtils.clamp(d, zoomMin, zoomMax)
}

/** 重新构图：保留用户当前的观察方向与缩放倍率，只调整距离 */
function refit(animated = true) {
  if (!camera || !controls) return
  updateZoomLimits()
  desiredDistance = THREE.MathUtils.clamp(fitDistance() * userZoom, zoomMin, zoomMax)
  if (animated) {
    distanceAnim = desiredDistance
    return
  }
  distanceAnim = null
  const dir = camera.position.clone().sub(controls.target)
  if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1)
  dir.normalize().multiplyScalar(desiredDistance)
  camera.position.copy(controls.target).add(dir)
}

function resetView() {
  if (!camera || !controls) return
  controls.target.set(0, 0, 0)
  userZoom = 1
  updateZoomLimits()
  desiredDistance = THREE.MathUtils.clamp(fitDistance(), zoomMin, zoomMax)
  distanceAnim = null
  // 固定一个略微俯视的方向，距离精确等于构图距离
  camera.position.copy(new THREE.Vector3(0, 0.45, 1).normalize().multiplyScalar(desiredDistance))
  controls.update()
}

function focusNucleus() {
  if (!camera || !controls) return
  controls.target.set(0, 0, 0)
  updateZoomLimits()
  const fit = fitDistance() || 1
  desiredDistance = THREE.MathUtils.clamp(Math.max(zoomMin, nucleusRadius * 3), zoomMin, zoomMax)
  userZoom = THREE.MathUtils.clamp(desiredDistance / fit, 0.45, 2.2)
  distanceAnim = desiredDistance
  picked.value = { kind: 'nucleus' }
  applyHighlight()
}

function toggleLabels() {
  labelsOn.value = !labelsOn.value
  if (nucleusLabel) nucleusLabel.visible = labelsOn.value
  for (const s of shellRecs) s.label.visible = labelsOn.value
}

/* ---------------- 渲染循环 ---------------- */
function tick() {
  raf = requestAnimationFrame(tick)
  if (!renderer || !scene || !camera || !controls) return

  const now = performance.now()
  const dt = Math.min(0.05, (now - lastFrame) / 1000)
  lastFrame = now
  if (dt <= 0) return

  perfGuard?.update(dt)

  if (!visible || contextLost.value) return

  simTime += dt

  tmpElectron.scale.setScalar(1)
  for (const shell of shellRecs) {
    for (let i = 0; i < shell.count; i++) {
      const a = simTime * shell.speed + (i / shell.count) * Math.PI * 2
      tmpElectron.position.set(Math.cos(a) * shell.radius, Math.sin(a) * shell.radius, 0)
      tmpElectron.updateMatrix()
      shell.electrons.setMatrixAt(i, tmpElectron.matrix)
    }
    shell.electrons.instanceMatrix.needsUpdate = true
  }

  if (nucleusGlow) nucleusGlow.rotation.y += dt * 0.12

  // 仅在「聚焦 / 重置 / 切换元素」时平滑过渡距离；用户自己滚轮缩放时完全不干预
  if (distanceAnim != null && !dragging) {
    const dir = camera.position.clone().sub(controls.target)
    const dist = dir.length() || 1e-6
    const next = THREE.MathUtils.lerp(dist, distanceAnim, 0.16)
    if (Math.abs(next - distanceAnim) < Math.max(0.01, distanceAnim * 0.002)) {
      dir.multiplyScalar(distanceAnim / dist)
      camera.position.copy(controls.target).add(dir)
      distanceAnim = null
    } else {
      dir.multiplyScalar(next / dist)
      camera.position.copy(controls.target).add(dir)
    }
  }
  controls.autoRotate = autoRotate.value
  controls.update()

  if (pointerDirty && pointerInside && !dragging) {
    pointerDirty = false
    updateHoverFromPointer()
  }

  renderer.render(scene, camera)
}

/* ---------------- 拾取 ---------------- */
function pickAt(ev: PointerEvent): PickTarget | null {
  const host = container.value
  if (!host || !camera || pickables.length === 0) return null
  const rect = host.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointerNdc, camera)
  const hits = raycaster.intersectObjects(pickables, false)
  if (!hits.length) return null
  const raw = hits[0].object.userData.pick as string | undefined
  if (!raw) return null
  if (raw === 'nucleus') return { kind: 'nucleus' }
  if (raw.startsWith('shell:')) return { kind: 'shell', index: Number(raw.slice(6)) }
  return null
}

let lastPointerEvent: PointerEvent | null = null

function updateHoverFromPointer() {
  if (!lastPointerEvent) return
  const next = pickAt(lastPointerEvent)
  const changed = activeKind(next) !== activeKind(hovered.value)
  hovered.value = next
  if (changed) applyHighlight()
}

function onPointerMove(ev: PointerEvent) {
  lastPointerEvent = ev
  pointerInside = true
  pointerDirty = true
}

function onPointerLeave() {
  pointerInside = false
  lastPointerEvent = null
  if (hovered.value) {
    hovered.value = null
    applyHighlight()
  }
}

function onPointerDown(ev: PointerEvent) {
  downPos = { x: ev.clientX, y: ev.clientY }
  dragging = true
}

function onPointerUp(ev: PointerEvent) {
  dragging = false
  const moved = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y)
  if (moved > 6) return
  const next = pickAt(ev)
  // 再次点击同一目标则收起卡片
  picked.value = activeKind(next) === activeKind(picked.value) ? null : next
  applyHighlight()
}

function clearPick() {
  picked.value = null
  applyHighlight()
}

/* ---------------- 尺寸 ---------------- */
function resize() {
  const host = container.value
  if (!host || !renderer || !camera) return
  const w = host.clientWidth
  const h = host.clientHeight
  if (!w || !h) return
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  refit(false)
}

/* ---------------- 上下文丢失恢复 ---------------- */
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

/* ---------------- 生命周期 ---------------- */
function boot() {
  const host = container.value
  if (!host) return
  try {
    if (!detectWebGL()) throw new Error('当前浏览器或设备未启用 WebGL')

    renderer = createRenderer(host)
    perfGuard = new PerfGuard(renderer, Math.min(window.devicePixelRatio || 1, 2))

    scene = new THREE.Scene()
    content = new THREE.Group()
    scene.add(content)

    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400)
    camera.position.set(0, 3, 14)

    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.panSpeed = 0.7
    controls.autoRotateSpeed = 1.0
    controls.minDistance = 0.9
    controls.maxDistance = 60
    controls.zoomSpeed = 0.9
    // 用户一上手就取消自动过渡，避免与手动缩放/旋转打架
    controls.addEventListener('start', () => {
      dragging = true
      distanceAnim = null
    })
    // 用户松手后记录当前缩放倍率，窗口尺寸变化时按比例还原
    controls.addEventListener('end', () => {
      dragging = false
      syncUserZoom()
    })

    scene.add(new THREE.HemisphereLight(0xffffff, 0x223355, 1.5))
    const dir = new THREE.DirectionalLight(0xffffff, 1.6)
    dir.position.set(4, 6, 8)
    scene.add(dir)
    pointLight = new THREE.PointLight(props.color, 40, 30)
    pointLight.position.set(0, 0, 0)
    scene.add(pointLight)

    buildModel()
    resetView()
    // 立即同步一次画布尺寸，避免首帧 aspect 错误导致模型被拉伸
    resize()

    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerleave', onPointerLeave)
    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)

    resizeObs = new ResizeObserver(() => resize())
    resizeObs.observe(host)

    // 面板滚动出视口时停止渲染，避免在后台白白占用 GPU
    ioObs = new IntersectionObserver((entries) => (visible = entries.some((e) => e.isIntersecting)), {
      threshold: 0.01,
    })
    ioObs.observe(host)

    lastFrame = performance.now()
    exposeDebug('__EC_ATOM__', renderer)
    exposeDebug('__EC_ATOM_DBG__', {
      camera: () => camera,
      controls: () => controls,
      limits: () => ({ min: zoomMin, max: zoomMax, fit: fitDistance(), radius: modelRadius }),
      nucleus: () => ({
        A: nucleusInfo.A,
        drawn: nucleusInfo.drawn,
        nucleon: nucleusInfo.nucleon,
        radius: nucleusInfo.radius,
      }),
    })
    ready.value = true
    tick()
  } catch (e) {
    failed.value = e instanceof Error ? e.message : 'WebGL 初始化失败'
    supported.value = false
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
  const canvas = renderer?.domElement
  if (canvas) canvas.removeEventListener('webglcontextlost', onContextLost)

  resizeObs?.disconnect()
  resizeObs = null
  ioObs?.disconnect()
  ioObs = null

  controls?.dispose()
  controls = null
  disposeModel()
  teardownRenderer(renderer, host)

  exposeDebug('__EC_ATOM__', null)
  exposeDebug('__EC_ATOM_DBG__', null)
  renderer = null
  scene = null
  content = null
  camera = null
  pointLight = null
  perfGuard = null
  ready.value = false
}

onMounted(boot)
onBeforeUnmount(shutdown)

watch(
  () => [props.element.number, props.color],
  () => {
    picked.value = null
    hovered.value = null
    if (!supported.value || contextLost.value) return
    buildModel()
  },
)

watch(labelsOn, (v) => {
  if (nucleusLabel) nucleusLabel.visible = v
  for (const s of shellRecs) s.label.visible = v
})
</script>

<template>
  <div class="atom">
    <div class="stage-wrap">
      <div
        ref="container"
        class="stage"
        :class="{ picking: !!hovered }"
      ></div>

      <div v-if="!supported" class="fallback">
        当前浏览器 / 设备无法启用 WebGL，3D 原子模型不可用。<br />
        <small>{{ failed }}</small>
      </div>

      <div v-else-if="contextLost" class="fallback">
        渲染上下文已丢失（常见于切换显卡或后台休眠）。<br />
        <button class="retry" @click="reboot">↻ 重新渲染</button>
      </div>

      <Transition name="pop">
        <div v-if="pickCard" class="pick-card">
          <button class="pick-close" aria-label="关闭信息卡" @click="clearPick">✕</button>
          <h4>{{ pickCard.title }}</h4>
          <p class="pick-sub">{{ pickCard.sub }}</p>
          <dl>
            <div v-for="r in pickCard.rows" :key="r[0]" class="pick-row">
              <dt>{{ r[0] }}</dt>
              <dd>{{ r[1] }}</dd>
            </div>
          </dl>
        </div>
      </Transition>

      <div class="stage-hint">拖拽旋转 · 滚轮 / 双指缩放 · 右键或双指拖动平移 · 点击核与电子层查看信息</div>
    </div>

    <div class="atom-bar">
      <button class="mini" :class="{ on: autoRotate }" @click="autoRotate = !autoRotate">
        {{ autoRotate ? '⟳ 自动旋转中' : '⏸ 自动旋转已暂停' }}
      </button>
      <button class="mini" :class="{ on: labelsOn }" @click="toggleLabels">
        {{ labelsOn ? '🏷 标注已开' : '🏷 标注已关' }}
      </button>
      <button class="mini" @click="focusNucleus">⊕ 聚焦原子核</button>
      <button class="mini" @click="resetView">⤾ 重置视角</button>
    </div>

    <div class="legend">
      <div class="legend-row">
        <span class="dot proton"></span>
        <span>质子 {{ element.number }}</span>
        <span class="dot neutron"></span>
        <span>中子 {{ Math.max(0, massNumber(element) - element.number) }}</span>
        <span class="dot electron"></span>
        <span>电子 {{ element.number }}</span>
      </div>
      <div class="shells">
        <button
          v-for="(c, i) in element.shells"
          :key="i"
          class="shell-chip"
          :class="{ on: picked && picked.kind === 'shell' && picked.index === i }"
          @click="picked = { kind: 'shell', index: i }; applyHighlight()"
        >
          {{ SHELL_LETTERS[i] || i + 1 }} 层 · {{ c }}e⁻
        </button>
        <button
          class="shell-chip"
          :class="{ on: picked && picked.kind === 'nucleus' }"
          @click="picked = { kind: 'nucleus' }; applyHighlight()"
        >
          原子核
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.atom {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stage-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  max-height: 46vh;
  border-radius: 16px;
  overflow: hidden;
  background: radial-gradient(circle at 50% 45%, rgba(79, 124, 255, 0.14), transparent 62%),
    var(--surface-2);
  border: 1px solid var(--border);
}

.stage {
  position: absolute;
  inset: 0;
  touch-action: none;
  cursor: grab;
}

.stage.picking {
  cursor: pointer;
}

.stage :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
  outline: none;
  /* OrbitControls 会往 canvas 上写内联 cursor，这里用 inherit 让外层容器的状态决定光标 */
  cursor: inherit !important;
}

.fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
  gap: 10px;
  padding: 24px;
  font-size: 13px;
  line-height: 1.7;
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

.pick-card {
  position: absolute;
  z-index: 3;
  top: 10px;
  right: 10px;
  width: min(240px, 58%);
  padding: 11px 13px 10px;
  border-radius: 12px;
  background: var(--surface-solid);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow);
}

.pick-card h4 {
  font-size: 14px;
  margin: 0 0 2px;
  padding-right: 18px;
}

.pick-sub {
  font-size: 11.5px;
  color: var(--text-faint);
  margin-bottom: 8px;
}

.pick-close {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: 10px;
  display: grid;
  place-items: center;
  color: var(--text-faint);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.pick-close:hover {
  color: var(--text);
}

.pick-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0;
  border-top: 1px dashed var(--border);
}

.pick-row dt {
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: nowrap;
}

.pick-row dd {
  margin: 0;
  font-size: 12px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
}

.stage-hint {
  position: absolute;
  left: 10px;
  bottom: 8px;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--text-faint);
  pointer-events: none;
}

.atom-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.mini {
  flex: 1 1 auto;
  padding: 7px 12px;
  font-size: 12.5px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-dim);
  transition: all 0.2s ease;
  white-space: nowrap;
}

.mini:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.mini.on {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.legend {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-dim);
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}

.dot:not(:first-child) {
  margin-left: 8px;
}

.proton {
  background: #ff5b6e;
}

.neutron {
  background: #4d7cff;
}

.electron {
  background: #ffd24a;
}

.shells {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.shell-chip {
  padding: 3px 8px;
  border-radius: 7px;
  font-size: 11.5px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  transition: all 0.18s ease;
}

.shell-chip:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.shell-chip.on {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

@media (max-width: 700px) {
  .pick-card {
    width: min(220px, 68%);
  }

  .stage-hint {
    font-size: 10px;
  }
}
</style>
