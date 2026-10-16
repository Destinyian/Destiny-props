# Destiny-props

Self-built collection of front-end props / components — the ones worth reusing across projects.

## Index

| Prop / Component | Description | Stack | Path |
|---|---|---|---|
| **GravityLetters** | 把文字栅格化成上千个小字符：鼠标划过像削皮一样削掉（掉落的字符变蓝、落到底部堆成沙丘），点一下整片直落，再点一下完整复原。无回弹、落定即静止、静止时零 CPU。 | 零依赖 canvas 2D 引擎 + React 19 封装（`'use client'`，SSR 安全） | [`GravityLetters/`](GravityLetters/) |

## 每个组件的约定

```
<Component>/
├── <engine>.js         框架无关引擎（传入 canvas 即可用，不依赖 React）
├── <Component>.tsx     React 封装：'use client' + forwardRef 命令式 API
├── <engine>.d.ts       类型
├── demo.html           零依赖演示（需用静态服务器打开：ESM 不能走 file://）
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

## License

暂未选择 —— 商用前请先补一个。
