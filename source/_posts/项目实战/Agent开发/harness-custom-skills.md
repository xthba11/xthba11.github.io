---
title: 自定义 Skill 斜杠命令开发实战 —— 打造团队专属工具链
date: 2026-07-20
categories:
  - 项目实战
  - Agent开发
tags:
  - Harness
  - Skill
  - Slash Command
  - /命令
  - .claude/skills
  - 自动化
description: Harness 实战第二篇：从零创建三个自定义 Skill——/auto-changelog（自动生成 CHANGELOG）、/dep-update（依赖更新检查）、/gen-test（一键生成测试）。详解 Skill Markdown 文件规范、参数传递、Skill 与 Agent 类型协作
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# 自定义 Skill 斜杠命令开发实战

## 1. 实战目标

实现三个实用的自定义 Skill，每次只需要输入一个斜杠命令：

```bash
/auto-changelog      # 自动分析 git log → 生成 CHANGELOG.md
/dep-update          # 检查 package.json 依赖 → 逐条分析是否需要更新
/gen-test src/driver.c  # 分析源文件 → 自动生成单元测试
```

## 2. Skill 文件结构规范

```text
项目根目录/
├── .claude/
│   └── skills/
│       ├── auto-changelog.md     ← Skill 定义文件
│       ├── dep-update.md
│       └── gen-test.md
```

每个 Skill 文件 = Frontmatter 元信息 + Markdown 正文（行为指令）：

```markdown
---
name: skill-name              # Skill 名称（kebab-case）
description: 一行描述          # 在 Skill 列表中显示
---

# Skill 标题

详细的行为指令、工作流程、输出格式...
（这些内容会被注入到 Agent 的 System Prompt 中）
```

## 3. 案例一：/auto-changelog

### 3.1 Skill 文件

```markdown
<!-- .claude/skills/auto-changelog.md -->

---
name: auto-changelog
description: >-
  自动分析 git log 并按 Conventional Commits 规范生成
  CHANGELOG.md。支持 --since 和 --output 参数。
---

# Auto Changelog Generator

根据 git commit 历史自动生成符合 Keep a Changelog 规范的 CHANGELOG.md。

## 行为流程

### Step 1: 获取 commit 历史

```bash
# 默认从上一个 tag 开始，可通过 --since 参数指定
git log $(git describe --tags --abbrev=0)..HEAD \
  --pretty=format:"%s|%h|%an" --no-merges
```

### Step 2: 按 Conventional Commits 分类

| 前缀 | 分类 | 示例 |
|------|------|------|
| `feat:` `feat(scope):` | Added（新增功能） | `feat(sensor): 添加 BMP280 驱动` |
| `fix:` `fix(scope):` | Fixed（问题修复） | `fix(uart): 修复 DMA 接收丢字节` |
| `perf:` | Changed（性能优化） | `perf: 优化 LVGL 渲染缓冲大小` |
| `refactor:` | Changed（代码重构） | `refactor: 抽取 I2C 公共接口` |
| `docs:` | Documentation（文档） | `docs: 更新 BSP 架构文档` |
| `chore:` `ci:` `test:` | Internal（内部改进） | `ci: 添加固件大小检查` |

### Step 3: 生成 CHANGELOG.md

```markdown
# Changelog

## [Unreleased] — 2026-07-20

