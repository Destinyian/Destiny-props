# ChromaHalo 行为验收（G1–G6）

不是「看起来差不多」，而是能重复的抓帧与计数器。

- **环境**：Windows NT 10.0.26200，Chrome 155 headless，1440×900 CSS px，`deviceScaleFactor = 1`，Node 24.16。
- **输入**：真实 `Input.dispatchMouseEvent`（不是页面内 `new PointerEvent`）。一条 S 形快滑从左下到右下：`x 0.16 → 0.84`，`y 0.78 ± 0.09`，40 步、每步约 6 ms（≈240 ms），不按键。
- **采样**：抓帧是完整的 1440×900 PNG；对路径中点 `(0.50, 0.78)`、笔头 `(0.84, 0.78)`、背景 `(0.94, 0.78)` 取 9×9 像素的亮度均值（`0.2126R + 0.7152G + 0.0722B`）。每一次都先抓一张**未划过**的同页帧做基线，避免把 48 px 网格线算成墨。
- **复现**：
  ```bash
  node serve.mjs
  node tools/verify_behavior.js                  # GPU 路径
  HALO_SOFTWARE=1 node tools/verify_behavior.js  # 软件光栅
  ```
  脚本把帧写到 `review/`（本地，不入库），JSON 打到 stdout。

## 总表

| # | 判定 | 证据（本次运行） | 结论 |
| --- | --- | --- | --- |
| G1 | 快速划过留下整条路径 | 光页面 t0：中点亮度 **−61.9**（多次运行 −25…−116；软件光栅 −115.1）；改变区域包围盒 **0.879 × 0.540**，覆盖 36.0%；cheap 对照中点 **0** | 通过 |
| G2 | 停手后继续漂移并变淡（按反馈放慢） | `trail` 1.2 s：t+400 ms 中点 **−10.2**（尾部仍可见），笔头 **−39.4**；t+1.2 s 中点 **−1.0**，`dyeMax = 1.8e-2`；循环在 4.1 s 才停 | 通过（比原规格慢） |
| G3 | 软、带状 / 絮状、有卷曲，不是圆 | t0 包围盒 0.879 × 0.540、覆盖 36.0%，minX 0.099 → maxX 0.978；S 形轨迹 + 速度场使尾端向下鼓成第二瓣；180 px 的 cheap 圆是 0.12 × 0.20、覆盖约 2% | 通过（目视 + 包围盒） |
| G4 | 亮页减法墨、暗页加法烟，模式自动 | 浅色 t0 中点 **−61.9**（变暗）；切到深色后 **2 帧内** 解析为 `smoke`，t0 中点 **+94.7**（白色烟变亮）；深色 t+400 ms 中点 **+23.4**（尾部仍在） | 通过 |
| G5 | 空闲 1.5 s 后漫游者自己画；reduced-motion 永不出现 | 指针在页面内 `active=false`；指针离开 600 ms 时仍 `false`，1500 ms 时 `true`（本场景 `idleDelay=1.2`）；漫游者覆盖 13.8%、`dyeMax 0.61`；reduced-motion 下 `active=false`、`running=false`、1 s 内 `frames` 增量 0 | 通过 |
| G6 | 不拖累页面；空闲零 rAF | p95 **5.1 ms**（GPU；多次运行 4.7–6.6）/ **4.4 ms**（`--disable-gpu`），网格 320×200 = 64k 格、8 passes；`autoplay=0` 静置后 `running=false`，1.1 s 内 `frames` 增量 **0**；1280×720 resize 后网格 320×180、`dyeMax=0`（无拉丝）；4 核自动 `low` + `blur:none` | 通过 |

## G1 / G2：路径与消散

光页面，`ink`，`size=93`、`blur=12`、`quality=medium`、`trail=1.2`、`drift=1.0`。笔刷支持半径是 `size` 的 2.5 倍并在最后 0.5 倍上羽化；只取 1 倍会在半强度处硬切，正是之前方形的来源。按“消散太快、尾部太淡”的反馈，染料寿命从 0.6 s 调到 1.2 s，速度寿命从 0.6 s 调到 1.0 s：

| 时刻 | 中点 ΔL | 笔头 ΔL | `dyeMax` | `running` |
| --- | --- | --- | --- | --- |
| t0（松手后约 25 ms） | **−61.9** | 1.7（黑核） | 1.29 | true |
| t+400 ms | **−10.2** | **−39.4** | 0.227 | true |
| t+1.2 s | **−1.0** | −1.0 | 1.8e-2 | true（4.1 s 才停） |
| t+4.1 s 之后 | 0 | 0 | ~1e-5 | false |

- 这次没有再把「+400 ms 只剩笔头」当作目标：尾部在 +400 ms 仍然明显（−10.2），这是用户要求的「消散慢一点、尾部别太淡」。+1.2 s 时中点只剩 −1（合成量化），`dyeMax` 仍有 1.8e-2，但肉眼已接近干净。
- 循环按 `max(trail, drift) × 3 + 0.5 = 4.1 s` 才停，所以 t+1.2 s 仍 `running=true`；`autoplay=0` 静置 5.2 s 后 `running=false`（G6 的计数器在此条件下仍为 0）。
- 尾部变浓有两个来源：染料寿命变长（每段路径衰减慢），以及 2.5× size 的软裙边（密度不再在 size 处被截断）。

## G3：形状

