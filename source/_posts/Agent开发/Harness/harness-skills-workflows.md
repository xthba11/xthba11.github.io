---
title: Harness Skills 系统与 Workflow 编排 —— 可复用的自动化流水线
date: 2026-07-20
categories:
  - Agent开发
  - Harness
tags:
  - Harness
  - Skill
  - Workflow
  - 编排
  - Slash Command
  - 自动化
  - Claude Code
description: Harness Skills 与 Workflow 系统详解：Skill 文件的定义规范与触发机制、Slash Command 的完整流程、Workflow JS 脚本编写（agent/parallel/pipeline/phase/budget）、实际编排案例（代码审查流水线、多维度并行审计、循环发现模式）
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# Harness Skills 系统与 Workflow 编排

## 1. Skill 与 Workflow 的区别

在 Harness 中，Skill 和 Workflow 是两种不同层次的复用机制：

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Skill ≈ 函数                                           │
│    • 一个 Markdown 文档                                  │
│    • 定义 Agent 在某场景下的行为规范                      │
│    • 通过 /slash-command 触发                            │
│    • 例: /code-review, /security-review, /init          │
│                                                         │
│  Workflow ≈ 编排脚本                                    │
│    • 一个 JavaScript 文件                                │
│    • 定义多个 Agent 的编排逻辑（并行、流水线、条件分支）    │
│    • 通过 Workflow 工具调用                              │
│    • 例: 代码审查 → 并行审查多维度 → 验证 → 汇总          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 2. Skill 系统

### 2.1 Skill 文件结构

```markdown
<!-- .claude/skills/code-review.md -->

---
name: code-review
description: 审查当前改动中的正确性 bug 和可改进的简化/复用/效率问题。
             使用 --comment 将结果发布为 PR 评论，使用 --fix 将修复应用到工作树。
---

# Code Review Skill

你是代码审查专家。审查当前 git diff 的改动。

## 审查维度

1. **正确性** (severity: critical/major)
   - 逻辑错误：条件判断、循环边界、空指针
   - 并发问题：竞态条件、死锁、非线程安全操作
   - 资源泄漏：未关闭的文件句柄、数据库连接、内存泄漏

2. **安全性** (severity: critical)
   - 注入漏洞：SQL/命令/路径注入
   - 敏感数据暴露：密钥、Token、PII
   - 权限缺陷：缺少访问控制、越权操作

3. **简化与复用** (severity: minor/suggestion)
   - 重复代码是否可以抽取为公共函数
   - 复杂逻辑是否可以简化
   - 是否有现成的库函数可以替代手动实现

4. **效率** (severity: minor)
   - 不必要的 O(n²) 操作
   - 重复计算可以缓存
   - 可以批量而非逐条查询

## 审查流程

1. 运行 `git diff` 获取改动列表
2. 逐个文件 Read 并对比改动前后的差异
3. 对每个发现的问题：定位文件、行号、严重程度、问题描述、修复建议
4. 按严重程度排序输出结构化报告

## 输出格式

| 严重度 | 文件:行号 | 问题 | 建议 |
|--------|----------|------|------|
| critical | src/auth.ts:42 | 未验证token过期时间 | 添加 `if (Date.now() > exp)` 检查 |
```

### 2.2 Skill 触发流程

```
用户输入 /code-review
    │
    ▼
┌──────────────────────────────────────┐
│ Harness 解析 Slash Command            │
│  → 匹配到 skill: "code-review"       │
│  → 加载 .claude/skills/code-review.md│
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ 将 Skill 内容注入 System Prompt       │
│  → 作为当前 Agent 的行为指令          │
│  → Agent 按照 Skill 定义的流程执行    │
└──────────────────┬───────────────────┘
                   │
                   ▼
        Agent 执行审查 → 输出报告
```

### 2.3 内置 Skill 集合

| Skill | 触发命令 | 功能 |
|-------|---------|------|
| code-review | /code-review | 审查 diff 的正确性和简化空间 |
| security-review | /security-review | 专项安全审查 |
| simplify | /simplify | 仅审查简化/复用/效率改进 |
| review | /review | 审查 GitHub PR |
| init | /init | 初始化项目的 CLAUDE.md |
| verify | /verify | 端到端验证代码改动 |
| loop | /loop | 设置周期性重复任务 |
| deep-research | /deep-research | 多源网络调研 + 验证 + 综述报告 |
| run | /run | 启动并验证项目 App |
| update-config | /update-config | 管理 settings.json 配置 |

