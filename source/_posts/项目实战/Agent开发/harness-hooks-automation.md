---
title: Hook 自动化管道搭建实战 —— 打造 Git 提交→格式化→CI→通知全自动链路
date: 2026-07-20
categories:
  - 项目实战
  - Agent开发
tags:
  - Harness
  - Hook
  - 自动化
  - CI/CD
  - PreToolUse
  - PostToolUse
  - settings.json
description: Harness 实战第四篇：搭建完整自动化管道——Write后自动代码格式化、git commit自动触发CI、危险命令拦截审计、Slack/钉钉通知集成。从零配置 6 个实用 Hook 脚本
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# Hook 自动化管道搭建实战

## 1. 实战目标

搭建涵盖"编码→格式化→提交→CI→通知"全链路的自动化管道：

```
Agent 写代码
    │
    ▼ (PreToolUse: 审计日志)
Agent Write file
    │
    ▼ (PostToolUse: 自动格式化)
prettier --write
    │
    ▼ (PreToolUse: 安全检查)
Agent Bash(git commit)
    │
    ▼ (PostToolUse: 自动推送 + CI触发)
git push && gh workflow run
    │
    ▼ (Notification: 通知)
Slack / 钉钉 / macOS 通知
```

## 2. 配置文件总览

```jsonc
// .claude/settings.local.json（项目级 Hook 配置）

{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash(rm *)",          "command": "...", "allowDeny": true },
      { "matcher": "Write(**/*.{c,h})",   "command": "...", "allowDeny": false },
      { "matcher": "Bash(git push *)",    "command": "...", "allowDeny": false }
    ],
    "PostToolUse": [
      { "matcher": "Write(**/*.{ts,js,json,md})", "command": "..." },
      { "matcher": "Write(**/*.{c,h})",           "command": "..." },
      { "matcher": "Bash(git commit *)",           "command": "..." }
    ],
    "Notification": [
      { "matcher": "permission.requested",  "command": "..." },
      { "matcher": "agent.turn.complete",   "command": "..." }
    ]
  }
}
```

## 3. Hook 一：文件保存自动格式化

### 3.1 C 代码格式化（clang-format）

```jsonc
{
  "matcher": "Write(**/*.{c,h})",
  "command": "bash .claude/hooks/format-c.sh"
}
```

```bash
#!/bin/bash
# .claude/hooks/format-c.sh

FILE="$FILE_PATH"

# 只处理 .c 和 .h 文件
if [[ "$FILE" != *.c ]] && [[ "$FILE" != *.h ]]; then
  exit 0
fi

# 检查 clang-format 是否可用
if ! command -v clang-format &> /dev/null; then
  echo "[Hook] clang-format not found, skipping"
  exit 0
fi

# 使用项目根目录的 .clang-format 配置格式化
clang-format -i "$FILE" --style=file

echo "[Hook] Formatted: $FILE"
```

### 3.2 前端代码格式化（prettier）

```jsonc
{
  "matcher": "Write(**/*.{ts,js,json,css,md})",
  "command": "npx prettier --write \"$FILE_PATH\" 2>&1",
  "timeout": 10000
}
```

## 4. Hook 二：危险命令拦截

```jsonc
{
  "matcher": "Bash(rm *)",
  "command": "node .claude/hooks/rm-guard.js",
  "allowDeny": true,
  "timeout": 3000
}
```