- t0 改变区域的包围盒 **0.879 × 0.540**，覆盖 **36.0%**；一条从 `x=0.099` 到 `x=0.978` 的带，不是以指针为圆心的圆。
- S 形输入让轨迹在中段转弯，速度场把尾部向下推，形成第二瓣；黑色笔头是「厚处趋黑」的预期结果，不是高斯圆。
- 对照组 `cheap.html` 是 180 px 的 radial-gradient 圆：包围盒约 0.12 × 0.20、覆盖约 2%，而且中心永远跟着指针。

## G4：两种模式

| 页面 | 模式 | t0 中点 | t+400 ms 中点 |
| --- | --- | --- | --- |
| `#f2efe8`（亮） | `ink` / multiply | **−61.9**（变暗） | −10.2 |
| `#08070f`（暗） | `smoke` / screen | **+94.7**（白色烟变亮） | **+23.4** |

- 主题切换由 `MutationObserver` 监听 `data-theme`；`modeAfterTwoFrames = "smoke"`，即两帧内完成解析。
- 深色帧里笔头亮度到 **163**（未划过背景约 11），是屏幕混合的亮核。演示用的是白色烟（`color="#ffffff"`），所以色度为 0、只剩 thin → dense 的亮度映射；传彩色 `color` 时边缘会保留色相。
- 演示页为了避免 CSS 背景过渡被采样到中间值，主题背景是瞬时切换的；组件本身不依赖这一点。

## G5：漫游者与 reduced-motion

| 检查 | 结果 |
| --- | --- |
| 指针在页面内 | `autoplayActive = false` |
| 指针离开 600 ms（`idleDelay=1.2`） | `false` |
| 指针离开 1500 ms | **`true`**，`autoStrength = 0.53`（0.6 s 淡入中） |
| 漫游者绘制 | `dyeMax = 0.61`，改变区域 0.449 × 0.558、覆盖 13.8% |
| `prefers-reduced-motion: reduce` | `reduceMotion=true`，`active=false`，`running=false`，1 s 内 `frames` 增量 0 |

- `!seen` 时（页面刚打开、指针还没进来）规格允许漫游者立即开始；一旦指针出现过，就必须等 `idleDelay`。上表验证的是后者。
- 漫游者使用独立的 `AUTOPLAY_DYE_GAIN = 1.0`（指针是 24），否则它 1/10 的移动速度会在原地堆出一个饱和黑盘。1.2 s 的 trail 已经让漫游者更浓，增益降到 1.0 并加快演示速度，避免它变成盖住标题的实心块。

## G6：预算

| 检查 | 结果 |
| --- | --- |
| p95 JS 帧工作（GPU） | **5.1 ms**（445 帧样本，最近 120 帧的 p95；多次运行 4.7–6.6） |
| p95 JS 帧工作（软件光栅） | **4.4 ms** |
| 网格 / passes | 320×200 / 8（2 平流 + 4 Jacobi + 1 梯度 + 1 上屏） |
| 空闲 `autoplay=0` | `running=false`，1.1 s 内 `frames` 增量 **0** |
| reduced-motion | `running=false`，1 s 内 **0** |
| resize 1440×900 → 1280×720 | 网格 320×180，`dyeMax=0`，没有旧场被拉伸 |
| 低端 4 核 | `quality=low`、网格 216×135、`blur:none`、`degraded="hardware"` |

p95 是引擎内部的 `field + render + putImageData` 时间，不含浏览器合成；headless 环境只能作为同机对照，不能把 5 ms 当成所有笔记本的绝对值。G6 的目标是 8.3 ms，本机两条路径都低于预算。

## 对照组（G1 的控制实验）

`cheap.html` 是同一个 S 形快滑、同一套采样：

| 时刻 | 中点 ΔL | 光标位置 ΔL |
| --- | --- | --- |
| t0 | **0** | **−53.9** |
| t+400 ms | **0** | **−53.9** |

- cheap 的圆永远在指针处，所以路径中点从来没有东西；t+400 ms 它也没有变淡，因为根本没有时间维度。
- 场版本的中点 t0 是 −61.9、t+400 ms 是 −10.2，笔头仍 −39.4。两个签名相反，说明测到的是「记忆」而不是「模糊」。

## 局限

- 抓帧是单帧，不是视频；它证明形状与衰减，不证明帧间运动。
- 每次运行的 ΔL 会随手势速度、落点与 GPU 略有变化（同一条路径多次运行在 −14…−33 之间），但符号、量级和「t+400 ms 中点回背景」这个结论稳定。
- headless GPU 可能回落到 SwiftShader；表中同时给出 `--disable-gpu` 的软件光栅数字。
- 只测了一个视口与一个手势。其他尺寸的网格按 `gridFor()` 规则缩放；性能请在自己的机器上重跑同一脚本。

## 附：生成的文件

运行脚本后 `review/` 中会出现（本地，不入库）：

```text
ink-clean.png            未划过的基线
ink-swipe-t0.png         松手后 25 ms
ink-swipe-t400.png       +400 ms
ink-swipe-t1200.png      +1200 ms
smoke-clean.png          深色基线
smoke-swipe-t0.png       深色 t0
smoke-swipe-t400.png     深色 +400 ms
autoplay-clean.png       autoplay 前的基线
autoplay.png             漫游者绘制 2.6 s 后
cheap-clean.png          cheap 基线
cheap-t0.png             cheap t0
cheap-t400.png           cheap +400 ms
resize-1280x720.png      resize 后的空场
```