### 2.4 Skill 参数传递

```text
Skill 支持两种参数方式：

① 位置参数（/skill arg1 arg2）
   /code-review --comment --fix

② 命名参数（通过 Skill(args, ...) 工具调用）
   Skill({
     skill: "code-review",
     args: "--comment --effort high"
   })

参数在 Skill 文档中通过 {{args}} 引用
```

## 3. Workflow 编排引擎

### 3.1 Workflow 脚本基本结构

```javascript
// .claude/workflows/review-changes.js

// ★ 必须第一行：导出元信息（纯字面量）
export const meta = {
  name: 'review-changes',
  description: '审查代码改动：多维度并行审查 → 验证 → 汇总',
  phases: [
    { title: 'Review', detail: '并行审查 bugs/perf/security' },
    { title: 'Verify', detail: '对抗验证每个发现' },
    { title: 'Report', detail: '汇总通过验证的发现' }
  ]
};

// ====== Phase 1: 多维并行审查 ======
phase('Review');

const DIMENSIONS = [
  {
    key: 'bugs',
    prompt: `审查代码改动中的正确性bug。关注：
             1. 逻辑错误、边界条件、空指针
             2. 并发问题、竞态条件
             3. 资源泄漏
             输出格式：{ "findings": [{ "file": "...", "line": 42, ... }] }`
  },
  {
    key: 'perf',
    prompt: `审查代码改动中的性能问题。关注：
             1. 不必要的O(n²)操作
             2. 可以缓存的计算
             3. 批量vs逐条查询的效率差异
             输出格式：同上`
  },
  {
    key: 'security',
    prompt: `审查代码改动中的安全问题。关注：
             1. 注入漏洞
             2. 敏感数据泄漏
             3. 权限缺陷
             输出格式：同上`
  }
];

// pipeline: 每个维度独立进行"审查 → 验证"
// 无屏障——bug审查完成就立即开始bug验证，不等perf审查
const results = await pipeline(
  DIMENSIONS,
  // Stage 1: 审查
  d => agent(d.prompt, {
    label: `review:${d.key}`,
    phase: 'Review',
    schema: FINDINGS_SCHEMA,
    subagent_type: 'code-reviewer'
  }),
  // Stage 2: 验证（每个发现独立验证）
  review => {
    if (!review || !review.findings?.length) return [];
    return parallel(
      review.findings.map(f => () =>
        agent(
          `对抗验证: 尝试反驳以下发现。如果发现不成立，说明为什么。
           文件: ${f.file}:${f.line}
           声称: ${f.description}`,
          {
            label: `verify:${f.file}:${f.line}`,
            phase: 'Verify',
            schema: VERDICT_SCHEMA
          }
        ).then(v => ({ ...f, verdict: v }))
      )
    );
  }
);

// ====== Phase 3: 汇总 ======
phase('Report');

// 扁平化 + 过滤 + 排序
const confirmed = results
  .flat()
  .filter(Boolean)
  .filter(f => f.verdict?.isConfirmed)
  .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

log(`审查完成: ${confirmed.length} 个问题确认 (${DIMENSIONS.length} 个维度)`);

return { confirmed, total: results.flat().filter(Boolean).length };
```

### 3.2 编排原语参考

