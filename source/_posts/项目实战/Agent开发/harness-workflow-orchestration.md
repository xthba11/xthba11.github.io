---
title: Workflow 多代理编排实战 —— 构建自动化代码审查流水线
date: 2026-05-25
categories:
  - 项目实战
  - Agent开发
tags:
  - Harness
  - Workflow
  - 编排
  - pipeline
  - parallel
  - 代码审查
  - 自动化
description: Harness 实战第三篇：从零编写 Workflow JS 编排脚本，构建一个完整的代码审查流水线。实现并行四维度审查、对抗验证过滤假阳性、结构化报告生成，以及 token 预算自适应调度的实用模式
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# Workflow 多代理编排实战

## 1. 实战目标

构建一个完整的代码审查 Workflow，输入一次 `git diff`，输出经过对抗验证的可信审查报告：

```
git diff
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Phase 1: FIND — 四维度并行审查                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐│
│  │正确性审查 │ │安全审查   │ │性能审查   │ │规范审查││
│  │opus+high │ │opus+high │ │sonnet+med│ │haiku  ││
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──┬───┘│
│       └─────────────┴────────────┴──────────┘    │
│                        │                         │
│                        ▼                         │
│ Phase 2: VERIFY — 每个发现独立对抗验证             │
│  发现A → [验证者1, 验证者2, 验证者3] → 投票        │
│  发现B → [验证者1, 验证者2, 验证者3] → 投票        │
│  ...（pipeline 无屏障，发现A验证完就继续）           │
│                        │                         │
│                        ▼                         │
│ Phase 3: REPORT — 汇总 + 排序 + 输出报告           │
└─────────────────────────────────────────────────┘
    │
    ▼
结构化审查报告 (JSON)
```

## 2. Workflow 前置准备

### 2.1 Agent 类型定义

```bash
# 确保以下 Agent 类型已创建（见第一篇实战）：
.claude/agents/
├── code-reviewer.md      # 审查通用逻辑
├── security-reviewer.md  # 安全专项审查
├── perf-reviewer.md      # 性能专项审查
└── style-reviewer.md     # 代码规范审查
```

### 2.2 JSON Schema 定义

```javascript
// .claude/workflows/schemas.js（被 workflow 脚本引用）
// 注：Schema 直接内联在 workflow 脚本中即可，不需要单独文件

const FINDING_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string", description: "文件路径" },
    line: { type: "number", description: "行号" },
    severity: {
      type: "string",
      enum: ["critical", "major", "minor", "suggestion"]
    },
    category: {
      type: "string",
      enum: ["correctness", "security", "performance", "style"]
    },
    title: { type: "string", description: "问题简述（≤10字）" },
    description: { type: "string" },
    suggestion: { type: "string" }
  },
  required: ["file", "line", "severity", "title", "description"]
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    isConfirmed: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" }
  },
  required: ["isConfirmed", "reason"]
};
```

## 3. 完整 Workflow 脚本

