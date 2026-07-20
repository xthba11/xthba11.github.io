---
title: Harness Agent 子代理系统与并行调度
date: 2026-04-05
categories:
  - Agent开发
  - Harness
tags:
  - Harness
  - Agent
  - Sub-agent
  - 并行调度
  - pipeline
  - 工作流
  - Claude Code
description: Harness Agent 子代理系统深度解析：Agent 类型注册与定义（general-purpose/explore/plan/code-review）、主代理与子代理的通信机制、parallel 与 pipeline 的并行调度模型、并发池管理、StructuredOutput 结构化输出约束
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# Harness Agent 子代理系统与并行调度

## 1. 为什么需要子代理

单个 Agent 有一个致命限制：**上下文窗口有限**。当任务涉及多文件分析、多维度审查、大规模重构时，单 Agent 无法同时处理所有信息。

子代理解决了这个问题：

```
单 Agent 模式：
  用户 → [Agent] → 逐个处理子任务 → 结果
  问题：串行、上下文膨胀

多 Agent 模式：
                        ┌→ [Agent A] 审查安全性 ─┐
  用户 → [Main Agent] ──┼→ [Agent B] 审查性能   ─┼→ Main Agent 汇总 → 用户
                        └→ [Agent C] 审查正确性 ─┘
  优势：并行、隔离上下文、专业分工
```

## 2. Agent 类型系统

### 2.1 内置 Agent 类型

| Agent 类型 | 工具集 | 典型用途 |
|-----------|--------|---------|
| **general-purpose** | 全部工具 | 通用任务：代码搜索、多步操作 |
| **Explore** | 只读工具（Read/Grep/Glob/WebFetch/WebSearch）| 大规模代码库探索 |
| **Plan** | 全部工具（不含 Agent/Write/Edit）| 架构设计、方案规划 |
| **claude** | 全部工具 | 通用后备（与 general-purpose 相同） |
| **claude-code-guide** | 只读 + WebFetch/WebSearch | Claude Code 使用指南问答 |
| **statusline-setup** | Read + Edit | 配置状态栏设置 |

### 2.2 自定义 Agent 类型

```markdown
<!-- .claude/agents/code-reviewer.md -->

---
name: code-reviewer
description: 代码审查专家，专注于发现 bug、安全漏洞和性能问题
model: opus
tools:
  - Read
  - Grep
  - Glob
  - Bash
reasoningEffort: high
---

你是一个代码审查专家。审查代码时请关注：

1. **正确性**：逻辑错误、边界条件、空指针、竞态条件
2. **安全性**：注入漏洞、权限问题、敏感数据泄露
3. **性能**：不必要的分配、N+1 查询、阻塞调用
4. **可维护性**：命名、注释、模块耦合度

审查流程：
1. 先用 Grep 找到所有相关文件
2. 逐个 Read 关键文件
3. 给出结构化的审查报告（严重性排序）

输出格式：
- [严重] 问题描述 → 建议修复
- [中等] 问题描述 → 建议修复
- [建议] 问题描述 → 优化方向
```

### 2.3 Agent 定义规范

```yaml
# Agent 定义的 Frontmatter 字段

name: string           # Agent 类型名（kebab-case）
description: string    # 一行描述，用于模型选择 Agent 类型
model: string          # 可选，覆盖模型（sonnet/opus/haiku/fable）
tools:                 # 可选，限制可用工具
  - Read
  - Grep
  - Glob
reasoningEffort: string # 可选，推理强度（low/medium/high/xhigh/max）
isolation: string      # 可选，"worktree" 启用 Git 隔离
```

## 3. Sub-agent 生命周期

### 3.1 创建与执行

```
Main Agent 调用 Agent 工具:
    Agent({
      description: "查找所有异步回调中缺少 try-catch 的位置",
      prompt: "扫描整个项目...",
      subagent_type: "Explore",
      model: "haiku"
    })
        │
        ▼
┌──────────────────────────────────────────────┐
│ Harness 创建 Sub-agent                        │
│                                              │
│ ① 根据 subagent_type 加载 Agent 定义文件      │
│ ② 设置工具白名单（Explore = Read + Grep + …）│
│ ③ 分配推理强度（haiku 默认 low）              │
│ ④ 构造 System Prompt（含工具 Schema）         │
│ ⑤ 以 prompt 作为首条用户消息                  │
│ ⑥ 启动 Agent 对话循环（同主 Agent）           │
│                                              │
│ Sub-agent 独立运行，不与主 Agent 共享上下文     │
│ （除非通过 SendMessage 显式通信）              │
└──────────────────────────────────────────────┘
        │
        ▼
Sub-agent 输出最终文本（其 final_text 即为返回值）
        │
        ▼
Main Agent 收到 tool_result:
    { "content": [{"text": "发现 3 处缺少 try-catch:\\n1. src/api.ts:42\\n..."}] }
```

