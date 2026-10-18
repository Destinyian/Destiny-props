# Destiny-props

Self-built collection of front-end props / components — the ones worth reusing across projects.

## Index

| Prop / Component | Description | Stack | Path |
|---|---|---|---|
| **GravityLetters** | 把文字栅格化成上千个小字符：鼠标划过像削皮一样削掉（掉落的字符变蓝、落到底部堆成沙丘），点一下整片直落，再点一下完整复原。无回弹、落定即静止、静止时零 CPU。 | 零依赖 canvas 2D 引擎 + React 19 封装（`'use client'`，SSR 安全） | [`GravityLetters/`](GravityLetters/) |
| **ChromaHalo** | 光标墨迹晕：快速划过留下整条被扫过的路径，停手后墨迹继续漂移、约 0.6 s 淡到只剩笔头；亮页是减法墨（multiply），暗页是加法烟（screen），指针离开 1.5 s 后不可见漫游者接手。 | 零依赖 canvas 2D 流体场（半拉格朗日 + 4 次 Jacobi 压力投影） + React 19 封装（`'use client'`，SSR 安全） | [`ChromaHalo/`](ChromaHalo/) |

## 每个组件的约定

```
<Component>/
├── src/<engine>.js     框架无关引擎（传入 canvas 即可用，不依赖 React）
├── src/<Component>.tsx React 封装：'use client' + forwardRef 命令式 API
├── src/<engine>.d.ts   类型
├── tests/              纯函数行为测试（node --test）
├── index.html          零依赖演示（需用静态服务器打开：ESM 不能走 file://）
├── serve.mjs           零依赖静态服务器
├── behavior.md         （可选）真实输入 + 抓帧的验收记录
├── tools/              （可选）零依赖验收脚本
└── README.md           props 表 + 设计取舍 + 实测数据
```

约定说明：

- **引擎与框架分离** —— 引擎能被 Vue/Svelte/原生直接用，React 只是一个薄封装。
- **零运行时依赖** —— 不引入物理库/动画库。
- **SSR 安全** —— import 阶段不碰 `window`/`document`，所有副作用都在 `create`/`useEffect` 内，`destroy()` 全部回收。
- **行为可验证** —— 每个组件暴露诊断计数器（如 `settleMoves`、`returnOvershoots`、`riseCount`、`glyphHash`、`running`），让"手感"这种主观指标也能被回归测试覆盖。

## 用法（GravityLetters）

```tsx
import { GravityLetters } from './GravityLetters/GravityLetters';

<div style={{ height: '70vh', background: '#07070d' }}>
  <GravityLetters
    text={'GRAVITY\nLETTERS'}
    color="#ece9ff"      // 文字
    fallColor="#a9c8ff"  // 掉落字符（浅蓝）
    eraseMode="hover"    // 鼠标划过即削（默认）
    autoRestoreMs={10000}// 10 秒无操作自动恢复
  />
</div>
```

命令式 API（`ref`）：`collapse()` / `restore()` / `toggle()` / `reset()` / `rebuild()` /
`getState()` / `getParticleCount()` / `getStats()`。

## 用法（ChromaHalo）

```tsx
import { ChromaHalo } from './ChromaHalo/src/ChromaHalo';

<div style={{ position: 'relative', height: '80vh', background: '#f2efe8' }}>
  <ChromaHalo color="#362E82" size={88} blur={12} />
  <div style={{ position: 'relative', zIndex: 1 }}>页面内容</div>
</div>
```

父元素需有尺寸和 `position: relative`；canvas 是 `pointer-events: none`，不挡内容。`mode="auto"`
会读祖先第一个不透明背景的亮度，图片 / 渐变背景请显式传 `mode="ink"` 或 `mode="smoke"`。
`ref` 暴露 `getMode()` / `getOptions()` / `getStats()` / `sampleDensity()` / `rebuild()` /
`setOptions()`。演示与验收：

```bash
cd ChromaHalo
node serve.mjs                 # http://127.0.0.1:4181 ，含 cheap.html 对照组
node tools/verify_behavior.js  # 真实输入 + 抓帧 + G1–G6 数字
```

## License

暂未选择 —— 商用前请先补一个。
