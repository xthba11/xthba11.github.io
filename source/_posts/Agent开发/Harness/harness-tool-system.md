---
title: Harness 工具系统与 Tool 定义 —— 从 Schema 到沙箱执行
date: 2026-03-25
categories:
  - Agent开发
  - Harness
tags:
  - Harness
  - Tool
  - Schema
  - JSON Schema
  - MCP
  - 沙箱
  - 权限
description: Harness 工具系统深入：Tool 的 JSON Schema 定义规范、工具调用生命周期（Parse → Validate → Authorize → Execute → Return）、内置工具分类、MCP 工具集成、沙箱隔离机制、超时与重试策略
cover: /img/covers/articles/harness-tool-system.svg
top_img: /img/covers/articles/harness-tool-system.svg
---

# Harness 工具系统与 Tool 定义

## 1. 工具在 Harness 中的定位

工具是 Agent 与外部世界交互的**唯一通道**。没有工具，Agent 只能生成文本；有了工具，Agent 可以读文件、跑命令、搜代码、发网络请求。

```
┌─────────────────────────────────────────────────────────┐
│  Agent 的工具视角：                                       │
│                                                         │
│   模型 → "我需要看这个文件" → tool_use(Read, {path})      │
│         → "我要搜索这个函数" → tool_use(Grep, {pattern})  │
│         → "我要运行测试"     → tool_use(Bash, {cmd})      │
│                                                         │
│   Harness 负责：                                          │
│    ① 把工具"介绍"给模型（Schema）                          │
│    ② 解析模型的工具调用请求                                │
│    ③ 检查权限 → 安全执行 → 返回结果                        │
└─────────────────────────────────────────────────────────┘
```

## 2. JSON Schema 定义规范

每个工具对外暴露一组 JSON Schema 定义，告诉模型"我能做什么、需要什么参数"：

### 2.1 内置工具示例：Grep

```json
{
  "name": "Grep",
  "description": "内容搜索基于 ripgrep。支持完整正则语法。建议用 Grep 而不是 bash grep/rg。",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "要搜索的正则表达式模式"
      },
      "path": {
        "type": "string",
        "description": "要搜索的文件或目录。默认当前工作目录"
      },
      "glob": {
        "type": "string",
        "description": "文件名过滤的 glob 模式，如 \"*.js\""
      },
      "output_mode": {
        "type": "string",
        "enum": ["content", "files_with_matches", "count"],
        "description": "输出模式：content 显示匹配行，files_with_matches 只显示文件路径，count 显示计数",
        "default": "files_with_matches"
      },
      "-i": {
        "type": "boolean",
        "description": "是否忽略大小写"
      },
      "head_limit": {
        "type": "number",
        "description": "限制输出前 N 条结果",
        "default": 250
      }
    },
    "required": ["pattern"]
  }
}
```

### 2.2 Schema 设计原则

```text
┌─────────────────────────────────────────────────────────┐
│ ① 描述即文档                                            │
│   description 要充分具体——模型依赖它来选择正确的工具       │
│   坏："搜索文件"                                          │
│   好："内容搜索基于 ripgrep。支持完整正则语法。建议优先使用  │
│        而非 bash grep/rg。过滤使用 glob 或 type 参数。"    │
│                                                         │
│ ② 参数要有默认值                                         │
│   减少模型需要思考的决策数量 → 提高调用效率                 │
│   head_limit 默认 250 → 模型不需要纠结"该限多少条"         │
│                                                         │
│ ③ 枚举优于自由文本                                        │
│   output_mode: enum → 模型不会写错模式名                   │
│   自由文本 → 模型可能写 "content_only" 或 "full" 等不存在值 │
│                                                         │
│ ④ required 最小化                                        │
│   只标记真正必需的参数 → 其他参数可选 → 模型灵活组合         │
│   过多的 required → 模型花 tokens 编造参数值               │
└─────────────────────────────────────────────────────────┘
```

## 3. 工具调用生命周期