### 3.2 后台与前台执行

```javascript
// ① 后台执行（默认）—— 不阻塞主 Agent
const reviewerAgent = await Agent({
  description: "review login module",
  prompt: "审查 src/auth/login.ts 的安全性...",
  subagent_type: "code-reviewer",
  run_in_background: true  // ★ 默认 true
});
// 主 Agent 可以继续做其他事
// Sub-agent 完成后，Harness 发送 task-notification
// 主 Agent 通过 TaskOutput 获取结果

// ② 前台执行 —— 阻塞等待结果
const result = await Agent({
  description: "quick search",
  prompt: "找到所有 TODO 注释",
  run_in_background: false
});
// 阻塞直到 sub-agent 完成，result 就是其输出文本
```

### 3.3 Sub-agent 间的通信

```json
// SendMessage 工具：Agent-to-Agent 通信

// Agent A 发送消息给 Agent B：
{
  "to": "code-reviewer",          // 接收方 Agent 名称
  "summary": "review PR #42",     // 5-10 字摘要（UI 中显示）
  "message": "请审查 src/api.ts 中的改动..."  // 消息内容
}

// SendMessage 特性：
//   • 消息会自动注入接收方 Agent 的对话上下文
//   • 如果接收方已完成 → 恢复其对话继续处理
//   • 如果接收方不存在 → 创建新的
//   • 最新创建的同名 Agent 会覆盖旧的引用
```

## 4. 并行调度模型

### 4.1 parallel：全屏障并行

```javascript
// parallel 模式 —— 所有任务同时启动，全部完成后才继续

const results = await parallel([
  () => Agent({ prompt: "审查 security.js", subagent_type: "code-reviewer" }),
  () => Agent({ prompt: "审查 performance.js", subagent_type: "code-reviewer" }),
  () => Agent({ prompt: "审查 readability.js", subagent_type: "code-reviewer" })
]);

// ★ 屏障点：必须等 3 个 Agent 全部完成
// wall-clock = max(Agent1, Agent2, Agent3)
// 结果 = [result1, result2, result3]（顺序与输入一致）

// 适用场景：
//   ✓ 所有结果必须全部收集后才能做决策
//   ✓ 例如：从所有文件收集后去重
//   ✓ 例如：汇总所有审查结果后再输出报告
//
// 不适用场景：
//   ✗ 任务间完全独立、可以边完成边处理
//   ✗ 某个任务特别慢，拖累整体进度
```

### 4.2 pipeline：流式流水线

```javascript
// pipeline 模式 —— 每个 item 独立流过多阶段，无屏障

const results = await pipeline(
  files,           // 输入列表: [fileA, fileB, fileC, ...]
  // Stage 1: 分析文件
  (file) => Agent({ prompt: `分析 ${file} 的功能和依赖` }),
  // Stage 2: 审查分析结果
  (analysis) => Agent({ prompt: `审查这个分析结果: ${analysis}` })
);

// ★ 无屏障：fileA 的 Stage 2 可能和 fileC 的 Stage 1 同时进行
// wall-clock ≈ max(单个文件两阶段时间)
// 而非 sum(所有文件 Stage1) + sum(所有文件 Stage2)

// 适用场景：
//   ✓ 任务独立、结果互不依赖
//   ✓ 例如：批量审查多个文件的修改
//   ✓ 例如：对多个独立模块执行相同的流水线
```

### 4.3 何时用 parallel vs pipeline

```
决策流程图：

  任务间是否独立？
    ├── 否 → parallel（需要汇总所有结果）
    └── 是
        └── 有多阶段处理吗？
            ├── 否 → parallel(items.map(i => Agent(...)))
            └── 是 → pipeline(items, stage1, stage2, ...)

错误示例：
  // ✗ 不必要的 barrier -- 转化中间结果不需要 barrier
  const a = await parallel(files.map(f => Agent(...)))  // barrier
  const b = a.map(transform)                            // 纯计算，不需要 barrier
  const c = await parallel(b.map(x => Agent(...)))      // barrier
  // ✓ 改为 pipeline
  const c = await pipeline(files,
    f => Agent(...),
    r => transform([r]).flat(),  // transform 放在 pipeline stage 中
    x => Agent(...)
  )
```

