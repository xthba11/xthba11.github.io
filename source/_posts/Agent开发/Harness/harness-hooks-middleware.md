---
title: Harness Hook 机制与中间件设计 —— 拦截、审计与自动化
date: 2026-07-20
categories:
  - Agent开发
  - Harness
tags:
  - Harness
  - Hook
  - 中间件
  - PreToolUse
  - PostToolUse
  - 审计
  - 自动化
description: Harness Hook 机制深度解析：PreToolUse/PostToolUse/Notification 三类 Hook 的生命周期、matcher 匹配语法（精确/通配符/正则）、Hook 脚本的环境变量注入、返回值控制（allowDeny/上下文修改）、实战场景（自动格式化、安全拦截、日志审计、通知集成）
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# Harness Hook 机制与中间件设计

## 1. Hook 是什么

Hook 是 Harness 的事件拦截机制——在工具调用前后、通知发生时，自动执行自定义命令。类比 Web 框架的中间件：

```
Express.js:                    Harness:
  app.use(logger)                hooks.PreToolUse  → 日志审计
  app.use(auth)                  hooks.PreToolUse  → 权限拦截
  app.use(compression)           hooks.PostToolUse → 结果处理
  app.use(errorHandler)          hooks.Notification → 告警通知
```

**Hook 的三个关键能力**：
1. **观察**：记录每次工具调用的参数和结果
2. **拦截**：根据规则阻止危险操作（allowDeny）
3. **修改**：在工具执行前后注入或修改数据

## 2. 三类 Hook 详解

### 2.1 PreToolUse（工具调用前）

```
触发时机: 权限检查通过后、工具实际执行前
执行流程:
  ┌─────────┐    ┌──────────┐    ┌────────────┐    ┌──────────┐
  │ 模型调用  │ → │ 权限检查   │ → │ PreToolUse │ → │ 工具执行   │
  │ tool_use │    │ allowlist │    │ Hook       │    │ actual    │
  └─────────┘    └──────────┘    └─────┬──────┘    └──────────┘
                                       │
                                  Hook 可以:
                                  ① 记录日志（不阻止执行）
                                  ② 返回 {allowDeny: true, decision: "deny"}
                                     → 阻止工具执行
                                  ③ 返回修改后的上下文 → 给模型额外提示
```

```jsonc
// settings.json 中的 PreToolUse Hook 配置

"hooks": {
  "PreToolUse": [
    // Hook 1：记录所有 Bash 命令到审计日志
    {
      "matcher": "Bash(*)",
      "command": "/usr/local/bin/harness-audit-log.sh",
      "allowDeny": false,       // 只记录，不拦截
      "timeout": 5000           // Hook 脚本 5s 超时
    },

    // Hook 2：阻止危险的 rm 命令
    {
      "matcher": "Bash(rm *)",
      "command": "echo 'BLOCKED: rm command detected' && exit 1",
      "allowDeny": true         // ★ 可以阻止执行
      // 如果脚本 exit code ≠ 0 → 返回 {decision: "deny"} → 工具不执行
    },

    // Hook 3：在写文件前格式化代码
    {
      "matcher": "Write(**/*.{ts,js,json})",
      "command": "npx prettier --check \"$FILE_PATH\"",
      "allowDeny": false
    }
  ]
}
```

### 2.2 PostToolUse（工具调用后）

```
触发时机: 工具执行完成后、结果返回给模型前
执行流程:
  ┌──────────┐    ┌───────────┐    ┌────────────┐
  │ 工具执行   │ → │ PostToolUse│ → │ 结果注入模型 │
  │ result   │    │ Hook       │    │ context    │
  └──────────┘    └─────┬─────┘    └────────────┘
                        │
                   Hook 可以:
                   ① 自动格式化 Write 后的文件
                   ② 提取工具结果中的关键信息并记录
                   ③ 触发 CI/CD 流程（如果测试通过）
```

```jsonc
"hooks": {
  "PostToolUse": [
    // Hook 1：Write 后自动运行 prettier 格式化
    {
      "matcher": "Write(**/*.{ts,js,css,json,md})",
      "command": "npx prettier --write \"$FILE_PATH\""
    },

    // Hook 2：Bash(git commit) 后自动推送到远程
    {
      "matcher": "Bash(git commit *)",
      "command": "git push origin HEAD"
    },

    // Hook 3：测试通过后发送通知
    {
      "matcher": "Bash(npm test)",
      "command": "notify-send 'Tests passed!' 'All tests completed successfully'"
    }
  ]
}
```

