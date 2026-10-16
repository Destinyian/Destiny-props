# glyph-gravity · 字符重力

把一段文字栅格化成**成千上万个小字符**，然后可以：

- **鼠标削皮** —— 按住拖动，指针经过的字符失去附着、受重力掉落（不是整块消失，是一颗颗掉）
- **点一下坍塌** —— 全部字符坠落、在底部堆成山丘（有休止角，所以是三角斜坡而不是平铺）
- **再点一下复原** —— 全部飞回原位重新拼成文字

拖动与单击用**位移阈值 + 按下时长**区分（拖动超过 `dragThreshold` 或按下超过 `clickMaxMs` 就不算单击），拖动结束后的 300ms 内也会抑制点击，避免"擦完顺手把整座字塔搞塌"。

键盘同样可用：`Space` / `Enter` 切换坍塌，`R` 重置（canvas 可聚焦）。

---

## 用起来

### Next.js（App Router）

`GravityLetters.tsx` 是 `'use client'` 组件；引擎只在 `useEffect` 里创建，服务端渲染只输出一个 `<canvas>`，不碰 `window`。

```tsx
import { GravityLetters } from '@/components/glyph-gravity/GravityLetters';

export default function Hero() {
  return (
    <div style={{ height: '70vh', background: '#07070d' }}>
      <GravityLetters text={'GRAVITY\nLETTERS'} color="#ece9ff" density={7} />
    </div>
  );
}
```

父容器必须有高度（canvas 是 `width/height: 100%`）。

### 命令式控制（ref）

```tsx
const ref = useRef<GravityLettersHandle>(null);
<GravityLetters ref={ref} text="HELLO" />
<button onClick={() => ref.current?.collapse()}>坍塌</button>
<button onClick={() => ref.current?.restore()}>复原</button>
```

### 不走 React（引擎是纯 ESM）

```js
import { createGlyphGravity } from './src/glyphGravity.js';
const api = createGlyphGravity(document.querySelector('canvas'), { text: 'HELLO' });
api.collapse(); api.restore(); api.toggle(); api.reset();
api.getStats();   // { particleCount, frameMs, state, dpr, reduceMotion, glyphSize }
api.destroy();    // 移除所有监听、停掉 rAF、清空画布
```

`demo.html` 就是一个零依赖验证页（拖动 / 单击 / `?test=peel|collapse|collapse-restore`）。

---

## Props

| prop | 默认 | 说明 |
|---|---|---|
| `text` | `'GRAVITY\nLETTERS'` | 任意英文文本，`\n` 换行；自动缩放到容器（宽高都适配） |
| `characters` | `A–Z a–z` | 字符池；默认只有英文字母（可传数字/符号，或任意子集） |
| `density` | `7` | 采样步长（CSS px）。越小越密、字符越多 |
| `glyphSize` | `0` | 字形大小；0 表示由 `density` 推导（`density × 1.35`） |
| `maxParticles` | `14000` | 上限；超出会**自动加大步长重采样**，不会爆 |
| `color` | `#ece9ff` | 文字与待机时的字符颜色 |
| **`fallColor`** | `#5b9dff` | **被削掉 / 坍塌后掉落字符的颜色**；设成与 `color` 相同即关闭变色 |
| `glyphRotation` / `rotationAngles` | `true` / `8` | 掉落字符随机旋转（堆积颗粒感的来源）；角度量化以保住字形缓存 |
| `fontFamily` / `fontWeight` / `lineHeight` / `padding` | 见源码 | 排版 |
| `gravity` | `2000` | 重力加速度 px/s² |
| `eraseRadius` | `48` | 擦除半径 |
| `eraseMode` | `'hover'` | `hover` = 鼠标划过即削（默认，同参考站）/ `drag` = 按住才削 / `both` |
| `dragThreshold` / `clickMaxMs` | `6` / `350` | 拖动 vs 单击的判定 |
| `repose` | `24` | 堆的休止角（相邻列允许的高度差，px）：越大越尖 |
| `shuffle` | `0` | 待机时字符随机跳变的频率。0 = 成形时随机一次后**永不变动**（默认）|
| `reducedMotion` | `'auto'` | 跟随 `prefers-reduced-motion`；`instant` 直接落位不播动画 |
| `restoreSpring` | `false` | **仅诊断用**：复原时改用欠阻尼弹簧（会过冲回弹），用于 A/B 对比，正常别开 |
| **`staticSettle`** | `true` | **坍塌时预计算最终堆积形状**，字符在坠落中平滑滑向自己的最终位置 → 落地即静止，不晃动。`false` = 旧的逐帧沙流（会看到落定后还在互相挪位）|

## 设计要点（为什么这么写）

**掉落字符变蓝 = 按颜色分批绘制，不是逐颗改 fillStyle。** 每帧只切 2-3 次颜色：文字里的用 `color`、飞回原位的用 `color`、被削掉或坍塌的用 `fallColor`。一次批量切换让每帧的状态变更从 O(n) 降到 O(1)，绘制耗时反而从 6.18ms 降到 4.31ms。

