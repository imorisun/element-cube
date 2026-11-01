/**
 * 3D 场景内的文字标注（Sprite）
 *
 * 使用 Sprite 而非 DOM 覆盖层的好处：文字与模型共享同一套深度、透视与轨道旋转，
 * 旋转视角时标注会自然跟随，不需要在每帧做世界坐标 → 屏幕坐标投影。
 *
 * 两种生命周期：
 * - 静态标注（周期号、族号）：文本固定且数量有限，走全局缓存，跨组件复用
 * - 动态标注（随当前元素变化的名称、核子数）：由持有它的模型树负责销毁，
 *   切换元素时随旧模型一起释放，避免浏览 118 个元素过程中贴图无限累积
 *
 * 其它要点：
 * - 画布按 2 倍分辨率绘制，缩放后仍然清晰
 * - 关闭 mipmap + 线性过滤，省掉多级 mipmap 的显存开销
 */

import * as THREE from 'three'

export interface LabelStyle {
  /** 世界单位下的文字高度 */
  size?: number
  color?: string
  background?: string
  border?: string
  bold?: boolean
  padding?: number
}

export interface LabelOptions {
  /**
   * 是否放入全局缓存。静态文本传 true；随数据变化的文本必须传 false，
   * 否则每一个不同的文本都会永久占用一张 GPU 贴图。
   */
  cache?: boolean
}

type ResolvedStyle = Required<LabelStyle>
type Built = { tex: THREE.CanvasTexture; aspect: number }

const DPR = 2
const cache = new Map<string, Built>()
const CACHE_LIMIT = 160

function keyOf(text: string, s: ResolvedStyle) {
  return [text, s.size, s.color, s.background, s.border, s.bold ? 1 : 0, s.padding].join('|')
}

function resolve(style: LabelStyle): ResolvedStyle {
  return {
    size: style.size ?? 0.42,
    color: style.color ?? '#ffffff',
    background: style.background ?? 'rgba(10,14,28,0.72)',
    border: style.border ?? 'rgba(255,255,255,0.28)',
    bold: style.bold ?? false,
    padding: style.padding ?? 14,
  }
}

function buildTexture(text: string, s: ResolvedStyle): Built {
  const fontPx = 44
  const pad = s.padding
  const font = `${s.bold ? 700 : 600} ${fontPx}px Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`

  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = font
  const textW = Math.ceil(probe.measureText(text).width)
  const ascent = Math.ceil(probe.measureText(text).actualBoundingBoxAscent || fontPx * 0.76)
  const descent = Math.ceil(probe.measureText(text).actualBoundingBoxDescent || fontPx * 0.2)

  const cw = Math.max(4, textW + pad * 2)
  const ch = Math.max(4, ascent + descent + pad * 2)

  const canvas = document.createElement('canvas')
  canvas.width = cw * DPR
  canvas.height = ch * DPR
  const ctx = canvas.getContext('2d')!
  ctx.scale(DPR, DPR)

  if (s.background !== 'transparent') {
    const r = ch / 2
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(0.5, 0.5, cw - 1, ch - 1, r)
    } else {
      // 旧版浏览器无 roundRect，退化为直角矩形
      ctx.rect(0.5, 0.5, cw - 1, ch - 1)
    }
    ctx.fillStyle = s.background
    ctx.fill()
    if (s.border !== 'transparent') {
      ctx.strokeStyle = s.border
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }

  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = s.color
  ctx.fillText(text, cw / 2, ch / 2 + (ascent - descent) / 2)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 1
  return { tex, aspect: cw / ch }
}

function getTexture(text: string, s: ResolvedStyle, cacheable: boolean): Built {
  if (!cacheable) {
    const built = buildTexture(text, s)
    // 标记为非共享：组件销毁子树时会连同释放
    built.tex.userData.shared = false
    return built
  }

  const key = keyOf(text, s)
  const hit = cache.get(key)
  if (hit) return hit

  const built = buildTexture(text, s)
  built.tex.userData.shared = true
  cache.set(key, built)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      cache.get(oldest)?.tex.dispose()
      cache.delete(oldest)
    }
  }
  return built
}

/** 生成文字标注精灵 */
export function makeLabel(text: string, style: LabelStyle = {}, opts: LabelOptions = {}): THREE.Sprite {
  const s = resolve(style)
  const cacheable = opts.cache !== false
  const { tex, aspect } = getTexture(text, s, cacheable)
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      sizeAttenuation: true,
    }),
  )
  sprite.scale.set(s.size * aspect, s.size, 1)
  // 射线拾取时忽略文字标注
  sprite.raycast = () => {}
  sprite.renderOrder = 10
  return sprite
}

/** 复用已有精灵更新文字；旧的非共享贴图会被立即释放。返回画布的宽高比，便于调用方做距离补偿缩放 */
export function setLabelText(
  sprite: THREE.Sprite,
  text: string,
  style: LabelStyle = {},
  opts: LabelOptions = {},
): number {
  const s = resolve(style)
  const cacheable = opts.cache !== false
  const mat = sprite.material as THREE.SpriteMaterial
  const prev = mat.map
  if (prev && prev.userData?.shared === false) prev.dispose()

  const { tex, aspect } = getTexture(text, s, cacheable)
  if (mat.map !== tex) {
    mat.map = tex
    mat.needsUpdate = true
  }
  sprite.scale.set(s.size * aspect, s.size, 1)
  return aspect
}