```javascript
// ====== agent() ======
// 创建单个子代理
const result = await agent("提示词", {
  label: "任务标签",           // UI 显示名
  phase: "PhaseName",          // 进度分组
  schema: OUTPUT_SCHEMA,       // 结构化输出约束
  model: "sonnet",             // 可选模型覆盖
  effort: "high",              // 推理强度
  isolation: "worktree",       // Git 隔离
  subagent_type: "custom-type" // 使用自定义 Agent 类型
});
// 无 schema → 返回 string
// 有 schema → 返回已验证的 JSON 对象


// ====== parallel() ======
// 屏障式并行：全部完成后才返回
const results = await parallel([
  () => agent("任务A"),
  () => agent("任务B"),
  () => agent("任务C")
]);
// results = [resultA, resultB, resultC]
// wall-clock = max(A, B, C)


// ====== pipeline() ======
// 流水线：每个 item 依次流过多个 stage，无屏障
const results = await pipeline(
  items,           // 输入列表
  stage1,          // (prevResult, originalItem, index) => Promise
  stage2,          // 每个 item 的 stage2 可以和另一个 item 的 stage1 并行
  // ...更多 stage
);
// wall-clock ≈ max(single-item-all-stages)


// ====== phase() ======
// 在进度 UI 中创建分组
phase('Code Review');
phase('Security Audit');
// 之后创建的 agent() 自动归入当前 phase


// ====== log() ======
// 向用户输出进度消息
log('已完成 3/10 个文件的审查');
log('发现 5 个严重问题');


// ====== budget ======
// Token 预算管理（用户使用 +500k 指令时可用）
if (budget.total) {
  log(`剩余 budget: ${Math.round(budget.remaining() / 1000)}k tokens`);
  // 根据剩余 budget 动态调整策略
  const AGENT_COUNT = budget.remaining() > 100000 ? 10 : 3;
}
```

### 3.3 常用编排模式

```javascript
// ====== 模式 1：多维度审查 + 对抗验证 ======
export const meta = {
  name: 'adversarial-review',
  description: '多维度审查 → 每发现独立对抗验证 → 通过者汇总'
};

const DIMENSIONS = [
  { key: 'correctness', prompt: '审查正确性...' },
  { key: 'security', prompt: '审查安全性...' },
  { key: 'perf', prompt: '审查性能...' }
];

const results = await pipeline(
  DIMENSIONS,
  // Stage 1: 审查（并行）
  d => agent(d.prompt, { schema: FINDINGS_SCHEMA }),
  // Stage 2: 验证（每个发现 3 票决）
  review => parallel(
    (review?.findings || []).map(f => () =>
      parallel([
        () => agent(`Refute ${f.title} (lens: correctness)`, { schema: VERDICT }),
        () => agent(`Refute ${f.title} (lens: security)`, { schema: VERDICT }),
        () => agent(`Refute ${f.title} (lens: repro)`, { schema: VERDICT })
      ]).then(vs => ({ ...f, real: vs.filter(v => v?.real).length >= 2 }))
    )
  )
);


// ====== 模式 2：Loop Until Dry ======
// 持续发现直到连续 N 轮无新结果
const seen = new Set();
const findings = [];
let dry = 0;

while (dry < 2) {
  const batch = await parallel(
    FINDERS.map(f => () => agent(f.prompt, { schema: BUGS_SCHEMA }))
  );
  const batchFindings = batch.filter(Boolean).flatMap(r => r.bugs);

  const fresh = batchFindings.filter(b => !seen.has(key(b)));
  if (fresh.length === 0) {
    dry++;
    continue;
  }
  dry = 0;
  fresh.forEach(b => seen.add(key(b)));
  findings.push(...fresh);
  log(`累计发现: ${findings.length}`);
}


// ====== 模式 3：Multi-Modal Sweep ======
// 用不同搜索策略从不同角度定位问题
const sweep = await parallel([
  () => agent('Search by file type: find all handlers', { schema: FILES }),
  () => agent('Search by content: find all error patterns', { schema: ERRORS }),
  () => agent('Search by imports: find all cross-module references', { schema: REFS })
]);
// 去重合并 → 获得完整问题视图


// ====== 模式 4：Judge Panel ======
// 多个 Agent 独立给出方案 → 打分 → 选最优
const solutions = await parallel([
  () => agent('Design approach A: MVP-first', { schema: DESIGN }),
  () => agent('Design approach B: Risk-first', { schema: DESIGN }),
  () => agent('Design approach C: User-first', { schema: DESIGN })
]);
const scores = await parallel(
  solutions.map((s, i) => () =>
    agent(`Score solution ${i}: ${s.summary} (criteria: speed, quality, risk)`,
      { schema: SCORE })
  )
);
const best = solutions[scores.indexOf(scores.sort((a, b) => b.total - a.total)[0])];
```

## 4. Workflow 脚本约束

