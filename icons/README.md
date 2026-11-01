# 元素立方 · 图标规范

## 设计概念

图标主体是一个**等距视角的立方体**，三个可见面各自承载产品的一层含义：

| 面 | 视觉元素 | 含义 |
|----|----------|------|
| 顶面（受光面） | 2×2 格栅 + 一格高亮 | **周期表**——元素按规律排布，高亮格代表"被选中的元素" |
| 右面（主视面） | 圆环轨道 + 中心核 + 运行电子 | **原子模型**——产品的核心 3D 功能之一 |
| 左面（暗面） | 纯色 | 承担体积感，与顶/右面形成三段明暗，构成"立方" |

立方体本身即是产品名「元素立方」的字面隐喻，也代表 3D 立方周期表这一可视化形态。

## 配色（双色）

| 用途 | 色值 | 角色 |
|------|------|------|
| 主面 | `#3F6BF5` | 品牌主色（与站点 accent 一致） |
| 顶面 | `#7CA0FF` | 主色亮 1 阶 |
| 暗面 | `#2C47C4` | 主色暗 1 阶 |
| 强调 | `#38D9A9` | 高亮元素格 / 原子核（站点辅助色） |
| 点缀 | `#FFFFFF` | 电子与轨道 |

深色模式变体整体提亮一档（`#A9C4FF` / `#5B86FF` / `#3352CF` / `#4FE7BE`）。

## 变体与适用场景

| 文件 | 说明 | 场景 |
|------|------|------|
| `icon.svg` | 完整版（含格栅与原子） | 32 px 及以上：导航栏 logo、启动画面、文档配图 |
| `icon-dark.svg` | 深色背景优化 | 深色导航、深色 App 抽屉 |
| `icon-compact.svg` | 精简版（去网格与轨道） | 24 px 及以下：浏览器 favicon、标签页 |
| `icon-compact-dark.svg` | 精简版深色 | 深色模式标签页 |
| `icon-mono.svg` | 线框 + 实心核，全部 `currentColor` | 按钮内嵌、图标字体、任意单色场景 |
| `icon-app.svg` | 圆角品牌底 + 主体 | PWA 安装、主屏幕、启动器 |
| `icon-app-maskable.svg` | Android 自适应安全区版 | maskable 图标 |
| `og-image.svg` | 1200×630 分享卡片 | Open Graph / Twitter Card |

## 尺寸与清晰度

- **矢量基准**：32×32 网格，等距投影（边向量比 2:1），所有关键坐标为整数或 0.25 的倍数，避免半像素模糊
- **24 px 分界线**：≥ 32 px 用完整版，≤ 24 px 用精简版（仅保留三面与高亮格）
- 16 px 下依靠三段明暗与高亮格保证"立方体"轮廓可辨

## 资源

- **PNG**（`public/`）：`icon-32/48/64/128/256/512.png`、`icon-compact-16/24/32/48.png`、`app-icon-180/192/512.png`、`app-icon-maskable-512.png`、`og-image.png`
- **ICO**：`favicon.ico`（内嵌 16/32/48 三档 PNG）
- **生成**：`node scripts/gen-icons.mjs`（需先以远程调试模式启动浏览器，见脚本头部注释）

## 使用方式

```html
<!-- 普通场景（<img> 引用多色版） -->
<img src="/element-cube/icon.svg" width="32" height="32" alt="元素立方" />

<!-- 按钮内嵌（inline SVG 才能让 currentColor 生效） -->
<button>
  <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
    <use href="/element-cube/icon-mono.svg#icon" />
  </svg>
  切换视图
</button>
```

注意：`icon-mono.svg` 使用 `currentColor`，必须通过 **inline SVG**（或 `<use>` 引用）使用，颜色由父元素 `color` 决定；以 `<img>` 方式引用时会渲染为默认黑色。

## favicon 自动切换（浅色 / 深色）

```html
<link rel="icon" type="image/svg+xml" href="/element-cube/favicon.svg" media="(prefers-color-scheme: light)" />
<link rel="icon" type="image/svg+xml" href="/element-cube/favicon-dark.svg" media="(prefers-color-scheme: dark)" />
<link rel="icon" type="image/x-icon" href="/element-cube/favicon.ico" sizes="16x16 32x32 48x48" />
```