```
  Step 1: Model Output
    │  模型输出 tool_use block
    │  { "name": "Read", "input": { "file_path": "/src/main.c" } }
    ▼
  Step 2: Parse
    │  Harness 解析 JSON → 提取 tool_name + arguments
    │  校验 JSON 格式合法性
    ▼
  Step 3: Match
    │  按 name 查找已注册的工具
    │  未匹配 → 返回 Tool Error (tool not found)
    ▼
  Step 4: Validate Schema
    │  JSON Schema 校验 arguments
    │  required 字段缺失 → 返回 Validation Error（模型会重试）
    │  类型不匹配 → 同上
    ▼
  Step 5: Authorize
    │  ┌──────────────────────────────┐
    │  │ Permission 检查：              │
    │  │  ① Mode == bypass     → 放行  │
    │  │  ② allowlist 匹配      → 放行  │
    │  │  ③ denylist 匹配       → 拒绝  │
    │  │  ④ Hook PreToolUse     → 拦截  │
    │  │  ⑤ 弹出用户确认对话框   → 待定  │
    │  └──────────────────────────────┘
    ▼
  Step 6: Execute
    │  实际执行工具逻辑
    │  - Bash: spawn shell 进程
    │  - Read: fs.readFile
    │  - Grep: spawn rg 进程
    │  - Agent: 创建子代理 → 独立对话循环
    ▼
  Step 7: Post-Process
    │  Hook PostToolUse 触发
    │  Sandbox 清理（如果是隔离执行）
    │  超时检测 → 超时则返回 Timeout Error
    ▼
  Step 8: Return
    │  结果注入对话上下文 → 模型看到 tool_result
    │  格式：
    │  { "tool_use_id": "tool_xxx",
    │    "content": [{ "type": "text", "text": "..." }],
    │    "is_error": false }
    ▼
  模型继续推理（可能调用更多工具，或输出最终文本）
```

## 4. 内置工具分类

| 类别 | 工具 | 说明 |
|------|------|------|
| **文件操作** | Read, Write, Edit, Glob | 读写编辑文件、模式匹配查找 |
| **代码搜索** | Grep | ripgrep 内容搜索（比 find+grep 高效） |
| **Shell 执行** | Bash | POSIX sh 命令（非 cmd/PowerShell） |
| **Agent 管理** | Agent, SendMessage, TaskOutput, TaskStop | 子代理创建/通信/控制 |
| **权限管理** | AskUserQuestion | 模型向用户发起多选/单选提问 |
| **Git 操作** | EnterWorktree, ExitWorktree | 隔离工作区 |
| **网络** | WebFetch, WebSearch | HTTP 请求、网络搜索 |
| **任务编排** | TodoWrite, Workflow, Skill, ScheduleWakeup | 任务列表、工作流、定时 |
| **设计** | DesignSync, NotebookEdit | 设计系统、Jupyter 编辑 |
| **计划** | EnterPlanMode, ExitPlanMode | 计划模式 |

## 5. Bash 工具：最强大也最危险

### 5.1 执行模型

```bash
# Bash 工具的特殊设计：

# ① POSIX sh 环境（非 cmd、非 PowerShell）
#    在 Windows 上自动使用 Git Bash
#    命令语法统一：/dev/null 而非 NUL

# ② 工作目录持久化
#    每次 Bash 调用共享同一个 shell 环境中的工作目录
#    cd 的效果会保留（但环境变量不会）

# ③ 超时控制
#    timeout_ms: 默认 120000 (2min), 最大 600000 (10min)
#    超时 → 进程被 SIGKILL → 返回部分输出 + timeout 标记

# ④ 后台执行
#    run_in_background: true → 不等待完成
#    Harness 追踪进程 → 完成后发送 task-notification

# ⑤ 沙箱隔离（可选）
#    dangerouslyDisableSandbox: 默认 false
#    沙箱 = 文件系统限制 + 网络限制 + 命令过滤
```

### 5.2 Git 操作封装

```bash
# Harness 对 Git 操作有特殊优化：
#   不支持交互式 Git 命令（git rebase -i, git add -i）
#   建议优先使用 gh CLI 操作 GitHub
#   自动处理 Windows 路径中的反斜杠
```

## 6. MCP 工具集成

MCP (Model Context Protocol) 是标准化的工具协议，允许外部服务注册工具供 Agent 调用：

```
┌──────────────────────────────────────────────────────┐
│               MCP 工具集成架构                         │
│                                                      │
│  Harness  ←── MCP Client ──→  MCP Server             │
│            JSON-RPC 2.0      ┌──────────────────┐   │
│                               │ tools/list        │   │
│  ① 发现工具 ◄─────────────────┤ 返回工具 Schema    │   │
│                               │                  │   │
│  ② 调用工具 ──────────────────► tools/call        │   │
│                               │ 返回执行结果       │   │
│  ③ 接收结果 ◄─────────────────┤                  │   │
│                               └──────────────────┘   │
│                                                      │
│  MCP Server 来源：                                    │
│    • 本地进程（stdio / socket）                       │
│    • 远程服务（HTTP / WebSocket）                     │
│    • Docker 容器                                      │
│    • npm 包 (npx @anthropic/mcp-server-xxx)          │
└──────────────────────────────────────────────────────┘
```

