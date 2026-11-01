/**
 * WebGL 通用工具
 *
 * 集中处理 3D 场景中最容易出错的三件事：
 * 1. 渲染器与 WebGL 上下文的创建 / 彻底释放（避免反复挂载导致上下文耗尽）
 * 2. 对象树的几何体 / 材质释放（自动去重，避免共享资源被 dispose 多次）
 * 3. 帧率自适应：检测到持续掉帧时自动降低渲染分辨率
 */

import * as THREE from 'three'

/** 浏览器是否可用 WebGL，用于优雅降级 */
export function detectWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl) return false
    // 探测用的上下文必须立刻归还，否则每次检测都会占用一个宝贵的 WebGL 上下文名额
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

let contextCount = 0

/**
 * 创建渲染器并挂载到宿主节点。
 * 像素比上限为 2：高分屏上 3 倍渲染分辨率带来的画质提升远小于其性能代价。
 */
export function createRenderer(host: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
    // 页面卸载后不再需要读取回帧缓冲，关掉可省一部分显存带宽
    preserveDrawingBuffer: false,
    stencil: false,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(host.clientWidth || 1, host.clientHeight || 1, false)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.outline = 'none'
  renderer.domElement.style.touchAction = 'none'
  host.appendChild(renderer.domElement)
  contextCount++
  return renderer
}

/**
 * 彻底释放渲染器。
 *
 * 仅调用 `renderer.dispose()` 不会立即归还 WebGL 上下文，反复打开 / 关闭 3D 面板时
 * 浏览器会在超出上下文上限（通常 16）后强制丢弃最旧的上下文并打印警告。
 * 因此必须显式 `forceContextLoss()` 通知驱动回收。
 */
export function teardownRenderer(renderer: THREE.WebGLRenderer | null, host: HTMLElement | null) {
  if (!renderer) return
  try {
    renderer.dispose()
    renderer.forceContextLoss()
  } catch {
    /* 上下文已失效时忽略 */
  }
  const canvas = renderer.domElement
  if (canvas?.parentNode) canvas.parentNode.removeChild(canvas)
  if (host) {
    // 兜底：确保宿主节点内不残留任何画布
    for (const stale of Array.from(host.querySelectorAll('canvas'))) stale.remove()
  }
  if (contextCount > 0) contextCount--
}

/**
 * 开发模式下把渲染器 / 相机挂到 window，供性能探针与交互测试脚本读取
 * （draw call、三角面数、纹理与几何体数量、相机距离等）。
 * 生产构建不会执行这段代码。
 */
export function exposeDebug(key: string, value: unknown) {
  if (!import.meta.env.DEV) return
  ;(window as unknown as Record<string, unknown>)[key] = value
}

/** 当前进程内活跃（未释放）的 WebGL 上下文数量，测试脚本用它验证没有泄漏 */
export function activeContextCount() {
  return contextCount
}

/**
 * 释放一棵对象树上的几何体与材质。
 *
 * 多个 Mesh 常常共用同一份 geometry / material（例如 118 个立方体共享一个 BoxGeometry），
 * 若逐个 dispose 会重复派发 dispose 事件。这里用 Set 去重，保证每个资源只释放一次。
 */
export function disposeSubtree(root: THREE.Object3D | null) {
  if (!root) return
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh & { material?: THREE.Material | THREE.Material[] }
    const g = (obj as unknown as { geometry?: THREE.BufferGeometry }).geometry
    if (g) geometries.add(g)
    const m = mesh.material
    if (Array.isArray(m)) m.forEach((one) => materials.add(one))
    else if (m) materials.add(m)
  })

  /**
   * 带有 `userData.shared` 标记的纹理属于跨组件复用的全局缓存
   * （文字标注图集、元素标签图集），销毁单个组件时不能释放它们，
   * 否则其它组件会拿到已失效的纹理。
   */
  const isShared = (t: THREE.Texture) => (t.userData?.shared as boolean | undefined) === true

  for (const m of materials) {
    const withMap = m as THREE.MeshStandardMaterial
    if (withMap.map && !isShared(withMap.map)) textures.add(withMap.map)
    if (withMap.emissiveMap && !isShared(withMap.emissiveMap)) textures.add(withMap.emissiveMap)
    if (withMap.alphaMap && !isShared(withMap.alphaMap)) textures.add(withMap.alphaMap)
  }
  for (const t of textures) t.dispose()
  for (const m of materials) m.dispose()
  for (const g of geometries) g.dispose()

  // 自底向上摘除，保证 parent 引用被正确清空
  const nodes: THREE.Object3D[] = []
  root.traverse((obj) => nodes.push(obj))
  for (let i = nodes.length - 1; i >= 1; i--) nodes[i].parent?.remove(nodes[i])
  root.clear()
}

/** 帧率守卫：连续掉帧时逐级降低像素比，恢复后再逐步升回 */
export class PerfGuard {
  private frames = 0
  private elapsed = 0
  private slow = 0
  private renderer: THREE.WebGLRenderer
  private readonly baseRatio: number
  ratio: number

  constructor(renderer: THREE.WebGLRenderer, baseRatio: number) {
    this.renderer = renderer
    this.baseRatio = baseRatio
    this.ratio = baseRatio
  }

  /** 每帧传入 dt（秒），返回 true 表示本帧调整过像素比 */
  update(dt: number): boolean {
    this.frames++
    this.elapsed += dt
    if (this.elapsed < 1) return false

    const fps = this.frames / this.elapsed
    this.frames = 0
    this.elapsed = 0

    if (fps < 40) this.slow++
    else if (fps > 55) this.slow = Math.max(0, this.slow - 1)

    if (this.slow >= 2 && this.ratio > 0.75) {
      this.ratio = Math.max(0.75, this.ratio - 0.5)
      this.renderer.setPixelRatio(this.ratio)
      this.slow = 0
      return true
    }
    if (this.slow === 0 && this.ratio < this.baseRatio) {
      this.ratio = Math.min(this.baseRatio, this.ratio + 0.5)
      this.renderer.setPixelRatio(this.ratio)
      return true
    }
    return false
  }
}