### Added
- BMP280 气压计驱动支持 ([a1b2c3d](https://github.com/...))
- EM7028 心率传感器 PPG 算法 ([e4f5g6h](https://github.com/...))

### Fixed
- UART DMA 接收时偶发丢字节问题 ([i7j8k9l](https://github.com/...))
- MPU6050 睡眠后无法唤醒 ([m0n1o2p](https://github.com/...))

### Changed
- LVGL 行缓冲从 10 行增加到 20 行，帧率提升 30%
- I2C 超时从 500ms 调整为 1000ms（兼容慢速设备）

### Documentation
- 新增 BSP 驱动开发系列文章（5 篇）

### Internal
- CI 添加固件大小检查步骤
```

### Step 4: 写入文件

- 如果 CHANGELOG.md 存在 → 在 `## [Unreleased]` 段落下插入新内容
- 如果不存在 → 创建新文件
- 可通过 `--output <path>` 指定输出路径

## 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--since <tag>` | 从指定 tag 开始 | 自动取最新 tag |
| `--output <path>` | 输出文件路径 | `./CHANGELOG.md` |
| `--dry-run` | 只打印不写入 | false |
```

### 3.2 使用方式

```bash
# 在 Claude Code 中输入：
/auto-changelog
# → Agent 按 Skill 定义执行 → 生成 CHANGELOG.md

/auto-changelog --since v1.0.0 --dry-run
# → 从 v1.0.0 开始分析，只打印不写入
```

## 4. 案例二：/dep-update

### 4.1 Skill 文件

```markdown
<!-- .claude/skills/dep-update.md -->

---
name: dep-update
description: >-
  检查项目依赖的最新版本，逐条分析 changelog，
  判断是否值得升级，生成升级建议报告。
---

# Dependency Update Checker

## 行为流程

### Step 1: 读取依赖文件

```bash
# 根据项目类型自动检测
cat package.json | jq '.dependencies, .devDependencies'
```

支持的包管理器：npm、pip、cargo（根据项目文件自动判断）

### Step 2: 逐条查询最新版本

对每个依赖包：
```bash
npm view <package> version        # 最新版本
npm view <package> time           # 发布时间
npm view <package> repository.url # 仓库地址
```

### Step 3: 分析 Changelog

```bash
# 用 WebFetch 抓取 GitHub Release 页面
# 提取当前版本 到 最新版本 之间的 change log
```

### Step 4: 生成升级建议

| 升级建议 | 条件 |
|---------|------|
| 🟢 建议立即升级 | 安全补丁、无 breaking change、版本号跨度小 |
| 🟡 建议择机升级 | 有新功能但需要适配、minor 版本升级 |
| 🔴 谨慎升级 | 有 breaking change、major 版本升级、依赖链复杂 |
| ⚪ 无需升级 | 已是最新版本 |

### Step 5: 输出报告

```markdown
## 依赖升级报告 — 2026-07-20

| 包名 | 当前版本 | 最新版本 | 建议 | 原因 |
|------|---------|---------|:---:|------|
| hexo | 7.2.0 | 7.3.1 | 🟢 | Bug 修复，无 breaking |
| highlight.js | 11.9.0 | 11.10.0 | 🟡 | 新增语言支持 |
| hexo-theme-butterfly | 4.13.0 | 5.0.0 | 🔴 | 大版本，配置格式变化 |

### Breaking Change 详情

#### hexo-theme-butterfly 4.13.0 → 5.0.0
- `_config.butterfly.yml` 配置结构大幅变化
- 自定义 CSS 路径变更
- 建议：等有足够时间做全量回归测试时再升级
```

## 参数

| 参数 | 说明 |
|------|------|
| `--major` | 包含 major 版本检查（默认跳过） |
| `--security-only` | 只检查安全相关的更新 |
```

## 5. 案例三：/gen-test

### 5.1 Skill 文件

```markdown
<!-- .claude/skills/gen-test.md -->

---
name: gen-test
description: >-
  分析 C 源代码文件，自动生成单元测试骨架。
  支持参数化 Mock 和边界条件覆盖。
---

# Unit Test Generator

## 行为流程

### Step 1: 解析源文件

```bash
# 读取目标文件
Read <file_path>
```

识别：
- 所有公开函数（`.h` 中声明的）
- 每个函数的参数类型、返回值、调用的外部依赖

### Step 2: 生成 Mock 声明

对每个外部依赖（HAL 库、I2C、SPI、RTOS API）生成 Mock：

```c
// Mock: HAL_I2C_Mem_Read
static HAL_StatusTypeDef mock_i2c_read_status = HAL_OK;
static uint8_t mock_i2c_read_data[256];
static uint16_t mock_i2c_read_len = 0;

HAL_StatusTypeDef HAL_I2C_Mem_Read(I2C_HandleTypeDef *hi2c,
    uint16_t DevAddress, uint16_t MemAddress,
    uint16_t MemAddSize, uint8_t *pData,
    uint16_t Size, uint32_t Timeout)
{
    if (mock_i2c_read_status != HAL_OK)
        return mock_i2c_read_status;
    memcpy(pData, mock_i2c_read_data,
           Size < mock_i2c_read_len ? Size : mock_i2c_read_len);
    return HAL_OK;
}
```

### Step 3: 生成测试用例

为每个函数生成：
1. Happy Path × 1
2. 边界条件 × 2
3. 错误路径 × 2

```c
// TEST GROUP: bsp_aht21_read_temp_humi

// TC01 — 正常读取温湿度
void test_aht21_read_normal(void) {
    uint8_t mock_data[] = {0x00, 0x7F, 0xFF, 0x0F, 0x7F, 0xFF};
    mock_i2c_read_status = HAL_OK;
    mock_i2c_set_response(mock_data, 6);
    float temp, humi;
    aht21_status_t ret = aht21_read_temp_humi(&drv, &temp, &humi);
    TEST_ASSERT(ret == AHT21_OK);
    TEST_ASSERT(temp > -40.0f && temp < 85.0f);
    TEST_ASSERT(humi >= 0.0f && humi <= 100.0f);
}

// TC02 — I2C 超时
void test_aht21_read_i2c_timeout(void) {
    mock_i2c_read_status = HAL_TIMEOUT;
    float temp, humi;
    aht21_status_t ret = aht21_read_temp_humi(&drv, &temp, &humi);
    TEST_ASSERT(ret == AHT21_ERRORTIMEOUT);
}

// TC03 — 传感器繁忙超时
void test_aht21_read_busy_timeout(void) {
    // Mock 状态寄存器一直返回 Busy
    mock_status_register = 0x80;
    float temp, humi;
    aht21_status_t ret = aht21_read_temp_humi(&drv, &temp, &humi);
    TEST_ASSERT(ret == AHT21_ERRORTIMEOUT);
}

// TC04 — 未初始化调用
void test_aht21_read_uninitialized(void) {
    // 不调用 aht21_inst 直接读取
    float temp, humi;
    aht21_status_t ret = aht21_read_temp_humi(&drv, &temp, &humi);
    TEST_ASSERT(ret == AHT21_ERRORRESOURCE);
}

// TC05 — NULL 指针
void test_aht21_read_null_temp(void) {
    float humi;
    aht21_status_t ret = aht21_read_temp_humi(&drv, NULL, &humi);
    TEST_ASSERT(ret == AHT21_ERRORPARAMETER);
}
```

### Step 4: 输出完整测试文件

生成的测试文件包含：
- `#include` 和 Mock 声明
- `setUp()` / `tearDown()`
- 所有测试用例
- 测试运行器 `main()`

可以直接编译运行，无需手动修改。

## 参数

| 参数 | 说明 |
|------|------|
| `<file>` | 必填：目标源文件路径 |
| `--framework unity` | 测试框架（默认 unity） |
| `--output <path>` | 输出文件路径 |
```

### 5.2 使用

```bash
/gen-test 02_BSP_Platform/Bsp_Drivers/Sensor_Temphumi/driver/Aht21/Src/bsp_aht21_driver.c
# → 输出 test/test_bsp_aht21_driver.c
```

## 6. Skill 设计检查清单

```text
┌─────────────────────────────────────────────────────────┐
│ Skill 文件质量检查：                                      │
│                                                         │
│ □ name 是否简洁且描述性强（kebab-case）                   │
│ □ description 是否准确描述了 Skill 的功能                  │
│ □ 正文是否明确了"做什么"和"怎么做"                         │
│ □ 是否提供了输出格式示例（模型需要 concrete example）       │
│ □ 是否区分了"必须遵循"的规则和"建议参考"的指引              │
│ □ 是否说明了参数的使用方式                                 │
│ □ 是否处理了错误情况（文件不存在、权限不足等）              │
│                                                         │
│ 避免的坑：                                                │
│ ✗ Skill 正文太长（>500 行）→ 占用过多 context window        │
│ ✗ Skill 正文太抽象（"做好代码审查"）→ 模型不知道怎么做       │
│ ✗ Skill 正文写"你是一个专家"但没有具体流程 → 效果不稳定      │
│ ✓ Skill 正文把流程拆成具体的 Step 1/2/3 → 效果稳定          │
└─────────────────────────────────────────────────────────┘
```

## 7. Skill 与 Agent 类型的协作

```bash
# Skill 可以调用指定的 Agent 类型来执行子任务
# 在 Skill 正文中声明：

# "当需要代码审查时，使用 code-reviewer Agent 类型：
#  Agent({ prompt: '审查 ${FILE}', subagent_type: 'code-reviewer' })"

# "当需要生成文档注释时，使用 doc-generator Agent 类型"

# 这样 Skill 就是"流程编排者"，Agent 类型是"专业执行者"
```

## 下一步

下一篇将实现 **Workflow 多代理编排**：编写 JS 编排脚本，实现一个完整的代码审查流水线——并行审查 4 个维度 → 对抗验证每个发现 → 生成审查报告。详细讲解 parallel/pipeline/phase/budget 的使用模式。