**堆积用逐粒子沙堆，不用粒子两两碰撞。** 每列维护一个浮点高度 `heights[col]`：落下的字符按所在列"落到当前表面"，并让该列长高一点、把超出休止角的部分**溢给邻居** —— 于是自然形成侧向斜坡。每帧每粒子 O(1)，而且形状可控（`repose` 直接就是坡度），比真刚体更接近参考图里那种干净的山丘。

**随机旋转很便宜，图集很贵。** 掉落字符随机旋转（量化到 8 个角度）只增加 15% 绘制：`fillText` 5.96ms → 6.83ms（8000 字符）；图集 `drawImage` 要 45.0ms（7.5 倍）。参考站那种沙粒感正是靠旋转 —— 位置抖动做不到，反而会把点阵打散出黑孔。

**逐字 `fillText`，不用预渲染字形图集。** 这条是实测出来的，反直觉：

| 8000 粒子，每帧耗时 | 结果 |
|---|---|
| `ctx.fillText` 逐字 | **4.29 ms**（≈233 fps 上限）|
| `drawImage` 从字形图集贴 | 44.88 ms（≈22 fps）|
| 20000 粒子 · fillText | 13.09 ms（≈76 fps）|

（无头软件光栅、关闭 GPU，绝对值偏悲观；**相对差距**是可靠结论。）字形缓存让 `fillText` 快一个数量级，所以默认走它。真机上如果密度要拉到 3 万以上，再换 WebGL 实例化渲染 —— 绘制层是单一函数，替换成本很低。

**帧循环卫生**：`dt` 钳到 `[0.001, 0.05]`（切回标签页不会"一切飞走"）；`document.hidden` 时 `cancelAnimationFrame`；`ResizeObserver` 重建后**保持"已坍塌"状态**，不会转屏就复原；`document.fonts.ready` 之后再重采样一次（webfont 加载会改变度量）。

**点击坍塌不会晃动：先算形状，再让字符滑过去。** 逐帧沙堆弛豫（`relaxPile`）在**落定之后**还会持续搬动粒子，那就是肉眼看到的"堆在抖"。改为：坍塌瞬间先对**质量直方图**做一次瞬间弛豫（同一条休止角规则，整数搬运），得出每个字符的最终列；坠落过程中字符朝自己的最终位置平滑滑动；期间**关闭逐帧流动**（终态本来就是平衡态）。结果：堆形与流动版完全一致，但落定即静止。指标 `getStats().settleMoves`（本次坍塌后的搬运次数）：预计算模式 **0**，`staticSettle: false` 约 **6200**。

**掉落是"整盘直落"，复原是"单调逼近"——两者都是硬保证，可测。**
坍塌时所有字符初速为 0（`p.vx = p.vy = 0`），整片文字像一整盘沙同时开始下落，不做随机散射；复原用指数逼近 `x += (tx - x) * (1 - e^(-12·dt))`，起始速度最大、随后平滑收束，**数学上不可能越过目标**，所以不会出现弹簧那种"冲过去再弹回来"的上摇。

这两条保证各自有一个计数器，`getStats()` 里随时可查，正常应恒为 0：

| 字段 | 含义 | 期望 |
|---|---|---|
| `returnOvershoots` | 复原途中字符越过目标的次数 | **0**（默认实现）；用 `restoreSpring: true` 的对照实现会得到上万次 |
| `riseCount` | 坠落过程中出现过向上速度的次数 | **0** |

**静止时完全停掉渲染循环。** 字形不再变动（`shuffle: 0`）、也没有粒子在飞时，`requestAnimationFrame` 会彻底停止（`getStats().running === false`），任何交互再唤醒。落地页静止时因此是 **零 CPU / 零耗电**，而不是以 60fps 空转重绘几千个字符。

**SSR 安全**：模块导入时不触碰任何 DOM；引擎的所有副作用都在 `createGlyphGravity` 内、且 `destroy()` 全部回收（监听、rAF、ResizeObserver、matchMedia）。

**可访问性**：canvas 可聚焦 + `aria-label` 描述手势；键盘可完成全部操作；`prefers-reduced-motion: reduce` 时坍塌/复原直接落位不播动画。

## 已知边界 / 下一步

- 只做了英文/数字/符号；中文需要更密的采样与字形缓存（字符数会涨 5–10 倍，得配性能分档）。
- 触屏可用：`hover` 模式下手指移动即削（触屏没有 hover，等价于"按住拖动擦除"），轻点仍是坍塌/复原。
- 手机建议 `density: 9~11`、`maxParticles: 6000` 左右。
- 还没写单测（引擎与 DOM 解耦，可以用 node + jsdom 或直接对纯函数做测试）。