## 5. 并发池管理

```javascript
// Harness 维护一个全局并发池，限制同时运行的 Agent 数量

// 默认并发上限 = min(16, CPU_CORES - 2)
//   → 4 核机器: 最多 2 个 Agent 同时运行
//   → 8 核机器: 最多 6 个 Agent 同时运行
//   → 16 核机器: 最多 14 个 Agent 同时运行
//   → 32 核机器: 最多 16 个 Agent 同时运行

// 超过并发上限的 Agent 调用排队等待
//   100 个 Agent → 约 10 个同时跑 → 其余在队列中逐个释放

// 硬限制：
//   • 单个 parallel/pipeline 最多 4096 个 item
//   • 整个 workflow 生命周期最多 1000 个 Agent 调用
//   • 超过限制 → 显式错误（非静默截断）
```

## 6. StructuredOutput：约束子代理输出格式

```javascript
// 使用 JSON Schema 约束子代理的输出格式
// → 子代理被迫调用 StructuredOutput 工具来返回结果
// → 返回的是已验证的 JSON 对象，不需要解析

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { enum: ["critical", "major", "minor"] },
          description: { type: "string" },
          suggestion: { type: "string" }
        },
        required: ["file", "severity", "description"]
      }
    }
  },
  required: ["findings"]
};

const result = await Agent({
  prompt: "审查 src/ 目录下的安全性问题",
  schema: FINDINGS_SCHEMA
});

// result 是已验证的 JS 对象（不需要 JSON.parse）
// result.findings[0].file  → "src/auth/login.ts"  (类型: string)
// result.findings[0].line  → 42                   (类型: number)

// 如果子代理返回的 JSON 不匹配 Schema → 自动重试
// （Harness 告诉子代理 Schema 校验失败，要求修正）
```

## 7. Agent 隔离模式

### 7.1 Worktree 隔离

```javascript
// 当多个 Agent 需要同时修改文件时 → 用 Worktree 隔离

const agent1 = await Agent({
  prompt: "重构 utils/format.ts",
  isolation: "worktree"  // ← 在独立 git worktree 中运行
});
const agent2 = await Agent({
  prompt: "重构 utils/parse.ts",
  isolation: "worktree"  // ← 另一个独立 worktree
});

// 每个 Agent 在自己的 worktree 中修改文件
// → 不会互相冲突
// → 如果 worktree 没有实际改动 → 自动清理
// → 隔离开销: ~200-500ms（创建临时 worktree）

// Worktree 隔离架构:
// ~/project/                              (主仓库)
// ~/project/.claude/worktrees/wt_abc/     (Agent1 的独立副本)
// ~/project/.claude/worktrees/wt_def/     (Agent2 的独立副本)
```

## 8. 最佳实践

```
┌─────────────────────────────────────────────────────────┐
│ ① Agent 粒度：不要过细                                    │
│   ✗ 一个 Agent 只读一个文件                               │
│   ✓ 一个 Agent 负责一个完整的子任务（如"审查认证模块"）      │
│                                                         │
│ ② 选择合适的 Agent 类型                                   │
│   搜索 → Explore（只读工具，低成本）                        │
│   审查 → code-reviewer（高推理强度）                       │
│   规划 → Plan（无写权限，安全）                            │
│                                                         │
│ ③ 用 Schema 约束输出                                      │
│   Agent + schema → 结构化数据 → 无需解析 → 类型安全        │
│                                                         │
│ ④ 默认 pipeline，只在必要时 parallel                      │
│   pipeline 无屏障等待 → 总时间更短                         │
│   只有"必须汇总所有结果"时才用 parallel                     │
│                                                         │
│ ⑤ 设置合理的并发上限                                       │
│   核数 - 2 是默认值，CPU 密集型可适当减少                   │
│                                                         │
│ ⑥ 后台 Agent 不要忘记取结果                                │
│   Agent 完成后发 notification → 用 TaskOutput 获取        │
│   不要"发射后不管"——结果可能被丢弃                          │
└─────────────────────────────────────────────────────────┘
```

## 下一步

下一篇将深入 **Harness Hook 机制与中间件设计**：PreToolUse / PostToolUse / Notification 三类 Hook、匹配器 matcher 语法、Hook 返回值对工具执行的影响、以及实际应用场景（自动格式化、日志审计、安全拦截）。
