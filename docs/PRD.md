# PRD：修复 dsh 桌面 dev 实例 chokidar junction 循环扫描导致 CPU 风暴
> 版本: v0.1 | 日期: 2026-10-10 | 状态: 待确认

## ① 背景与问题（Problem）

主理人的 Windows 11 机器上，dsh 桌面端 dev 实例（`dsh-desktop-host`，0.2.0-rc.2）主进程持续占用 ~2.5 个 CPU 核心，风扇不停高转。经 CPU profile 与 inspector 取证实锤：chokidar/readdirp 在无休止地做目录扫描（每条目 lstat + 路径归一化）。根因是 dev project 的 node_modules 由 1527 个 junction 指向 pnpm 中央 store（内部存在循环链接），而 chokidar 默认 `followSymlinks: true` 会跟随 junction 进入循环图永不终止；同时 hmr 的 `ignored` 过滤器存在独立 bug——`picomatch(relative(watchBaseDir, path))` 在 Windows 反斜杠路径下匹配失败（实测 `**/node_modules` 无法匹配 `node_modules\foo`），防线双重失效。上游 GitHub（截至 2026-10-09）无相关修复与 issue。

## ② 目标（Goals）

- 桌面 dev 实例主进程 CPU 占用从 ~11%（2.5/24 核）回落到正常水平（< 2%）
- 任何包含 junction/symlink 循环的目录树都不会导致 watcher 扫描不终止
- Windows 反斜杠路径下 ignored 过滤器正确生效（node_modules 被可靠排除）

## ③ 非目标（Non-Goals / 不做什么）

- **不加防御深度监控**（watcher 预算/junction 告警）：scope 纪律，后续另开 issue
- **不改 skill-filesystem 的 `followSymlinks` 默认值**：它有显式配置项且 depth:1 限制爆炸半径，改默认值会破坏 symlink 组织技能目录的用户场景
- **不动 watchConfig 与 credentials-local**：watch 树极小（单文件/单文件父目录），无循环风险
- **不处理 GPU 侧温度**（Wallpaper Engine 占用）：与本次 bug 无关

## ④ 目标用户（Users）

- dsh 桌面端/CLI 的开发者（Windows + pnpm dev 环境）：不再被 CPU 风暴拖累
- 上游所有 Windows 用户：junction/symlink 循环树不再引发 watcher 失控

## ⑤ 用户故事（User Stories）

- 作为 Windows 开发者，我启动桌面 dev 实例后，风扇保持安静，CPU 留给编译和 AI 任务。
- 作为插件开发者，我通过 junction 链接本地插件（@local/*）时，插件热重载依然正常工作。
- 作为维护者，我合入的修复有回归测试保证 junction 循环树问题不复发。

## ⑥ 功能清单（Feature List）

| 编号 | 功能 | 优先级 |
|---|---|---|
| F1 | hmr 主 watcher 加 `followSymlinks: false` | P0 |
| F2 | fs-local `watch()` 加 `followSymlinks: false` | P0 |
| F3 | hmr `ignored` 匹配器改用 `picomatch(ignored, { windows: true })` | P0 |
| F4 | 回归测试：junction 循环树扫描终止 + 反斜杠路径 ignored 生效 | P0 |
| F5 | 实机验证：重建 dev 实例并观测 CPU | P0 |

## ⑦ 页面与交互（Pages & UX）

不涉及 UI。改动点：

| 文件 | 改动 |
|---|---|
| `packages/boot/hmr/src/index.ts` | watcher options 加 `followSymlinks: false`；`picomatch(ignored, { windows: true })` |
| `packages/fs/fs-local/src/index.ts` | watcher options 加 `followSymlinks: false` |
| `packages/boot/hmr/tests/`（新 spec） | 循环树 + 反斜杠 ignored 回归测试 |

## ⑧ 数据字段（Data Fields）

不涉及业务数据。

## ⑨ 业务规则（Business Rules）

- R1: 热重载能力不变——hmr 的 `loadDependencies` 本就把 `/node_modules/` 下模块视为 externals（仅 full reload），关闭 followSymlinks 不损失任何热重载能力
- R2: skill-filesystem 行为零变化（不改其默认值与配置项）
- R3: 提交只包含本次修复相关文件，不夹带工作区既有的未提交改动
- R4: commit 与 PR 创建前须经主理人过目（外发动作确认）

## ⑩ 验收标准（Acceptance Criteria，可测试）

- AC1: Given 一个含 junction/symlink 循环的临时目录树（A→B→A）作为 watch root，When chokidar watch 启动并等待就绪，Then 扫描在有限时间内完成（测试不超时），进程可正常退出
- AC2: Given ignored 含 `**/node_modules` 且传入 Windows 反斜杠相对路径（如 `node_modules\foo`），When 调用修复后的匹配器，Then 目录 `node_modules` 被判定为 ignored、chokidar 不递归进入
- AC3: Given 修复后的代码，When 运行 `packages/boot/hmr` 与 `packages/fs/fs-local` 既有测试套件，Then 全部通过，无行为回归
- AC4: Given 重新构建并重启的桌面 dev 实例，When 空闲 10 分钟后采样，Then 主进程（PID 对应 `dsh-desktop-host`）CPU 占用 < 2%，FSWatcher 数量不再随时间增长

## ⑪ 成功指标（Success Metrics，可选）

- dev 实例空闲 CPU 从 ~11% 降至 < 2%；笔记本风扇恢复静音
- 上游 PR 合入前通过全部 CI

## ⑫ 风险与依赖（Risks & Dependencies，可选）

- 元凶的 5 个调用点归属尚未 100% 锁死（ESM 环境无法运行时拦截）；对策：全部加固，覆盖所有可能
- junction 循环测试在 Windows 需 `mklink /J`（无需管理员），POSIX 用 symlink；CI 跨平台行为需在测试里做平台分支
- 实机验证依赖主理人配合重启桌面 dev 实例

---
- 依据: grill-me 对齐共识（2026-10-10，六项决策见对话记录）
