---
name: weft
description: Weft 本地 CLI——画布应用（weft serve）、让本地 agent 编辑画布的 Skill、以及覆盖 Claude Code / Codex / DeepSeek Harness / Pi 会话的 why 层（按文件追溯历史对话）。源码会话只读，索引存于 ~/.weft。
---

# Weft CLI

Weft 把「模型读到的上下文」变成画布上可见、可剪、可重连的线。`weft` 命令行打开画布、索引本机 agent 会话，并回答「这个文件是被哪些对话塑造成的」。

- 包名：`weft-canvas`，bin `weft`，入口 `dist/weft.mjs`
- 要求 Node.js ≥ 20；无第三方运行时依赖
- 事实全部来自会话文件里的 tool call，不来自模型自由文本；源会话永不写入
- 索引与缓存：`~/.weft`（目录 0700、文件 0600），`weft purge` 可全部删除

## 安装

```bash
git clone https://github.com/chenziyaos/weft.git
cd weft && npm install
npm run cli:pack
npm install -g ./cli/weft-canvas-*.tgz
```

## 命令一览

```
weft serve [--port N] [--no-open]            # 打开画布应用（127.0.0.1 本地服务，默认端口 3001）
weft open <session-id | weft://link> [--port N]
                                             # 在画布中打开一个 Claude Code / Codex / Pi 会话；无服务时后台启动
weft stop                                    # 停止 weft open 启动的后台服务
weft index [--full] [--canvas <dir>]         # 构建/刷新索引（--canvas 同时索引画布备份目录，会被记住）
weft why <path> [--include-read] [--all] [--limit N] [--json]
                                             # 触碰过某文件的各轮对话及其说了什么
weft why --check <path> [--fresh] [--json]   # 一行回答「这里有没有历史」，exit 0 有 / 1 无（cheap）
weft find "<phrase>" [--in q|a|m] [--limit N] [--json]
                                             # 检索这些词出现在哪些提问(Q)/回答(A)/材料(M)里
weft recall <session> <n>                    # 完整回看某一轮（session id 或前缀；也支持 memory id）
weft memories                                # 索引持有的 memory 文件（Claude Code memory 目录、Codex memories）
weft suggest <term> [--limit N] [--json]     # 从索引文本里给出拼错词的可能原词
weft topics [--of <id>] [--json]             # 主题表与标签覆盖情况（在 app 里命名/打标）
weft status                                  # 索引概况与证据量
weft purge [--cache]                         # 删除本工具存储的一切（--cache 仅删解释/文本缓存）
weft events <session-file> [--touches]       # 单个源会话文件的 canonical events，每行一条 JSON
weft bundle publish --file <canvas.weft.json> --node <id> [--tag name]
                                             # 把某节点的上下文编译成可移植 bundle,落到 ~/.weft/bundles/<id>/
weft bundle pull <id|tag> [-o out.md]        # 打印 bundle 的开头消息(同画布剪贴版的 Markdown),-o 写到文件
weft bundle list [--json]                    # 列出所有已存 bundle,新的在后
weft bundle show <id|tag> [--json]           # 单个 bundle 的 graph anchor、budget 与 content hash
weft mcp                                     # 以 stdio MCP server 提供 why_check / why_file / find / recall_turn（只读）
weft setup [mcp | rules [--remove]]          # 注册 MCP（本项目 + Codex）、增删本项目 CLAUDE.md/AGENTS.md 里的两条规则；无参显示状态
weft setup skill [--hosts codex claude dsh] [--apply]
                                             # 安装画布 Skill（.agents/.claude/.dsh skills）与 /weft、$weft 会话打开命令；默认 dry-run
weft graph <command>                         # 原生 graph / workspace 实时画布命令，`graph --help` 查看
```

## 三块能力

1. **打开画布**：`weft serve` 在 `http://localhost:3001` 起本地服务并在浏览器打开；画布存在浏览器该地址的存储里，换端口会看到一个空列表。`weft open <session-id>` 直接打开某个会话的图，无服务时后台拉起（日志 `~/.weft/serve.log`，`weft stop` 停止）。
2. **why 层（会话索引）**：`weft index` 之后，`weft why <file>` 列出读过/写过/改过该文件的各轮对话：何时、改了什么、问了什么、回答里怎么说。`Δ` 行是观测到的变更，`≈` 行是从回答里读出的候选解释，不是已证实的原因。
3. **让 agent 自助**：
   - `weft setup mcp` 在本项目 `.mcp.json`（Claude Code，项目级）和 `~/.codex/config.toml`（Codex）注册只读 MCP server，agent 获得四个检索工具。
   - `weft setup rules` 给本项目 `CLAUDE.md` / `AGENTS.md` 追加带标记的两条规则（改文件前查历史；解释代码成因前先查），`--remove` 可逆移除。
   - `weft setup skill --apply` 安装 `weft-canvas` Skill 与 `/weft`（Claude Code）、`$weft`（Codex）；配合画布 host handoff 面板勾选「允许本地 agent 编辑」，终端 agent 即可通过 `weft graph canvas-*` 在画布上分支、接线、回写。

## 项目内的位置

- 源码：`cli/src/main.ts`（派发 + MCP server + serve/open/setup）与 `cli/src/lib.ts`（索引、查询、渲染，约 1600 行）
- 构建：仓库根 `npm run cli:build` 产出 `cli/dist/weft.mjs`；发布走 `cd cli && npm publish`（prepack 自动 stage 画布、Skill 与安装脚本）
- 测试：`cd cli && npm test`（构建 + `node --test test/*.test.mjs`）
- 详情：仓库根的 `README.md`、`ARCHITECTURE.md`、`VERIFICATION.md`；行为口径以 `cli/README.md` 与 `weft --help`（USAGE）为准
