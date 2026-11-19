# 验收记录与验证边界

本文记录在本仓库上跑过哪些验收脚本、每项结果覆盖什么，以及**没有**证明什么。功能说明见 [README_ZH.md](README_ZH.md)。

[English](VERIFICATION.md)

## 运行环境

| 项 | 值 |
|---|---|
| 日期 | 2026-11-18 |
| 代码 | 本仓库首次公开提交前的工作树 |
| 系统 | macOS 15.6.1（Apple silicon） |
| Node.js | v26.7.0（CLI 要求 Node 20 及以上） |
| 浏览器 | 本机 Google Chrome，由 Playwright 驱动 |
| 依赖 | `npm ci`，全部来自公共 npm registry |
| 模型 | 无；下列脚本都没有调用模型 |

脚本把证据（summary JSON、截图）写进 `evidence*/` 目录，这些目录被 git 忽略。需要证据时重跑对应脚本即可；下表的计数是这些运行打印的结果。

## 构建与单元检查

| 命令 | 结果 |
|---|---|
| `npm run build`（类型检查 + 生产构建） | 通过 |
| `npm run lint` | 通过 |
| `npm --prefix cli test` | 通过：95/95 |
| `npm run test:layout` · `test:live-log` · `test:subagents` | 通过 |
| `npm run website:build` 后 `npm run website:check` | 通过 |

## 验收脚本

每个脚本都从公开入口驱动构建后的产品：真实的本地代理、Chrome 里的构建页面，或以子进程调用的 CLI。没有脚本通过导入产品内部函数来伪造结果。除非表中另有说明，运行中出现的答案都是合成样本。

| 脚本 | 检查内容 | 结果 |
|---|---|---|
| `verify-cli-package.mjs <tgz>` | 把 `weft-canvas` 安装包装进空项目；`weft serve`；打开画布；上传 PDF；`weft setup skill`；Agent 实时改画布；重复启动；端口冲突；Ctrl+C 退出 | 通过：12/12 |
| `verify-install-release.mjs` | 通过 20 条公开 Node 命令全新安装；12 个 Skill 文件的大小和 SHA-256 与清单一致；dry run 不改项目；重复安装被拒绝 | 通过：53/53 |
| `verify-byo.mjs` | 不配 key、不配模型：代理空启动；在对话框里添加 OpenAI 兼容端点后列出其模型；自建 `/v1/systemone` 端点成为决策模型并给两模型扇出排序（本地替身端点） | 通过：9/9 |
| `verify-context-visible.mjs` | 追问预览与页面发出、代理转发的请求逐条一致；每个回答版本保留其请求；标出此后变化的行；拖线重连拒绝成环；插入与删除中间一步 | 通过：35/35 |
| `verify-replay-plan.mjs` | 一键重放按依赖顺序重跑过期节点，跳过输入未变的节点，失败节点之下不再运行，并可一键重试 | 通过：13/13 |
| `verify-tool-outputs.mjs` | 早先的工具输出默认不进追问；附件面板标出它们，点一下可带回其中一条；请求过大时给出提示 | 通过：9/9 |
| `verify-local-atlas.mjs` | `weft setup skill` 安装 `/weft` 和 `$weft`；`weft open` 后台启动服务并打开一个 Claude Code 会话；追加到会话文件的一轮自动出现在画布上；`weft stop` 结束服务 | 通过：17/17 |
| `verify-canvas-bridge.mjs` | 实时画布桥接：token 文件权限、未授权与外部来源拒绝、分支与引用编辑、幂等重放、版本冲突、撤销、写回、刷新后关闭 | 通过：27/27 |
| `verify-multi-agent.mjs` | 两个宿主从同一版本同时改一张画布：恰好一个成功，另一个收到 `REVISION_CONFLICT`；兄弟分支互不可见；下游过期回答进入队列 | 通过：16/16 |
| `verify-workspace-cli.mjs` | 公开 workspace CLI，纯图入口与统一入口，大小与结构限制 | 通过：308/308 |
| `verify-workspace-ui.mjs` | 构建 UI 中的 workspace 往返：刷新、重复导入、冲突拒绝、跨标签页保存 | 通过：36/36 |
| `verify-hydration-ui.mjs` | 延迟读取与注入 IndexedDB 读取失败下的项目加载；已存数据不会被空项目替换 | 通过：13/13 |

`verify-hydration-ui.mjs` 通过，表示数据保护相关检查通过，不代表页面没有报错：注入的失败会传到并非都会捕获它的调用方，所以运行记录里有预期内的 `pageerror`。

## 本次未运行的脚本

| 脚本 | 未运行原因 |
|---|---|
| `verify-real-host.mjs` | 需要已登录且有模型权限的 Claude Code 和 Codex；模型通过 `WEFT_E2E_CLAUDE_MODEL` / `WEFT_E2E_CODEX_MODEL` 指定，见脚本开头 |
| `e2e-user-journey.mjs` | 需要代理里配置至少三个真实模型，并登录 Codex |
| `test-memory-judge.mjs` | 需要真实的判定模型 |
| `npm run smoke` | 会调用已配置的模型 |

## 验证边界

以下内容**没有**被上述运行证明，不能当作已验证：

- **没有真实模型。** 这些运行里的答案都是合成样本或来自本地替身端点。回答质量、各家 provider 的兼容性、决策模型的校准都没有测量。
- **没有真实宿主。** 本次记录没有覆盖 Claude Code、Codex 发现并运行已安装 Skill 的过程。bundle 里的 `host`、`runId`、`executionMode` 是调用方的声明，不是证据。
- **没有隔离验证。** 与上一会话的隔离、环境记忆的排除、执行边界都由宿主负责。`isolationVerified` 按设计恒为 `false`。
- **两个平台。** 上表是 macOS + 本机 Chrome 的结果。从 2026-11-19 起，`.github/workflows/acceptance.yml` 每晚在 Linux（ubuntu-latest、Node 22、runner 自带的 Google Chrome）上跑表中的 12 个脚本。Windows、移动端浏览器和 Node 20 没有跑这些脚本；CI 在 Node 20、22、24 上跑构建、lint 和单元测试。
- **限制没有做压力测试。** `verify-workspace-cli` 会拒绝超出 32 MiB 一个字节的文件和含 501 个操作的编辑。节点、边、深度限制（500 个节点、4,000 条边、深度 128）以及接近任何限制时的大规模表现都没有测量。
- **指纹只覆盖画布编译出的输入**，不覆盖 provider 侧状态或 Agent 运行时自带的系统提示词。哈希能发现漂移，不能证明作者身份。
- **持久化保护有范围。** 普通保存用 compare-and-set，workspace 同步会检查已存的封装。跨标签页的项目元数据变更、删除、迁移、真实磁盘故障和配额恢复不在承诺之内。遇到保存冲突时，请**先**导出未保存的编辑再刷新。
- **交接包内嵌完整的图快照**，可能包含所选上下文之外的节点；分享前请检查。
- **没有脚本的部分。** 桌面壳、DeepSeek Harness 插件（`dsh/`）、Remotion 视频和 benchmark 工具只做了构建或保留源码，这里没有验收运行。
