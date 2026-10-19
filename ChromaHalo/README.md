# ChromaHalo · 光标墨迹晕

指针不是在拖动一个发光的圆，而是在**推动一个低分辨率的速度场 + 染料场**。快速划过会留下整条被扫过的路径；停手后墨迹继续漂移，尾部保持得更久（`trail` 1.2 s），不会一停手就只剩笔头。亮色页面上是减法墨（`multiply`，薄处见色相、厚处趋黑），暗色页面上是加法烟（`screen`，亮核 + 边缘）。默认演示是**深色页 + 白色烟**；传彩色 `color` 时烟边缘会带色相。指针离开 1.5 秒后，一个不可见的漫游者接手（页面首次加载、还没见过指针时，规格允许它立即出现）；开启「减弱动态效果」时它永不出现，但指针仍然有效。

## 用途

以光标为主角的 hero、深色产品页、预览画布，或任何「页面在指针停下后就死了」的地方。它是装饰层：不接收指针事件、不抢焦点、不遮挡内容，可以盖在文字后面。

## 交互

| 输入 | 行为 |
| --- | --- |
| 指针快速划过 | 整条路径留下墨迹；不是跟着指针的圆 |
| 指针停下 | 墨迹继续漂移，尾部约 1.2 s 后才明显变淡，约 2–3 s 完全干净 |
| 指针离开 / 不动 1.5 s | 不可见漫游者开始自己画（`autoplay`） |
| 点一下（触屏 tap） | 落一个可见的墨点，随后正常消散 |
| 再次移动指针 | 漫游者 0.2 s 内让位，指针接管 |
| 系统开启「减弱动态效果」 | 无漫游者；指针驱动仍工作 |
| 页面切到后台 | 立即停 rAF；回来重置 `dt`，不会一帧喷飞 |

## 如何运行

无第三方依赖，任意静态服务器即可（ES 模块不能走 `file://`）：

```bash
node serve.mjs          # -> http://127.0.0.1:4181
```

演示页支持 URL 参数实时调参：

`?mode=smoke`（强制模式）`?color=%23ffffff`（色相）`?size=93`（笔刷半径）
`?force=1`（速度冲量）`?intensity=1`（染料）`?trail=1.2`（染料寿命）
`?drift=1.0`（速度寿命）`?blur=12`（CSS 模糊）`?quality=high`（模拟分辨率）
`?autoplay=0`（关漫游者）`?idle=1.5`（空闲阈值）`?degrade=0`（关自动降档）
`?paused=1`（冻结）`?theme=light`（浅色）`?hud=0`（隐藏 HUD）。

对照页：`cheap.html` —— 同样是 180 px 的 radial-gradient + `blur(24px)`，跟随指针，但没有场、没有记忆。

## Props

`ChromaHalo` 的 props 就是引擎的 options：

| Prop | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `color` | `#362E82` | 任意 hex / `rgb()` | 墨 / 烟的色相 |
| `mode` | `auto` | `auto` / `ink` / `smoke` | auto 读祖先第一个不透明背景的亮度 |
| `size` | `56` | 2–600 | 半强度半径，CSS px；可见笔刷约为 2× |
| `force` | `1` | 0–10 | 速度冲量倍率 |
| `intensity` | `1` | 0–10 | 染料注入倍率 |
| `trail` | `1.2` s | 0.05–30 | 染料寿命；衰减常数是 `trail / 3`。调大后尾部保持更久 |
| `drift` | `1.0` s | 0.05–30 | 速度寿命；与 `trail` 独立 |
| `blur` | `8` px | 0–64 | 上采样后的 CSS 模糊 |
| `opacity` | `1` | 0–1 | 整体强度（缩放染料，不是缩放图层） |
| `quality` | `medium` | `low` / `medium` / `high` | 模拟分辨率 0.15 / 0.25 / 0.4 |
| `autoplay` | `true` | bool | 空闲漫游者 |
| `autoplaySpeed` | `1` | 0–10 | 漫游者速度 |
| `idleDelay` | `1.5` s | ≥0 | 指针离开后多久允许漫游者 |
| `interactive` | `true` | bool | 是否响应指针 |
| `paused` | `false` | bool | 冻结模拟 |
| `reducedMotion` | `auto` | `auto` / `instant` / `full` | `auto` 跟随系统 |
| `iterations` | `4` | 3–6 | Jacobi 压力迭代；少于 3 会退化成模糊的虫 |
| `autoDegrade` | `true` | bool | 4 核以下自动 `low` + `blur 0`；p95 > 20 ms 时运行时降档 |
| `onModeChange` | `null` | `(mode) => void` | auto 模式解析结果变化时触发 |