```javascript
// .claude/workflows/comprehensive-review.js

export const meta = {
  name: 'comprehensive-review',
  description: '四维度代码审查 → 对抗验证 → 结构化报告',
  phases: [
    { title: 'Find', detail: '并行审查 correctness/security/perf/style' },
    { title: 'Verify', detail: '对抗验证每个发现 (3票决)' },
    { title: 'Report', detail: '汇总生成审查报告' }
  ],
  whenToUse: '当需要全面审查代码改动时（/review 或手动调用）'
};

// ====== Phase 1: 四维度并行审查 ======
phase('Find');

const DIMENSIONS = [
  {
    key: 'correctness',
    prompt: `审查代码改动中的正确性问题：
      1. 逻辑错误：条件判断、循环边界、空指针解引用
      2. 并发问题：中断安全、竞态条件、volatile 缺失
      3. 资源管理：未关闭的句柄、未释放的内存、DMA 缓冲区管理
      4. 错误处理：HAL 返回值未检查、错误路径资源泄漏
      输出所有可信问题，不要遗漏。`,
    model: 'opus',
    effort: 'high'
  },
  {
    key: 'security',
    prompt: `审查代码改动中的安全问题：
      1. 缓冲区溢出：数组越界、sprintf/strcpy 未限长
      2. 注入风险：用户输入未校验、命令拼接
      3. 信息泄露：调试日志输出敏感数据、固件中硬编码密钥
      4. 权限与完整性：Flash 写保护缺失、固件签名缺失`,
    model: 'opus',
    effort: 'high'
  },
  {
    key: 'performance',
    prompt: `审查代码改动中的性能问题：
      1. 不必要的重复计算（可以缓存）
      2. I2C/SPI 事务可以合并（减少总线占用）
      3. 中断处理时间过长（应尽快退出 ISR）
      4. 栈上分配大数组（应改为静态或堆分配）
      5. FreeRTOS 任务优先级/栈大小配置不当`,
    model: 'sonnet',
    effort: 'medium'
  },
  {
    key: 'style',
    prompt: `审查代码改动中的代码规范问题：
      1. 命名不符合项目规范（bsp_xxx_, HAL_xxx_）
      2. 注释缺失或与代码不一致
      3. 魔法数字未定义为宏
      4. 函数过长（>80行）或嵌套过深（>4层）`,
    model: 'haiku',
    effort: 'low'
  }
];

// ★ pipeline: 每个维度的审查完成后立即开始验证，不等其他维度
const results = await pipeline(
  DIMENSIONS,

  // ====== Stage 1: 审查 ======
  (dim) => {
    log(`开始 ${dim.key} 审查...`);
    return agent(dim.prompt, {
      label: `review:${dim.key}`,
      phase: 'Find',
      schema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                severity: { enum: ["critical","major","minor","suggestion"] },
                category: { enum: ["correctness","security","performance","style"] },
                title: { type: "string" },
                description: { type: "string" },
                suggestion: { type: "string" }
              },
              required: ["file","line","severity","title","description"]
            }
          }
        },
        required: ["findings"]
      },
      model: dim.model,
      effort: dim.effort,
      subagent_type: `${dim.key}-reviewer`
    });
  },

  // ====== Stage 2: 对抗验证 ======
  (review, originalDim) => {
    if (!review?.findings?.length) {
      log(`${originalDim.key}: 0 个发现，跳过验证`);
      return [];
    }

    log(`${originalDim.key}: ${review.findings.length} 个发现 → 对抗验证`);

    // 每个发现用 3 个不同角度的验证者
    const LENSES = ['correctness', 'security', 'reproducibility'];

    return parallel(
      review.findings.map((finding, idx) => () => {
        log(`验证 [${originalDim.key} #${idx+1}]: ${finding.title}`);

        return parallel(
          LENSES.map(lens => () =>
            agent(
              `你是审查验证专家，从「${lens}」角度验证以下问题声明。

              ## 声明
              文件: ${finding.file}:${finding.line}
              严重度: ${finding.severity}
              问题: ${finding.title}
              描述: ${finding.description}
              建议修复: ${finding.suggestion || '未提供'}

              ## 你的任务
              尝试从「${lens}」角度**反驳**这个声明：
              - 如果声明不成立（如代码实际上已处理此问题），说明为什么
              - 如果声明成立但严重度被高估，调低它
              - 如果声明完全正确，确认它

              默认为 isConfirmed=false（严格模式——只有确信无疑才确认）`,
              {
                label: `verify:${finding.title} (${lens})`,
                phase: 'Verify',
                schema: VERDICT_SCHEMA,
                model: 'opus',
                effort: 'high'
              }
            )
          )
        ).then(verdicts => {
          // 3 票中至少 2 票确认 → 保留此发现
          const confirmed = verdicts.filter(Boolean).filter(v => v.isConfirmed);
          return {
            ...finding,
            verified: confirmed.length >= 2,
            confidence: confirmed.length / verdicts.filter(Boolean).length,
            verifyNotes: verdicts.filter(Boolean).map(v => v.reason)
          };
        });
      })
    );
  }
);

// ====== Phase 3: 生成报告 ======
phase('Report');

// 扁平化所有维度的结果
const allFindings = results
  .flat()
  .filter(Boolean)
  .filter(f => f.verified);

// 按严重度排序
const severityRank = { critical: 0, major: 1, minor: 2, suggestion: 3 };
allFindings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

// 统计
const stats = { critical: 0, major: 0, minor: 0, suggestion: 0 };
allFindings.forEach(f => stats[f.severity]++);

log(`审查完成: ${allFindings.length} 个确认问题 `
  + `(${stats.critical}C/${stats.major}M/${stats.minor}m/${stats.suggestion}S)`);

// 生成结构化报告
const report = {
  generatedAt: new Date().toISOString(),
  summary: stats,
  totalConfirmed: allFindings.length,
  totalReviewed: results.flat().filter(Boolean).length,
  falsePositiveRate: results.flat().filter(Boolean).filter(f => !f.verified).length,
  findings: allFindings.map(f => ({
    severity: f.severity,
    file: f.file,
    line: f.line,
    title: f.title,
    description: f.description,
    suggestion: f.suggestion,
    confidence: f.confidence
  }))
};

