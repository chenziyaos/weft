# Weft 与同类工具

[English](./COMPARISON.md)

下面四个工具里，三个负责搜索或展示本机的编码 Agent 历史；Weft 还能改变模型下一轮读到的内容。本页的比较只用各项目截至 2026-11-19 在自己 README 里写明的内容，没有做过基准测试。如果某一格已经过时，欢迎提 issue 或 PR。

## 一句话区别

- **Weft** 回答「哪几轮动过这个文件、当时说了什么」，并让你在画布上改下一轮模型读到的上下文。
- **[episodic-memory](https://github.com/obra/episodic-memory)** 让 Agent 按语义回忆过去的对话。
- **[claude-historian-mcp](https://github.com/Vvkmnn/claude-historian-mcp)** 通过 MCP 搜索 Claude Code 历史，不在磁盘上留索引。
- **[claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer)** 是桌面应用加 Web 服务，用来浏览和分析多种助手的历史。

## 对照表

| | Weft | episodic-memory | claude-historian-mcp | claude-code-history-viewer |
|---|---|---|---|---|
| 主要用途 | 找出某个文件或某句话背后的轮次；在画布上编辑下一轮的上下文 | 给 Agent 做语义回忆 | 通过 MCP 搜索和总结历史 | 浏览、搜索、分析历史 |
| 读取的来源 | Claude Code、Codex、DeepSeek Harness、Pi、Weft 画布 | Claude Code、Codex、Cursor、opencode、Oh My Pi | Claude Code 会话 JSONL | 据其 README 共 31 种助手 |
| 检索方式 | 按锚点查（文件路径、URL、arXiv 编号），短语精确匹配、不区分大小写 | 语义检索 | 模糊匹配与查询扩展；其 README 列了 12 种算法 | 应用内搜索 |
| 是否写磁盘 | 派生索引写在 `~/.weft`；原会话日志从不改写 | 每次会话结束时建索引 | 据其 README 不写 | 本页未涉及 |
| 给 Agent 的接口 | 只读 MCP server（4 个工具）、`/weft` 与 `$weft`、画布 Skill | MCP server、Claude Code 与 Codex 插件 | MCP server | 无，是给人看的查看器 |
| 能否改变模型下一轮读到什么 | 能：在画布上剪断、改接或归档上下文 | 不能 | 不能 | 不能 |

## 怎么选

- **选 episodic-memory**：希望 Agent 按意思而不是按原词回忆过去的讨论。
- **选 claude-historian-mcp**：想要免安装、不在磁盘上存任何东西的历史搜索。
- **选 claude-code-history-viewer**：主要是在一个窗口里阅读、分析多种助手的会话。
- **选 Weft**：想从改过某个文件的轮次里回答「这个文件为什么是现在这样」，或者想在画布上精确决定下一次请求带上哪些旧轮次。

这几个工具可以同时装：它们都只读会话文件。

## 本比较的局限

- 其他工具那几列来自它们的 README，没有实际运行。
- Weft `find` 的「精确」指不做词干、同义词或向量匹配，换个说法就搜不到。
- Weft 的 MCP server 不能编辑画布。编辑走画布 Skill 和实时桥，由用户逐个画布开启。
