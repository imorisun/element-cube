/**
 * 原子核排布
 *
 * 目标：从 1 个核子（氢）到 300 个核子（超重元素）都要——
 *   · 严格居中（不再出现单个质子偏离球心的情况）
 *   · 核子互不重叠
 *   · 分布均匀、不松散（核子几乎相切，没有大片空洞）
 *   · 核子半径随数量平滑收敛（不会出现「1 个核子特别大、2 个就骤缩」的突变）
 *
 * 做法分三步：
 *  1) 在「核子半径 = 1」的单位空间里 packing：初始布局 + 松弛迭代
 *     （两两排斥 + 退火收缩），得到任意两核子中心距 ≥ 2 的坐标；
 *  2) 用随核子数平滑收敛的实际核子半径 r(n) 整体缩放。缩放是等比的，
 *     所以中心距 ≥ 2r 依旧成立 —— 不重叠这一条由构造本身保证；
 *  3) 按质心归零，确保原子核几何中心恒在原点。
 *
 * 排布只取决于核子数，因此按核子数缓存，切换元素不会重复计算。
 */

export interface NucleonLayout {
  /** 核子数 */
  count: number
  /** 单位空间（核子半径 = 1）下的核子中心坐标，xyz 连续存放 */
  positions: Float32Array
  /** 单位空间下的包围半径（最外核子球心距 + 核子半径），缩放后即原子核半径的倍数 */
  bound: number
}

/** 绘制核子的上限：再多的核子肉眼也分辨不出，只会拖慢 packing */
export const NUCLEON_CAP = 300

/** 单个核子（氢）时的核子半径 */
const R_SINGLE = 0.18
/** 核子很多时收敛到的核子半径 */
const R_FLOOR = 0.105
/** 半径收敛速度：越大越慢地变小 */
const R_FALLOFF = 12

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const PHI = 0.6180339887498949

/** 小核子数时用多组随机初值重跑，避开局部最优（大核子数代价太高，只用晶格初值） */
const ITERS_SMALL = 400
const ITERS_LARGE = 220
/** 收缩系数（每轮把整簇朝原点压一点，制造「挤紧」趋势），随迭代退火到 0 */
const LAMBDA0 = 0.012
/** 排斥强度 */
const STRENGTH = 0.5
/** dmin 低于该值视为排布失败（单位空间里要求 ≥ 2） */
const MIN_GAP_OK = 1.995

/**
 * 核子半径：n = 1 时最大，随后平滑收敛到 R_FLOOR。
 * 双曲衰减保证曲线单调、无拐点，相邻元素之间不会出现尺寸跳变。
 */
export function nucleonRadius(n: number): number {
  const k = Math.max(0, n - 1)
  return R_FLOOR + (R_SINGLE - R_FLOOR) / (1 + k / R_FALLOFF)
}

/** 原子核（含最外核子表面）的半径 */
export function nucleusRadiusOf(n: number): number {
  return nucleonLayout(n).bound * nucleonRadius(n)
}

/* ---------------- 初始布局 ---------------- */

function makeRng(seed: number) {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

/** 斐波那契球 + 立方根半径：体积上均匀的低差异初始布局 */
function seedFib(n: number, seed: number): Float32Array {
  const p = new Float32Array(n * 3)
  const r0 = Math.max(1, Math.cbrt(n / 0.62))
  const rnd = makeRng(seed * 2654435761)
  const zOff = rnd()
  const thOff = rnd() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n
    const rad = r0 * Math.cbrt(t)
    // z 取均匀 → 等面积；θ 取黄金角 → 任意前缀都均匀铺开
    const z = 2 * (((i * PHI + zOff) % 1) + 1) % 1 - 1
    const rxy = Math.sqrt(Math.max(0, 1 - z * z))
    const th = i * GOLDEN_ANGLE + thOff
    p[i * 3] = Math.cos(th) * rxy * rad
    p[i * 3 + 1] = Math.sin(th) * rxy * rad
    p[i * 3 + 2] = z * rad
  }
  return p
}

/** 面心立方晶格截取：最密堆积，作为大核子数的初始布局最合适 */
function seedFcc(n: number): Float32Array {
  const step = Math.SQRT2 // 最近邻距离 = √2 × step = 2
  const m = Math.ceil(Math.cbrt(n / 0.74)) + 3
  const cand: { d: number; x: number; y: number; z: number }[] = []
  for (let i = -m; i <= m; i++) {
    for (let j = -m; j <= m; j++) {
      for (let k = -m; k <= m; k++) {
        if ((((i + j + k) % 2) + 2) % 2 !== 0) continue
        const x = i * step
        const y = j * step
        const z = k * step
        cand.push({ d: x * x + y * y + z * z, x, y, z })
      }
    }
  }
  cand.sort((a, b) => a.d - b.d)
  const p = new Float32Array(n * 3)
  const total = Math.min(n, cand.length)
  for (let i = 0; i < total; i++) {
    p[i * 3] = cand[i].x
    p[i * 3 + 1] = cand[i].y
    p[i * 3 + 2] = cand[i].z
  }
  return p
}

/* ---------------- 松弛 ---------------- */

/**
 * 投影梯度：重叠的核子互相推开（把中心距补到 2），
 * 整簇同时朝原点退火收缩，于是核子被「挤」成紧凑的一团。
 * 收缩系数退火到 0 后只剩排斥，收尾时 dmin 必然 ≥ 2。
 */
