# GravityLetters · 重力文字

把一段文字栅格化成上千个小字符：字符能被指针「削」掉、整片坍塌成沙山，再完整复原。

## 用途

以文字本身为主角的 hero 区或标题区——希望访客愿意动手玩一玩，并且离开后标题会自己恢复完整。

## 交互说明

| 输入 | 行为 |
| --- | --- |
| 鼠标划过字面（无需按任何键） | 像削皮一样削掉指针路径上的字符；它们下落、变为浅蓝、堆到底部 |
| 左键单击 / 空格 / 回车 | 整片文字同时直落，堆成几座圆顶沙山 |
| 再次单击 / 再次按键 | 全部平滑飞回原位，被削掉的字符一并复原 |
| 停手 10 秒 | 自动复原（`autoRestoreMs`，设为 0 可关） |
| R | 重置为完整文字 |
| 手指拖划 | 等价于鼠标划过（触屏没有 hover） |

## 如何运行

无第三方依赖，任意静态服务器即可（ES 模块不能走 `file://`）：

```bash
node serve.mjs          # -> http://127.0.0.1:4179
```

演示页支持 URL 参数实时调参：
`?peaks=2`（山数）`?peakmass=0.6`（底盘占比）`?repose=18`（坡度）`?density=5`（字符密度）
`?fall=%238fb8ff`（掉落颜色）`?erase=drag`（按住才削）`?auto=0`（关自动恢复）`?hud=0`（隐藏 HUD）。

行为测试（不需要画布，测的是堆积剖面这个纯函数）：

```bash
node --test tests/pile.test.mjs
```

## 验收步骤

1. 鼠标划过字面 → 字符被削掉、掉落变浅蓝、堆成沙丘。
2. 左键点一下 → 整片直落、堆成几座圆顶山，山间有平坦底盘；**落定后静止不动**（HUD 的 `settleMoves` 应为 0）。
3. 再点一下 → 全部飞回原位，**无回弹**（`returnOvershoots` 应为 0），文字完整无缺。
4. 停手 10 秒 → 自动复原。
5. 静置时 HUD 显示 `running: false`：渲染循环已停止，静止时零 CPU。
6. 聚焦画布后空格/回车可切换；系统开启「减弱动态效果」时直接落位、不播动画。
7. 收窄到手机宽度，用手指拖划可削、轻点可切换。

## 已知边界

- 字符池默认只有英文字母（`characters` 可替换）。中文需要更高采样密度与字形缓存，目前未做。
- 未做自适应降档：低端机请自行调低 `density` 或 `maxParticles`。
- 削皮路径的堆积仍走逐帧沙流（削下来的碎屑是动态增加的质量），削完之后会有少量局部搬动（`settleMoves` 数十次量级）；点击坍塌那条路径是零搬动。
- 画布容器必须有明确高度；容器尺寸变化会重建栅格（保留已坍塌状态）。

## React 接入

```tsx
import { GravityLetters } from './src/GravityLetters';

<div style={{ height: '70vh', background: '#07070d' }}>
  <GravityLetters text={'GRAVITY\nLETTERS'} fallColor="#a9c8ff" autoRestoreMs={10000} />
</div>
```

把 `src/` 下三个文件（`glyphGravity.js`、`GravityLetters.tsx`、`glyphGravity.d.ts`）一起复制进目标项目即可，无第三方依赖。`GravityLetters.tsx` 是 `'use client'` 组件，`ref` 上暴露 `collapse / restore / toggle / reset / rebuild / getState / getParticleCount / getStats`。

## 目录

```text
GravityLetters/
├── src/            引擎与 React 封装（自包含，不依赖本仓库其他目录）
├── tests/          堆积剖面的行为测试
├── index.html      可直接打开的演示与调参页
├── serve.mjs       零依赖静态服务器
├── review/         验收截图（本地，不入库）
└── 工具/           绘制基准与真实输入验证工具（本地，不入库）
```
