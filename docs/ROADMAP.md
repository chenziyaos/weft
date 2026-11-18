# Weft 规划（内部历史文档）

> **这份文档是开发者的历史规划记录，不是面向用户的 roadmap。** 它用中文写成，引用了内部源码路径（`src/components/`、`runtime/agents/` 等）。所有列出的阶段**均已完成**（截至 2026-07），保留在这里是为了让读者理解设计决策的来龙去脉。要看面向外的现状描述请读 [完整功能索引](/features) 与 [功能状态](/reference/feature-status)；真正的前瞻计划目前还没有公开版本。

Weft 是无限画布上的思维 DAG，唯一法则是"连线即上下文"。本规划把它推向一个目标：**一张画布同时承载思考、上下文与 Agent**，任何模型、任何 Agent 都能接入，支持本地模型或任何 OpenAI 兼容接口。

## 1. 现状盘点

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 思维 DAG 画布 | 已有：分支、引用、合并、编织、框架、自动布局 | `src/components/`、`src/lib/layout.ts` |
| 上下文编译 | 已有：沿边编译、include/exclude、过期判定 | `src/store/context-builder.ts` |
| 多视角分发 | 已有：N 个角色同题盲答 / 跟随评审 | `FanOutModal.tsx`、`slices/llm.ts#fanOut` |
| 多父合成 | 已有：多选节点引出新节点，真实连线 | `slices/llm.ts#exploreFrom` |
| 模型接入 | 已有：.env 注册 + 浏览器侧 OpenAI 兼容接口 | `server.mjs`、`runtime-providers.ts` |
| Agent 运行时 | 已有：Pi、Codex、Claude Code；桌面 IPC 与本地 HTTP 双通道 | `runtime/agents/` |
| Agent 接入画布 | 已有：`weft mcp`（MCP 服务端）、宿主交接 CLI、Skill | `cli/src/`、`skill/` |
| 记忆 / 回忆 / 会话图谱 | 已有 | `memory.ts`、`recall.ts`、`atlas/` |

## 2. 同类项目调研与吸收

| 项目 | 主要能力 | Weft 的取舍 |
| --- | --- | --- |
| [canvas-chat](https://github.com/ericmjl/canvas-chat) | 多模型"委员会"共答并综合；上下文可视化；多选合并 | **吸收**：同题多模型 + 结构化合成（阶段 2） |
| [thought-canvas](https://github.com/genoooool/thought-canvas) | 兄弟分支各用不同模型，合成共识 / 分歧 / 假设；导出 Markdown 到 Obsidian | **吸收**：合成模板（阶段 2）、Obsidian 导出（阶段 3） |
| [caudalflow](https://github.com/caudal-labs/caudalflow) | 选文分支、多线合并、Copilot 操作画布 | 已具备（分支、`exploreFrom`、`weft mcp`），不重复建设 |
| [agent-canvas（prayagtushar）](https://github.com/prayagtushar/agent-canvas) | 多个 CLI Agent 同画布，连线即可见性，MCP 总线 | 已具备运行时与 MCP；吸收"一个 Agent 可选多家模型"（阶段 1） |
| [agent-canvas（13point5）](https://github.com/13point5/agent-canvas) | 白板 CLI + Skill 让 Agent 操作画布 | 已具备（`weft graph`、Skill） |
| [project-nodal](https://github.com/yibie/project-nodal) | 区域分组、本地优先 | 已具备（框架、IndexedDB） |

结论：Weft 的底座已经比多数同类完整，缺的是两件事——**多模型对照与合成**、**知识外流到笔记库**。

## 3. 分阶段计划

### 阶段 1：模型接入与 Agent 运行时（已完成）

目标：支持任何 OpenAI 兼容接口和本地模型，画布和 Agent 都能接入。

- [x] 服务端提供方支持：OpenAI 兼容接口注册与模型发现。
- [x] 看图能力按实测标注，未测模型保持未知。
- [x] 模型设置界面：API key 管理、自定义端点、模型选择。
- [x] Claude Code 运行时可选不同模型，会话级配置。
- [x] Codex 运行时可选不同模型：会话级提供方覆盖（Responses 协议），共享 app-server 不重启。
- [x] 本地代理确保密钥不出本机。
- 验收（已通过）：画布、Claude Code、Codex 分别用真实托管模型完成生成；浏览器版经本地服务可见 Agent 模型。

### 阶段 2：多模型共答与合成（已完成）

目标：同一个问题交给多个模型，各自盲答成兄弟分支，再一键合成为"共识 / 分歧 / 独到 / 待决 / 下一步"。

- [x] 分发对话框新增"多模型"模式：勾选若干模型，每个模型生成一个分支，分支节点记录所用模型。
- [ ] 角色可指定模型（角色 × 模型）：数据层已支持（`fanOut` 的 `role.model`），对话框里逐角色选模型留作后续。
- [x] "合成"操作：从全部分支引出一个合成节点（真实连线，符合"连线即上下文"），使用结构化合成提示。
- 验收（已通过）：一次操作得到 N 个不同模型的回答与 1 个合成节点，合成节点上下文恰为各分支。

### 阶段 3：知识外流——Obsidian / Markdown 库导出（已完成）

目标：画布成果可以落进个人知识库。

- [x] 导出为 Markdown 库（zip，仓库内无依赖的打包器，UTF-8 文件名）：每个节点一个 `.md`，YAML frontmatter 记录模型、时间、类型；父子与引用关系转成 `[[双链]]`；附总览索引页。
- [x] 框架变成索引页分组；文件节点带提取正文。
- 验收（已通过）：示例画布导出 16 个文件，压缩包校验通过，双链目标全部存在。

### 阶段 4：文档、验证与交付

- [x] README / 中文 README 增加多模型共答、Obsidian 导出章节；`.env.example` 补全配置。
- 全量验证：类型检查、lint、构建、冒烟测试、工作副本 UI 验收、截图回归。
- 以 MR 形式合入 `main`。

## 4. 原则

- **连线即上下文**：任何新功能产生的上下文都必须是画布上可见的边，不偷偷塞文本。
- **密钥不出本机**：所有模型令牌只存在于本机文件与代理进程，浏览器只看到状态。
- **实测再声明**：能力标注（如看图）以真实请求为准，未测即未知。
- **UI 文案不出现第三方品牌名**（功能性标识除外），与 `AGENTS.md` 约定一致。