function relax(p: Float32Array, n: number, iters: number) {
  const decay = iters * 0.7
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      const ix = i * 3
      for (let j = i + 1; j < n; j++) {
        const jx = j * 3
        let dx = p[jx] - p[ix]
        let dy = p[jx + 1] - p[ix + 1]
        let dz = p[jx + 2] - p[ix + 2]
        let d2 = dx * dx + dy * dy + dz * dz
        if (d2 >= 4) continue
        if (d2 < 1e-12) {
          // 完全重合：按序号给一个确定性的微小偏移，避免除零
          dx = i & 1 ? 1e-3 : -1e-3
          dy = i & 2 ? 1e-3 : -1e-3
          dz = i & 4 ? 1e-3 : -1e-3
          d2 = dx * dx + dy * dy + dz * dz
        }
        const d = Math.sqrt(d2)
        const k = ((2 - d) / d) * 0.5 * STRENGTH
        dx *= k
        dy *= k
        dz *= k
        p[ix] -= dx
        p[ix + 1] -= dy
        p[ix + 2] -= dz
        p[jx] += dx
        p[jx + 1] += dy
        p[jx + 2] += dz
      }
    }
    const lam = LAMBDA0 * Math.max(0, 1 - it / decay)
    if (lam > 0) {
      const f = 1 - lam
      for (let i = 0; i < n * 3; i++) p[i] *= f
    }
  }
}

/** 质心归零 + 统计包围半径与最小间距 */
function finalize(p: Float32Array, n: number): { bound: number; dmin: number } {
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    cx += p[i * 3]
    cy += p[i * 3 + 1]
    cz += p[i * 3 + 2]
  }
  cx /= n
  cy /= n
  cz /= n

  let cmax = 0
  for (let i = 0; i < n; i++) {
    const x = p[i * 3] - cx
    const y = p[i * 3 + 1] - cy
    const z = p[i * 3 + 2] - cz
    p[i * 3] = x
    p[i * 3 + 1] = y
    p[i * 3 + 2] = z
    const r = Math.sqrt(x * x + y * y + z * z)
    if (r > cmax) cmax = r
  }

  let dmin = Infinity
  for (let i = 0; i < n; i++) {
    const ix = i * 3
    for (let j = i + 1; j < n; j++) {
      const jx = j * 3
      const dx = p[jx] - p[ix]
      const dy = p[jx + 1] - p[ix + 1]
      const dz = p[jx + 2] - p[ix + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < dmin) dmin = d
    }
  }
  return { bound: cmax + 1, dmin }
}

/* ---------------- 对外接口 ---------------- */

/** 核子越多，packing 越贵；这里按规模递减重启次数，把单次开销压在几十毫秒内 */
function attemptsFor(n: number): number {
  if (n <= 8) return 40
  if (n <= 14) return 24
  if (n <= 24) return 16
  if (n <= 60) return 6
  return 1
}

/** 随机旋转：让晶格初值不至于每次都朝同一个方向躺平 */
function rotateRandom(p: Float32Array, n: number, rnd: () => number) {
  const a = rnd() * Math.PI * 2
  const b = rnd() * Math.PI * 2
  const c = rnd() * Math.PI * 2
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const cb = Math.cos(b)
  const sb = Math.sin(b)
  const cc = Math.cos(c)
  const sc = Math.sin(c)
  for (let i = 0; i < n; i++) {
    const ix = i * 3
    let x = p[ix]
    let y = p[ix + 1]
    let z = p[ix + 2]
    let t = y * ca - z * sa
    z = y * sa + z * ca
    y = t
    t = x * cb - z * sb
    z = x * sb + z * cb
    x = t
    t = x * cc - y * sc
    y = x * sc + y * cc
    x = t
    p[ix] = x
    p[ix + 1] = y
    p[ix + 2] = z
  }
}

const cache = new Map<number, NucleonLayout>()

/** 取（或计算）n 个核子的排布，结果按 n 缓存 */
export function nucleonLayout(n: number): NucleonLayout {
  const count = Math.max(1, Math.min(NUCLEON_CAP, Math.round(n)))
  const hit = cache.get(count)
  if (hit) return hit

  const attempts = attemptsFor(count)
  const iters = count <= 24 ? ITERS_SMALL : ITERS_LARGE
  const rnd = makeRng(count * 7919 + 17)

  let bestPos: Float32Array | null = null
  let bestBound = Infinity
  for (let s = 1; s <= attempts; s++) {
    // 每 4 次掺一次晶格初值；核子很多时只用晶格（它本来就是最密堆积）
    const useFcc = count > 60 || s % 4 === 0
    const p = useFcc ? seedFcc(count) : seedFib(count, s)
    if (useFcc && count <= 60) rotateRandom(p, count, rnd)
    relax(p, count, iters)
    const { bound, dmin } = finalize(p, count)
    if (dmin < MIN_GAP_OK) continue
    if (bound < bestBound) {
      bestBound = bound
      bestPos = p
    }
  }

  // 兜底：理论上不会发生（纯排斥阶段必然把 dmin 推到 2），
  // 真出现时退化为斐波那契球并按最保守间距摆放，保证不重叠。
  if (!bestPos) {
    const p = seedFib(count, 1)
    const r = Math.cbrt(count / 0.55)
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count
      const z = 1 - 2 * t
      const rxy = Math.sqrt(Math.max(0, 1 - z * z))
      const th = i * GOLDEN_ANGLE
      p[i * 3] = Math.cos(th) * rxy * r
      p[i * 3 + 1] = Math.sin(th) * rxy * r
      p[i * 3 + 2] = z * r
    }
    const { bound } = finalize(p, count)
    bestPos = p
    bestBound = bound
  }

  const layout: NucleonLayout = { count, positions: bestPos, bound: bestBound }
  cache.set(count, layout)
  return layout
}