```javascript
// ====== 禁止的操作 ======
// ✗ Date.now()、Math.random()、无参数 new Date()
//    → 会破坏 Workflow resume 的可重现性
// ✓ 通过 args 传入时间戳/随机种子

// ✗ 文件系统/Node.js API
// ✓ 仅能使用 agent()/parallel()/pipeline()/phase()/log()/budget/args

// ✗ TypeScript 语法 (interface, generics, type annotations)
// ✓ 纯 JavaScript (const, let, async/await, arrow functions)


// ====== 限制 ======
// • 单个 parallel/pipeline 最多 4096 items
// • 整个 Workflow 生命周期最多 1000 agent() 调用
// • 并发上限 min(16, cpuCores - 2)
// • budget.total 为 null 时 budget.remaining() = Infinity


// ====== Resume 机制 ======
// Workflow 支持断点续传：
//   第一次运行: Workflow({ script: "..." })
//   中断后继续: Workflow({ scriptPath: "...", resumeFromRunId: "wf_xxx" })
//
//   相同的 (prompt, opts) 组合 → 从缓存直接返回 → 秒级恢复
//   新增/修改的 agent() 调用 → 重新执行
```

## 5. 从 Skill 到 Workflow 的组合

```
用户需求: 全面审查一次大型代码改动

┌─────────────────────────────────────────────────────────┐
│                                                         │
│ 用户输入: /code-review --effort max                      │
│                                                         │
│ Skill 层:                                                │
│   加载 code-review.md → Agent 获取审查流程指引           │
│        │                                                │
│        ▼                                                │
│   Agent 决定调用 Workflow:                               │
│   Workflow({ name: "review-changes" })                  │
│        │                                                │
│        ▼                                                │
│   Workflow 层:                                           │
│   phase("Find")                                         │
│     parallel(3 个维度的审查 Agent)                        │
│        │                                                │
│   phase("Verify")                                       │
│     pipeline(每发现 → 3 票对抗验证)                       │
│        │                                                │
│   phase("Report")                                       │
│     汇总 → 排序 → 输出报告                               │
│        │                                                │
│        ▼                                                │
│   Harness 将报告返回给用户                                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 6. 编写高质量的 Skill 和 Workflow

```
Skill 编写 Checklist:
  □ 有清晰的 name 和 description
  □ 定义了 Agent 的角色和职责
  □ 提供了具体的流程步骤（不是泛泛的要求）
  □ 给出了输出格式要求
  □ 说明了常见陷阱和注意事项

Workflow 编写 Checklist:
  □ meta 块是纯字面量（无变量、无函数调用）
  □ meta.phases 与 phase() 调用一一对应
  □ 用 pipeline 而非 parallel 作为默认编排方式
  □ 只在需要汇总全部结果时才用 parallel 做 barrier
  □ 用 schema 约束子代理输出（避免 JSON 解析）
  □ 用 log() 向用户报告进度
  □ 错误处理：filter(Boolean) 过滤失败的 agent 结果
  □ 设置了合理的 phase 显示标签

性能优化:
  □ 搜索类 Agent 用 haiku + low effort（快且便宜）
  □ 验证类 Agent 用 opus + high/max effort（准确）
  □ 用 agent_type 指定专用 Agent 类型
  □ 用 isolation: "worktree" 只在 Agent 需要修改文件时
```

## 系列总结

本系列五篇文章覆盖了 Harness AI Agent 运行时框架的核心体系：

| 文章 | 核心知识点 |
|------|-----------|
| 第一篇：架构概述 | 分层架构、消息路由、上下文管理、Memory 系统、settings.json 配置 |
| 第二篇：工具系统 | JSON Schema 定义、工具生命周期、Bash/Read/Write 内置工具、MCP 集成、沙箱隔离 |
| 第三篇：Agent 系统 | Agent 类型注册、Sub-agent 生命周期、parallel/pipeline 调度、StructuredOutput |
| 第四篇：Hook 机制 | PreToolUse/PostToolUse/Notification、matcher 语法、allowDeny 拦截、审计日志 |
| 第五篇：Skills & Workflows | Skill 文件定义、Slash Command、Workflow 脚本编写、编排模式（审查/验证/循环发现） |

---

> 掌握 Harness 意味着你不再是一个"AI 用户"，而是一个 **AI 系统工程师**——你能定制的不是模型的能力，而是 Agent 的行为边界、安全策略、协作模式和自动化流水线。