```javascript
// .claude/hooks/rm-guard.js

const toolInput = JSON.parse(process.env.TOOL_INPUT || '{}');
const command = toolInput.command || '';

// 规则引擎
const BLOCK_RULES = [
  // 禁止删除系统目录
  { pattern: /\brm\b.*\/(etc|usr|var|boot|sys|proc)\//,
    reason: '禁止删除系统目录' },
  // 禁止强制递归删除（除非在白名单路径内）
  { pattern: /\brm\b.*-rf\b/,
    reason: 'rm -rf 已全局禁止。请手动确认后添加 --allow-dangerous 参数' },
  // 禁止删除 git 仓库
  { pattern: /\brm\b.*\.git\b/,
    reason: '禁止删除 .git 目录' }
];

// 白名单：允许的安全删除
const ALLOW_PATTERNS = [
  /\brm\b.*node_modules\/\.cache\b/,
  /\brm\b.*\.o\b/,         // 允许删除编译产物
  /\brm\b.*\.d\b/,         // 允许删除依赖文件
  /\brm\b.*--allow-dangerous\b/  // 手动标记为允许
];

for (const rule of BLOCK_RULES) {
  if (rule.pattern.test(command)) {
    // 检查是否在白名单中
    const allowed = ALLOW_PATTERNS.some(p => p.test(command));
    if (!allowed) {
      console.log(`BLOCKED: ${rule.reason}`);
      console.log(`Command: ${command}`);
      process.exit(1);  // exit 1 → allowDeny 拦截
    }
  }
}

// 即使放行也记录审计日志
const fs = require('fs');
fs.appendFileSync(
  require('os').homedir() + '/.claude/rm-audit.log',
  `[${new Date().toISOString()}] ALLOWED: ${command}\n`
);

process.exit(0);  // 放行
```

## 5. Hook 三：Git 提交自动推送 + CI 触发

```jsonc
// 当 Agent 执行 git commit 后 → 自动推送 → 触发 CI
{
  "matcher": "Bash(git commit *)",
  "command": "bash .claude/hooks/auto-push-ci.sh"
}
```

```bash
#!/bin/bash
# .claude/hooks/auto-push-ci.sh

TOOL_INPUT=$(echo "$TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command',''))")

# ① 自动推送到远程（除非用户明确使用 --no-push）
if ! echo "$TOOL_INPUT" | grep -q '\--no-push'; then
  echo "[Hook] Auto-pushing to remote..."
  git push origin HEAD 2>&1

  if [ $? -eq 0 ]; then
    # ② 触发 CI（GitHub Actions）
    if command -v gh &> /dev/null; then
      echo "[Hook] Triggering CI pipeline..."
      gh workflow run ci.yml --ref "$(git rev-parse --abbrev-ref HEAD)" 2>&1
    fi
  fi
fi

echo "[Hook] Post-commit pipeline completed"
```

## 6. Hook 四：通知集成

### 6.1 macOS 系统通知

```jsonc
{
  "matcher": "agent.turn.complete",
  "command": "bash .claude/hooks/notify-macos.sh"
}
```

```bash
#!/bin/bash
# .claude/hooks/notify-macos.sh

TITLE="Claude Turn Completed"
MESSAGE="Agent finished processing. Check the output."

osascript -e "display notification \"$MESSAGE\" with title \"$TITLE\""
```

### 6.2 钉钉机器人通知

```bash
#!/bin/bash
# .claude/hooks/notify-dingtalk.sh

WEBHOOK_URL="https://oapi.dingtalk.com/robot/send?access_token=YOUR_TOKEN"

# 获取当前任务摘要
SUMMARY="${TOOL_NAME}: $(echo $TOOL_INPUT | head -c 100)"

curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"msgtype\": \"text\",
    \"text\": {
      \"content\": \"[Claude Agent] ${SUMMARY}\nTime: $(date)\nSession: ${SESSION_ID}\"
    }
  }"
```

### 6.3 权限请求声音提醒

```jsonc
{
  "matcher": "permission.requested",
  "command": "afplay /System/Library/Sounds/Glass.aiff"
}
```

## 7. Hook 五：审计日志持久化

```jsonc
{
  "matcher": "",  // 空字符串 = 匹配所有工具调用
  "command": "python3 .claude/hooks/audit-logger.py",
  "allowDeny": false
}
```

