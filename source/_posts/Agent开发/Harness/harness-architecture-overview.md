---
title: Harness 框架概述与架构设计 —— AI Agent 运行时引擎
date: 2026-07-20
categories:
  - Agent开发
  - Harness
tags:
  - Harness
  - AI Agent
  - 运行时
  - 架构设计
  - Claude Code
description: Harness 框架全景：AI Agent 运行时引擎的定位、核心架构（模型适配层/工具运行层/权限控制层/Agent管理层）、消息路由流程、上下文与记忆管理、settings.json 配置体系
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# Harness 框架概述与架构设计

## 1. Harness 是什么

Harness 是 Claude Code CLI 的 **AI Agent 运行时引擎**——它不是模型、不是工具、不是 UI，而是把这三者粘合到一起的"操作系统"。类比：

| 概念 | 传统 OS | Harness |
|------|---------|---------|
| 进程 | 应用程序 | Agent / Sub-agent |
| 系统调用 | syscall | Tool (Bash, Read, Write, ...) |
| 权限控制 | UID / GID / capabilities | Permission Mode / allowlist / hooks |
| 进程调度 | CPU scheduler | Agent pool / pipeline / parallel |
| 文件系统 | VFS | Memory system / project files |
| 配置 | /etc / registry | settings.json / CLAUDE.md |

> **一句话总结**：Harness 负责接收用户指令 → 管理模型调用 → 执行工具 → 控制权限 → 返回结果，Agent 开发者只需要关注"做什么"，不需要关注"怎么做"。

## 2. 核心架构分层

```
┌──────────────────────────────────────────────────────────┐
│                     用户界面层                             │
│  CLI Terminal  │  VS Code Extension  │  Web App  │  IDE  │
├──────────────────────────────────────────────────────────┤
│                    Harness 运行时                          │
│                                                          │
│  ┌─────────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ 模型适配层    │  │ 工具运行层 │  │ 权限控制层          │  │
│  │             │  │          │  │                    │  │
│  │ • 多模型切换 │  │ • 工具注册│  │ • Permission Mode  │  │
│  │ • 流式输出  │  │ • Schema校验│ • Hook 拦截         │  │
│  │ • Token 管理│  │ • 沙箱隔离│  │ • allowlist 过滤   │  │
│  │ • 缓存策略  │  │ • 超时重试│  │ • 用户确认流程      │  │
│  └──────┬──────┘  └────┬─────┘  └─────────┬──────────┘  │
│         │              │                  │              │
│  ┌──────┴──────────────┴──────────────────┴──────────┐  │
│  │              Agent 管理层                           │  │
│  │                                                    │  │
│  │  • Agent 类型注册 (general-purpose / explore / …)   │  │
│  │  • Sub-agent 创建/销毁/通信                         │  │
│  │  • 并行调度 (parallel / pipeline / agent pool)      │  │
│  │  • Workflow 编排引擎                                │  │
│  │  • Memory 系统 (持久化上下文)                        │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│                    系统接口层                              │
│  Filesystem  │  Shell  │  Git  │  MCP  │  Network  │ ... │
└──────────────────────────────────────────────────────────┘
```

## 3. 消息路由流程

每一次用户交互都经过一条清晰的流水线：

```
用户输入
    │
    ▼
┌──────────────┐
│ ① 上下文组装  │  ← CLAUDE.md + Memory + System Prompt + Git Status
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ ② Hook 预处理 │  ← PreToolUse / PostToolUse 钩子可以拦截或修改
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ ③ 模型调用    │  ← 发送到 Anthropic API (Claude) / deepseek / ...
└──────┬───────┘
       │ 模型返回文本 或 Tool Call
       ▼
┌──────────────┐
│ ④ 输出解析    │  ← 解析 Tool Call JSON → 校验 Schema → 匹配工具
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ ⑤ 权限检查    │  ← Permission Mode: default / acceptEdits / plan / bypass
└──────┬───────┘
       │ 用户确认 / Hook 放行 / allowlist 匹配
       ▼
┌──────────────┐
│ ⑥ 工具执行    │  ← 实际调用 Bash / Read / Write / Agent / ...
└──────┬───────┘
       │ Tool Result
       ▼
┌──────────────┐
│ ⑦ 结果注入    │  ← 工具结果追加到对话上下文
└──────┬───────┘
       │ 回到 ③ (模型继续推理)
       ▼
    ... 循环直到模型输出最终文本 ...
       │
       ▼
     用户可见的最终回复
```

### 关键设计点

```text
┌─────────────────────────────────────────────────────────┐
│  循环的终止条件：                                         │
│  1. 模型返回纯文本（不含 tool_use）→ 输出给用户            │
│  2. 模型调用次数达到上限（默认约 100 轮）→ 强制终止         │
│  3. 用户手动中断（Ctrl+C）                                │
│  4. 权限被用户拒绝 → 终止当前工具链                        │
└─────────────────────────────────────────────────────────┘
```

## 4. 上下文与记忆管理

### 4.1 上下文组装

```json
// 每次模型调用的上下文由以下部分组装（按注入顺序）：

// ① System Prompt（系统提示词）
//    - 定义 Agent 的角色、能力边界、行为规范
//    - 列出可用工具及其 Schema
//    - 注入环境信息（OS、Shell、工作目录、Git 状态）

// ② Session Context（会话上下文）
//    - Memory 系统加载的相关记忆（MEMORY.md + *.md 文件）
//    - 当前日期/时间
//    - Git 仓库状态快照

// ③ Conversation History（对话历史）
//    - 用户消息 + 模型回复 + 工具调用 + 工具结果
//    - 超出窗口的部分被截断/总结（由 Harness 自动管理）

// ④ Current Turn（当前轮次）
//    - 用户的即时输入
//    - IDE 选中内容（如果通过 VS Code 扩展触发）
```