### 2.3 Notification（会话事件通知）

```
触发时机: Agent 完成一轮对话、权限请求、错误发生等
事件类型:
  - agent.turn.complete   → 一轮对话完成
  - permission.requested   → 用户被要求确认操作
  - error.occurred        → 工具执行出错
  - session.idle           → Agent 空闲等待
```

```jsonc
"hooks": {
  "Notification": [
    {
      "matcher": "agent.turn.complete",
      "command": "osascript -e 'display notification \"Claude turn completed\"'"
    },
    {
      "matcher": "permission.requested",
      "command": "afplay /System/Library/Sounds/Glass.aiff"
    },
    {
      "matcher": "error.occurred",
      "command": "curl -X POST https://hooks.slack.com/xxx -d '{\"text\":\"Agent error occurred\"}'"
    }
  ]
}
```

## 3. Matcher 匹配语法

```text
┌─────────────────────────────────────────────────────────────┐
│ Matcher 支持三种模式：                                        │
│                                                             │
│ ① 通配符匹配 (* 和 **)                                       │
│   "Bash(*)"          → 匹配所有 Bash 调用                    │
│   "Bash(git *)"      → 匹配 git 开头的 Bash 调用             │
│   "Write(**/*.ts)"   → 匹配所有 .ts 文件的 Write             │
│                                                             │
│ ② 精确匹配                                                   │
│   "Bash(npm test)"   → 只匹配 "npm test" 命令                │
│   "Read(/path/to/config.json)" → 只匹配读取特定文件           │
│                                                             │
│ ③ 空字符串（匹配全部）                                        │
│   ""                 → 匹配所有工具的所有调用                  │
│   用于 Notification hook 的全局监听                          │
│                                                             │
│ 特殊匹配规则：                                                │
│   • ** 只能出现在路径模式中（如文件路径）                       │
│   • * 匹配单个路径段内任意字符                                 │
│   • 大小写敏感（Bash ≠ bash）                                │
└─────────────────────────────────────────────────────────────┘
```

## 4. Hook 脚本环境变量

Hook 执行时，Harness 向子进程注入以下环境变量：

```bash
# PreToolUse / PostToolUse 可用的环境变量：

$TOOL_NAME         # 工具名，如 "Bash", "Write", "Read"
$TOOL_INPUT        # 完整的工具参数 JSON 字符串
$FILE_PATH         # Write/Read 的文件路径（方便提取）
$PROJECT_DIR       # 项目根目录
$SESSION_ID        # 当前会话 ID
$AGENT_TYPE        # 当前 Agent 类型

# 示例：PreToolUse Hook 脚本
#!/bin/bash
# harness-audit-log.sh

LOG_FILE="$HOME/.claude/audit.log"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# 记录工具调用
echo "[$TIMESTAMP] $AGENT_TYPE called $TOOL_NAME: $TOOL_INPUT" >> "$LOG_FILE"

# PostToolUse 额外可用：
$TOOL_OUTPUT       # 工具执行结果
$TOOL_SUCCESS      # "true" 或 "false"
$TOOL_DURATION_MS  # 执行耗时
```

## 5. AllowDeny 机制

```jsonc
// 当 allowDeny = true 时，Hook 脚本的返回值决定是否允许执行

{
  "matcher": "Bash(rm *)",
  "command": "harness-rm-guard.sh",
  "allowDeny": true
}
```

```bash
#!/bin/bash
# harness-rm-guard.sh —— 安全检查脚本

# 检查是否试图删除重要文件
if echo "$TOOL_INPUT" | grep -qE "(/etc/|/usr/|~/)"; then
  # exit 1 → Harness 阻止执行
  echo "BLOCKED: Attempted to delete system file"
  exit 1
fi

# 检查是否使用了 -rf
if echo "$TOOL_INPUT" | grep -q "\-rf"; then
  # exit 1 → 阻止
  echo "BLOCKED: rm -rf is forbidden"
  exit 1
fi

# exit 0 → 允许执行
echo "OK: Safe rm command"
exit 0
```