```python
#!/usr/bin/env python3
# .claude/hooks/audit-logger.py

import os, json, datetime, sqlite3
from pathlib import Path

LOG_DIR = Path.home() / '.claude' / 'audit'
LOG_DIR.mkdir(parents=True, exist_ok=True)

# SQLite 存储（支持查询和分析）
db = sqlite3.connect(str(LOG_DIR / 'tool-calls.db'))
db.execute('''CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT,
    agent_type TEXT,
    tool_name TEXT,
    tool_input TEXT,
    success TEXT,
    duration_ms INTEGER,
    session_id TEXT
)''')

# 从环境变量读取
entry = {
    'timestamp': datetime.datetime.utcnow().isoformat(),
    'agent_type': os.environ.get('AGENT_TYPE', 'unknown'),
    'tool_name': os.environ.get('TOOL_NAME', 'unknown'),
    'tool_input': os.environ.get('TOOL_INPUT', '{}')[:1000],
    'success': os.environ.get('TOOL_SUCCESS', 'unknown'),
    'duration_ms': int(os.environ.get('TOOL_DURATION_MS', '0')),
    'session_id': os.environ.get('SESSION_ID', 'unknown')
}

db.execute('INSERT INTO calls VALUES (NULL,?,?,?,?,?,?,?)',
           (entry['timestamp'], entry['agent_type'],
            entry['tool_name'], entry['tool_input'],
            entry['success'], entry['duration_ms'],
            entry['session_id']))
db.commit()
db.close()

# 同时在 JSONL 中保留一份（便于 grep/jq）
with open(LOG_DIR / 'tool-calls.jsonl', 'a') as f:
    f.write(json.dumps(entry) + '\n')
```

### 查询审计日志

```bash
# 查询今天所有的 Bash 命令
sqlite3 ~/.claude/audit/tool-calls.db \
  "SELECT timestamp, json_extract(tool_input, '$.command')
   FROM calls WHERE tool_name='Bash' AND date(timestamp)=date('now')"

# 统计各工具的调用次数
jq -r '.tool_name' ~/.claude/audit/tool-calls.jsonl | sort | uniq -c | sort -rn

# 查看最近 1 小时的 Write 操作
jq 'select(.tool_name=="Write" and .timestamp > "2026-07-20T10:00")' \
  ~/.claude/audit/tool-calls.jsonl
```

## 8. Hook 六：C 代码编译检查

```jsonc
// 每次 Write .c/.h 文件后，尝试编译检查（不生成最终固件）
{
  "matcher": "Write(**/*.{c,h})",
  "command": "bash .claude/hooks/compile-check.sh",
  "timeout": 30000
}
```

```bash
#!/bin/bash
# .claude/hooks/compile-check.sh

FILE="$FILE_PATH"
PROJECT_DIR="${PROJECT_DIR:-.}"

# 只对 C 项目中的文件做检查
if [ ! -f "$PROJECT_DIR/Makefile" ]; then
  exit 0  # 没有 Makefile，跳过
fi

cd "$PROJECT_DIR"

# 只做语法检查，不链接（速度快）
make -j4 syntax-check 2>&1 | tail -10

# 如果有错误，输出但不要让 Hook 失败
# （Agent 会看到输出并修复，不需要 Hook 拦截）
```

## 9. Hook 调试与测试

```bash
# ① 手动模拟 Hook 运行
TOOL_NAME="Write" \
TOOL_INPUT='{"file_path":"test.c"}' \
FILE_PATH="test.c" \
PROJECT_DIR="$PWD" \
bash .claude/hooks/format-c.sh

# ② 查看 Hook 执行日志
tail -f ~/.claude/logs/hooks.log

# ③ 检查 Hook 是否被正确加载
# 在 Claude Code 中查看 settings：
# /config → 检查 hooks 段是否完整

# ④ 逐个启用 Hook（避免一次性加太多导致性能问题）
# 先只启用 1 个 → 测试通过 → 加第 2 个 → ...
```

## 10. 性能考虑

```text
Hook 耗时累积：
  PreToolUse × 2  (~100ms)
  + Tool Execute   (不定)
  + PostToolUse × 2 (~150ms)
  ─────────────────────────
  ≈ 额外 250ms / 每次工具调用

优化建议：
  □ 高频路径（Write/Read）只用轻量 Hook（<50ms）
  □ 耗时 Hook（编译检查）设置合理 timeout
  □ Hook 中使用缓存避免重复计算
  □ 开发环境可以关闭非关键 Hook
  □ 定期审查 Hook 日志，清理不再需要的 Hook
```

## 下一步

最后一篇将实现 **MCP Server 开发与集成**：用 Node.js 开发一个自定义 MCP Server，为 Agent 提供嵌入式开发专用工具（读取芯片寄存器、解析 .bin 固件、查询数据手册），并集成到 Harness 中。