演示页为了 1440×900 的观感把 `size` 调到 93（比原来的 88 大 5 px）、`blur` 12、`autoplaySpeed` 3，并默认深色页 + 白色烟；切到浅色页会自动换回 `#362E82` 墨（白色 multiply 在浅色页不可见）。引擎默认仍是规格里的 56 / 8 / 1，URL 可覆盖。

## React 接入

```tsx
import { ChromaHalo } from './ChromaHalo/src/ChromaHalo';

<div style={{ position: 'relative', height: '80vh', background: '#08070f' }}>
  <ChromaHalo color="#ffffff" size={93} blur={12} />
  <div style={{ position: 'relative', zIndex: 1 }}>页面内容</div>
</div>
```

白色烟只在深色背景上可见；浅色页请用 `color="#362E82"` 或显式 `mode="ink"`。

- 父元素必须有尺寸并且 `position: relative`（或任意非 static 定位）；canvas 是 `position:absolute; inset:0`。
- 组件只渲染一个 `<canvas>`，`pointer-events: none`、`aria-hidden="true"`；引擎监听父元素，所以不会挡住链接、按钮或文本选择。
- `'use client'`，SSR 安全：import 阶段不碰 `window`/`document`。
- `ref` 暴露 `getMode / getOptions / getStats / sampleDensity / rebuild / setOptions`；`getStats()` 是验收用的计数器（`frames`、`lastFrameMs`、`p95FrameMs`、`grid`、`passes`、`running`、`mode`、`dyeMax`、`autoplayActive`、`degraded`）。
- 父元素不要设置 `pointer-events: none`，否则引擎收不到指针。

## 设计取舍

- **CPU 2D canvas，不用 WebGL。** 模拟在 `Float32Array` 上做半拉格朗日平流 + 4 次 Jacobi 压力投影，没有上下文丢失、半浮点纹理或 GPU 可用性的失败面；CI 里也能跑纯函数测试。
- **低分辨率模拟，低分辨率画布，CSS 放大。** 网格上限 `320×200 = 64,000` 格；可见 canvas 的 backing store 就是网格，CSS 拉到容器大小，`blur` 收边。这样每帧只有一次 `putImageData`，没有全分辨率 `drawImage`。刻意不乘 `devicePixelRatio`：高 DPI 上会软，但这是性能预算的一部分。
- **两个衰减常数。** 染料 `exp(-dt / (trail/3))`，速度 `exp(-dt / (drift/3))`。合成一个会要么拖尾太长，要么不漂移。
- **压力投影是「流体」和「拖影」的分界。** 4 次 Jacobi 让轨迹边缘卷起来；少于 3 次会退化成模糊的虫。
- **笔刷是半强度半径，不是边界。** `w = 2^(-d²)` 在 `d = size` 处正好 0.5；如果只采样到 1× size，就在半强度处硬切，屏幕上就是一个 176 px 的方块。现在采样到 2.5× size，并在最后 0.5× 用线性窗羽化到 0：中心半强度不变，外边自然消失，方形边缘不再出现。
- **染料增益 `24`。** 规格里的 `d += 2·dt·intensity·w` 在 60 fps 下每帧只有 0.033；快速划过一个格子只被笔刷覆盖一两帧，路径会低于可见阈值。规格同时给出 `d` 常用 0–3，所以引擎把连续注入乘 `24`（`intensity` 仍然乘在外面）。这是对 CPU 场单位的标定，不是新参数；`inkField.splat` 本身保持纯函数。
- **漫游者染料增益 `1.0`。** 漫游者只有指针 1/10 的速度，若沿用 24，会在原地堆出一个饱和黑色圆盘。配合 1.2 s 的 trail 和更快的演示速度 3，空闲烟是一条移动的缎带，而不是盖住标题的实心块。
- **烟更浓。** 烟色的 tone 系数从规格的 0.35 调到 0.5，alpha 从 1.5 调到 2.2；薄烟更早显形，核心更快到近白/近满不透明。墨模式不受影响。
- **停止条件。** 最后一次注入后 `max(trail, drift) × 3 + 0.5 s`（默认 ≈4.1 s）停 rAF；`autoplay` 开启时漫游者会持续注入，所以「空闲零 rAF」只适用于 `autoplay=false`、`prefers-reduced-motion`、或指针仍在页面内且墨迹已经衰减完的情况。`trail` 调到 1.2 s 后循环也会多跑约 1.8 s，这是尾部保持更久的代价。
- **主题只读一次。** `auto` 在初始化与 `class` / `style` / `data-theme` 变化时读祖先背景亮度，不每帧读样式。`MutationObserver` 不在 `requestAnimationFrame` 里做样式查询。
- **指针事件只累加 Δ。** 事件里不绘制；每帧一次 splat，避免一帧多次重绘。