```text
AllowDeny 返回值规则：

exit 0:
  → decision: "allow" → 工具正常执行
  → stdout 内容追加到对话上下文（模型可见）

exit 非0:
  → decision: "deny"  → 工具被阻止
  → stdout 作为拒绝原因返回给模型
  → 模型通常会解释拒绝原因并寻找替代方案

超时 (timeout):
  → 如果 allowDeny = true: 视为 deny
  → 如果 allowDeny = false: 忽略 hook 错误，工具正常执行
```

## 6. 实战场景

### 6.1 场景 1：自动代码格式化

```jsonc
// 每次 Write 后自动运行 prettier —— 保证所有代码风格一致
{
  "matcher": "Write(**/*.{ts,tsx,js,jsx,json,css,md})",
  "command": "npx prettier --write \"$FILE_PATH\" 2>&1",
  "timeout": 10000
}
```

### 6.2 场景 2：安全审计日志

```jsonc
// 记录所有文件修改和 Shell 命令到审计日志
{
  "matcher": "",  // 匹配所有
  "command": "python3 ~/.claude/scripts/audit.py",
  "allowDeny": false
}
```

```python
# ~/.claude/scripts/audit.py
import os, json, datetime

tool = os.environ['TOOL_NAME']
tool_input = os.environ['TOOL_INPUT']
agent = os.environ['AGENT_TYPE']

entry = {
    'timestamp': datetime.datetime.utcnow().isoformat(),
    'agent': agent,
    'tool': tool,
    'input': json.loads(tool_input) if tool_input else {}
}

# 写入 JSONL 日志文件
with open(os.path.expanduser('~/.claude/audit.jsonl'), 'a') as f:
    f.write(json.dumps(entry) + '\n')
```

### 6.3 场景 3：CI/CD 触发

```jsonc
// Bash(git push) 后触发 CI 流水线
{
  "matcher": "Bash(git push *)",
  "command": "gh workflow run ci.yml --ref main",
  "timeout": 15000
}
```

### 6.4 场景 4：自动生成 Commit Message

```jsonc
// Write 后检查是否应该自动 commit
{
  "matcher": "Write(*.ts)",
  "command": "bash ~/.claude/scripts/auto-commit.sh"
}
```

```bash
#!/bin/bash
# auto-commit.sh

FILE="$FILE_PATH"

# 只在暂存区有对应文件时才 commit
if git diff --cached --name-only | grep -q "$FILE"; then
  # 从 Agent 的行为推断 commit message
  COMMIT_MSG="chore: update $FILE (auto-generated by Harness Agent)"
  git commit -m "$COMMIT_MSG" "$FILE"
fi
```

## 7. Hook 的执行保证

```
┌─────────────────────────────────────────────────────────┐
│ Hook 执行顺序和保证：                                     │
│                                                         │
│ ① 多个 Hook 按 settings.json 中的声明顺序串行执行         │
│ ② 每个 Hook 有独立的超时（默认 30s）                      │
│ ③ Hook 失败不影响工具执行（除非 allowDeny = true）         │
│ ④ Hook 在独立的子进程中执行（不污染 Agent 环境）           │
│ ⑤ Hook 的 stderr 被记录但不注入对话上下文                  │
│ ⑥ Hook 执行期间 Agent 处于等待状态                         │
│                                                         │
│ 性能影响：                                                │
│   每个 Hook 增加 ~50-200ms 延迟                          │
│   过多的 Hook 会显著拖慢 Agent 响应                       │
│   建议：关键路径 ≤ 2 个 PreToolUse Hook                   │
└─────────────────────────────────────────────────────────┘
```

## 8. 调试 Hook

```bash
# ① 查看 Hook 执行日志
cat ~/.claude/logs/hooks.log

# ② 手动测试 Hook 脚本
TOOL_NAME="Write" \
TOOL_INPUT='{"file_path":"/test.ts"}' \
FILE_PATH="/test.ts" \
PROJECT_DIR="$PWD" \
bash ~/.claude/scripts/your-hook.sh

# ③ 在 Hook 脚本中加调试输出
echo "DEBUG: TOOL_NAME=$TOOL_NAME" >> /tmp/hook-debug.log

# ④ 临时禁用 Hook（注释 settings.json 中的 matcher）
# "matcher": ""  → Disabled
```

## 下一步

最后一篇将深入 **Harness Skills 系统与 Workflow 编排**：Skill 的定义与加载机制、Slash Command 的触发流程、Workflow 脚本的编写（agent/pipeline/parallel 编排）、以及如何将前几篇的知识组合为可复用的自动化流水线。