return report;
```

## 4. Workflow 的运行与调试

### 4.1 运行

```bash
# 方式 1：在对话中直接调用
# "运行 comprehensive-review workflow，审查当前的 git diff"

# 方式 2：通过 Workflow 工具
# Workflow({ name: "comprehensive-review" })

# 方式 3：通过 /review Skill 间接触发
# /review → Skill → 调用 Workflow({ name: "comprehensive-review" })
```

### 4.2 调试技巧

```javascript
// ① 加 log 追踪进度
log(`开始审查维度: ${dim.key}`);
log(`发现 ${findings.length} 个问题`);

// ② 分包测试——先只跑一个维度
const DIMENSIONS_DEBUG = [DIMENSIONS[0]];  // 只跑 correctness

// ③ 检查中间结果
phase('Debug');
const raw = await agent('审查...', { schema: FINDING_SCHEMA });
log(`Raw result: ${JSON.stringify(raw)}`);

// ④ 查看 agent 详情（通过 /workflows 命令）
// 在 Claude Code 中输入 /workflows 查看实时进度和每个 agent 的输入输出
```

### 4.3 Resume 断点续传

```bash
# 如果 workflow 中途中断（Ctrl+C、API 错误等），可以续传：
# 1. 先停止当前 run
# TaskStop("wf_abc123")
# 2. 编辑 workflow 脚本（如果需要调整）
# Edit .claude/workflows/comprehensive-review.js
# 3. 续传（相同 agent 调用从缓存恢复）
# Workflow({ scriptPath: ".claude/workflows/comprehensive-review.js", resumeFromRunId: "wf_abc123" })
```

## 5. Token 预算自适应调度

```javascript
// 当用户使用 +200k 等 token 预算指令时，自适应调整审查深度

// budget.total → 用户设定的 token 预算（null = 无限制）
// budget.remaining() → 剩余 tokens
// budget.spent() → 已消耗 tokens

export const meta = {
  name: 'adaptive-review',
  description: '根据 token 预算自适应调整审查深度',
  phases: [{ title: 'Review' }]
};

// 根据剩余预算决定审查维度数量
const ALL_DIMS = ['correctness', 'security', 'performance', 'style'];

// 规则：每 50k tokens 可以多做一个维度
const activeDims = budget.total
  ? ALL_DIMS.slice(0, Math.max(1, Math.floor(budget.total / 50000)))
  : ALL_DIMS;  // 无限制 → 全维度

log(`Token budget: ${budget.total ? budget.total + ' tokens' : 'unlimited'}`);
log(`Active dimensions: ${activeDims.join(', ')}`);

// 只运行活跃维度
const dims = DIMENSIONS.filter(d => activeDims.includes(d.key));

// 其余逻辑同上...
```

## 6. 常见 Workflow 模式速查

```javascript
// ====== 模式 1：Find → Verify → Report ======
// 适用：审查、审计、质量检查
phase('Find');
const found = await parallel(/* 多维度搜索 */);
phase('Verify');
const verified = await pipeline(found, /* 逐条验证 */);
phase('Report');
return generateReport(verified);

// ====== 模式 2：Loop Until Dry ======
// 适用：未知数量的发现（bug/漏洞/问题）
const seen = new Set();
let dryCount = 0;
while (dryCount < 2) {
  const batch = await parallel(/* finders */);
  const fresh = batch.filter(x => !seen.has(x));
  if (fresh.length === 0) { dryCount++; continue; }
  dryCount = 0;
  fresh.forEach(x => seen.add(x));
}

// ====== 模式 3：Judge Panel ======
// 适用：方案选择、设计评审
const solutions = await parallel(/* 3 个不同方案 */);
const scores = await parallel(solutions.map((s, i) => /* 打分 */));
const best = solutions[scores.indexOf(max(scores))];

// ====== 模式 4：Divide and Conquer ======
// 适用：大范围迁移、批量重构
const files = await glob('**/*.c');
const batches = chunk(files, 5);
const results = await pipeline(batches,
  batch => parallel(batch.map(f => agent(`Fix ${f}`)))
);
```

## 下一步

下一篇将搭建 **Hook 自动化管道**：配置 PreToolUse/PostToolUse Hook 实现文件保存自动格式化、git commit 自动触发 CI、危险命令拦截审计、以及 Slack/钉钉通知集成。