### 4.2 Memory 系统

```
.claude/
└── projects/
    └── <project-hash>/
        └── memory/
            ├── MEMORY.md              ← 索引文件（每条记忆一行）
            ├── user-name.md           ← 用户信息
            ├── project-context.md     ← 项目背景
            ├── feedback-coding-style.md ← 用户反馈/偏好
            └── reference-api-docs.md  ← 外部参考链接

每条记忆都是一个 Markdown 文件，带 YAML Frontmatter：
---
name: coding-style
description: 用户的编码风格偏好
metadata:
  type: feedback
---

事实内容...

**Why:** 为什么需要记住这个
**How to apply:** 如何在未来应用

关联记忆：[[memory-name]]
```

### 4.3 Context Window 管理

```
┌─────────────────────────────────────────────────────────┐
│ Token 预算管理策略：                                      │
│                                                         │
│  总预算 = 模型上下文窗口（如 200K）                         │
│                                                         │
│  ┌──────────┐ ┌──────────────┐ ┌─────────────────────┐  │
│  │ System   │ │ Memory +     │ │ Conversation History│  │
│  │ Prompt   │ │ Session Ctx  │ │ (动态, 可能被截断)     │  │
│  │ ~5K      │ │ ~2-10K       │ │ 剩余空间             │  │
│  └──────────┘ └──────────────┘ └─────────────────────┘  │
│                                                         │
│  历史超出窗口时：                                         │
│    → Harness 自动执行"上下文总结"                         │
│    → 保留最近 N 轮完整对话                                │
│    → 旧内容压缩为摘要注入 System Prompt                    │
│    → 保证 Agent 不会丢失关键信息                           │
└─────────────────────────────────────────────────────────┘
```

## 5. 配置体系：settings.json

Harness 的所有行为通过三个 JSON 文件配置：

```jsonc
// ====== settings.json（用户级，~/.claude/settings.json） ======
{
  // 权限配置（全局生效）
  "permissions": {
    "allow": [
      "Bash(npm test)",           // 精确匹配
      "Bash(git diff *)",          // 通配符匹配
      "WebSearch(*)",
      "WebFetch(*)"
    ],
    "deny": [
      "Bash(rm -rf *)",           // 永远禁止
      "Bash(sudo *)"
    ],
    "defaultMode": "default"       // default | acceptEdits | bypass
  },

  // 模型配置
  "model": "claude-sonnet-5",     // 默认模型
  "enableFastMode": false,        // 快速模式开关

  // 环境变量
  "env": {
    "DEBUG": "harness:*",
    "NODE_ENV": "development"
  },

  // Hook 配置
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(*)",
        "command": "echo 'About to run: $TOOL_NAME'",
        "allowDeny": false         // true = 可以阻止执行
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write(*)",
        "command": "prettier --write $FILE_PATH"
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "command": "notify-send 'Claude: $TITLE' '$MESSAGE'"
      }
    ]
  }
}

// ====== settings.local.json（项目级，覆盖全局） ======
// 放在项目根目录 .claude/settings.local.json
{
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(node *)"
    ]
  }
}

// ====== 优先级：local > user > default ======
```

## 6. CLAUDE.md：项目的"手册"

CLAUDE.md 是每个项目的 Agent 操作手册，Harness 在每次会话开始时将其注入 System Prompt：

```markdown
<!-- CLAUDE.md 示例 -->
# Project: Bicycle_Watch

## Build Commands
- Build: `make -j4`
- Flash: `make flash`
- Clean: `make clean`

## Code Style
- Tab = 4 spaces
- Function naming: `module_action_description()`
- Comments in Chinese

## Architecture
- 01_APP/ → Application layer
- 02_BSP_Platform/ → Hardware abstraction
- 05_Service/ → Service modules
```

## 7. 隔离模式：Worktree 与 Sandbox

### 7.1 Git Worktree 隔离

```
正常工作目录:                   Worktree 隔离:
~/project/                      ~/project/.claude/worktrees/wt_abc123/
    │                               │
    ├── source/                     ├── source/  (独立副本)
    ├── node_modules/               ├── node_modules/ (共享/独立)
    └── .git/                       └── .git → 指向主仓库的引用
        │                               │
    主分支 master                   临时分支 wt_abc123
                                   （Agent 完成后可自动删除）
```

### 7.2 沙箱执行

```bash
# Harness 的 Bash 调用可以运行在沙箱中：
# 1. 网络隔离（可选）
# 2. 文件系统限制（读写范围限定在工作目录内）
# 3. 命令白名单（dangerouslyDisableSandbox 默认 false）
# 4. 超时控制（默认 120s，最长 600s）
```

## 8. Harness 的扩展点

| 扩展点 | 方式 | 作用 |
|--------|------|------|
| Tool | MCP Server / 内置工具 | 增加 Agent 可调用的能力 |
| Agent Type | .claude/agents/*.md | 定义专用子代理类型 |
| Hook | settings.json hooks | 拦截/修改/记录工具调用 |
| Skill | .claude/skills/*.md | 封装可复用的工作流 |
| Workflow | .claude/workflows/*.js | 定义多代理编排脚本 |
| Memory | .claude/projects/*/memory/ | 持久化上下文 |
| Permission | settings.json allow/deny | 控制工具访问权限 |

## 下一步

下一篇将深入 **Harness 工具系统与 Tool 定义**：内置工具（Bash/Read/Write/Edit/Glob/Grep）的 Schema 设计、工具调用的完整生命周期、MCP 工具的注册与发现、以及如何通过 Schema 约束模型的工具使用。