## 实测

1440×900、`quality=medium`、`size=93`、`blur=12`，headless Chrome 155 / Node 24.16：

| 指标 | GPU 路径 | 软件光栅（`--disable-gpu`） |
| --- | --- | --- |
| JS 帧工作 p95 | **5.1 ms**（多次运行 4.7–6.6） | **4.4 ms** |
| 网格 | 320×200（64k 格） | 320×200 |
| 空闲 1 s 的 rAF 增量（`autoplay=0`） | **0** | 0 |
| reduced-motion 1 s 的 rAF 增量 | **0** | 0 |
| 主题切换解析到 `smoke` | **2 帧内** | 2 帧内 |
| resize 到 1280×720 | 320×180，`dyeMax=0` | 同 |
| 4 核自动降档 | `low` + `blur:none` | 同 |

p95 是引擎自己测的「field + render + putImageData」时间，不含浏览器合成；详细帧证据见 [behavior.md](behavior.md)。

## 已知边界

- `mode="auto"` 只读祖先的**纯色背景**。背景是图片 / 渐变 / 视频时请显式传 `mode`。
- 白色烟是 `screen` 的加法：只在深色背景上可见；浅色页请用 `#362E82` 之类的墨色（演示页会自动切换）。
- 画布 backing store 是网格尺寸，2× 屏上会偏软；这是刻意的性能取舍。不要在小尺寸画布上放正文。
- 64k 格是 CPU 预算；更大的容器会被上限截断（单元更大、更软），不会更慢。`quality` 是性能旋钮。
- CPU 场始终比 WebGL 版慢；p95 数字绑定环境，换机器请用 `tools/verify_behavior.js` 重测。
- 不做多指手势；触屏按单指处理。
- 2D context 创建失败时退化为跟随指针的 radial-gradient（无拖尾），并在 console 打一行 warning；它没有场，因此也不支持漫游者。
- `mix-blend-mode` + CSS `filter: blur()` 是效果的一部分；不支持这两个特性的旧浏览器会看到硬边。

## 测试与验收

```bash
node --test tests/                 # 纯函数：场、颜色映射、漫游者
node serve.mjs                     # 终端 1
node tools/verify_behavior.js      # 终端 2：真实 DevTools 鼠标 + 抓帧 + 像素读取
HALO_SOFTWARE=1 node tools/verify_behavior.js   # 软件光栅对照
```

`tools/verify_behavior.js` 会写 `review/*.png`（本地验收截图，不入库）并打印 JSON；它用真实 `Input.dispatchMouseEvent` 走一条 S 形快滑，采样路径中点 / 笔头 / 背景的 9×9 亮度均值，并对照 `cheap.html`。

## 目录

```text
ChromaHalo/
├── src/
│   ├── inkField.js        # 纯函数：网格、splat、advect、pressure、dissipate
│   ├── inkRender.js       # 染料 → ImageData → canvas；ink / smoke 色彩映射
│   ├── inkAutoplay.js     # 漫游者路径 + 淡入淡出
│   ├── inkHalo.js         # 生命周期、指针、observer、rAF、降级
│   ├── inkHalo.d.ts       # 引擎类型
│   └── ChromaHalo.tsx     # React 19 封装（'use client'）
├── tests/                 # node --test，纯函数行为测试
├── tools/
│   └── verify_behavior.js # 真实输入 + 抓帧的验收脚本
├── index.html             # 亮/暗、cheap、暂停、HUD 演示
├── cheap.html             # 对照组：无记忆的 glow
├── serve.mjs              # 零依赖静态服务器（4181）
├── behavior.md            # G1–G6 的抓帧数字与结论
└── README.md
```

## 干净室说明

行为来自对 React Bits Pro「Chroma Halo」的观察（公开文档 + 运行中的页面 + 抓帧），没有复制其源码、着色器、常量命名或漫游路径公式。数值来自环境观察与 [Stable Fluids](https://graphics.stanford.edu/papers/stam99/stam99.pdf) 的标准半拉格朗日 / 压力投影；本实现的 CPU 路线、模块划分、CSS 上采样、染料增益和测试都是独立写的。原组件需要 WebGL2，这里完全不依赖 GPU 特性。