### 6.1 注册 MCP Server

```jsonc
// .claude/mcp.json 或 settings.json 中注册
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-postgres", "postgresql://localhost/mydb"]
    }
  }
}
```

### 6.2 MCP 工具调用流程

```
Agent 调用工具 "mcp__filesystem__read_file"
    │
    ▼
Harness 路由: 前缀 "mcp__" → MCP 工具
    │
    ▼
查找 MCP Server "filesystem"
    │
    ▼
构造 JSON-RPC 请求:
    {
      "jsonrpc": "2.0",
      "method": "tools/call",
      "params": {
        "name": "read_file",
        "arguments": { "path": "/data/config.json" }
      },
      "id": 1
    }
    │
    ▼
通过 stdio/socket 发送给 MCP Server
    │
    ▼
接收响应 → 提取 content → 返回给 Agent
```

## 7. 沙箱隔离机制

### 7.1 沙箱层级

```
Level 0: 无沙箱（dangerouslyDisableSandbox = true）
  → Agent 可以访问整个文件系统、网络、任意命令
  → 仅在用户明确信任的操作中使用

Level 1: 路径沙箱（默认）
  → 文件操作限定在工作目录内
  → Shell 命令可以访问系统工具但不能修改系统文件
  → 网络访问允许

Level 2: 网络隔离
  → 额外限制网络访问
  → 只能访问白名单域名

Level 3: 只读沙箱
  → 文件系统只读
  → 仅允许纯查询类操作（Read / Grep / Glob）
```

### 7.2 超时与重试

```
超时配置：
┌──────────────────────────────────────────────────────┐
│ 工具类型       默认超时      最大超时      重试策略    │
│ Bash          120s         600s         不重试       │
│ Read          30s          60s          重试 1 次    │
│ Write         30s          60s          不重试       │
│ WebFetch      30s          60s          重试 2 次    │
│ Agent         无限制       无限制        取决于子代理   │
│ Grep          60s          120s         不重试       │
└──────────────────────────────────────────────────────┘

超时返回格式:
{
  "content": [{"type": "text", "text": "<timeout> Command timed out after 120000ms"}],
  "is_error": true
}
→ 模型看到 is_error: true 后通常会重试或采取替代方案
```

## 8. 自定义工具的最佳实践

```typescript
// 如果要在 Harness 中注册自定义工具（通过 MCP Server 或插件）：

// ① Schema 要足够描述性
const myCustomTool = {
  name: "database_query",
  description: "对 PostgreSQL 数据库执行只读 SQL 查询。" +
               "支持 SELECT 语句。不支持 INSERT/UPDATE/DELETE。" +
               "结果限制 1000 行。需要预先配置的连接字符串。",
  inputSchema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "要执行的 SQL SELECT 语句。仅允许 SELECT。"
      },
      params: {
        type: "array",
        items: { type: "string" },
        description: "SQL 参数绑定值（按顺序）"
      },
      maxRows: {
        type: "number",
        default: 100,
        description: "最大返回行数"
      }
    },
    required: ["sql"]
  }
};

// ② 错误处理要完善
async function executeQuery(args) {
  try {
    // 安全检查：只允许 SELECT
    if (!args.sql.trim().toUpperCase().startsWith('SELECT')) {
      return { content: [{ type: "text", text: "Error: Only SELECT allowed" }], is_error: true };
    }
    const result = await db.query(args.sql, args.params);
    return { content: [{ type: "text", text: JSON.stringify(result.rows) }], is_error: false };
  } catch (err) {
    // 返回结构化错误——模型可以据此调整并重试
    return { content: [{ type: "text", text: `DB Error: ${err.message}` }], is_error: true };
  }
}

// ③ 工具应该是"幂等"的（对只读操作）
//    Read 同一个文件两次 → 结果一致
//    这样模型可以在不确定时安全地重试

// ④ 工具应该有"可预测的副作用"
//    Write → 文件被修改（明确的副作用）
//    Bash(npm install) → node_modules 被填充（明确的副作用）
//    不应有"隐式的、不可预测的"副作用
```

## 下一步

下一篇将深入 **Harness Agent 子代理系统与并行调度**：Agent 类型注册（general-purpose / explore / plan / code-review）、Sub-agent 创建与生命周期、并行调度（parallel / pipeline 的区别与使用场景）、Agent-to-Agent 通信（SendMessage），以及 Agent Pool 的并发控制。
