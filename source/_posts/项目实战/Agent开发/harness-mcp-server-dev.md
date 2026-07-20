---
title: MCP Server 开发与集成实战 —— 为 Agent 扩展自定义工具
date: 2026-07-20
categories:
  - 项目实战
  - Agent开发
tags:
  - Harness
  - MCP
  - MCP Server
  - 工具扩展
  - JSON-RPC
  - Node.js
  - 嵌入式工具
description: Harness 实战第五篇：从零开发一个嵌入式开发专用 MCP Server。实现芯片寄存器查询、固件二进制解析、数据手册搜索 3 个自定义工具，讲解 MCP 协议（tools/list + tools/call）、Server 注册与调试、与内置工具的统一调用
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# MCP Server 开发与集成实战

## 1. 实战目标

开发一个嵌入式开发专用 MCP Server，为 Agent 提供 3 个自定义工具：

| 工具名 | 功能 | 用法示例 |
|--------|------|---------|
| `register_lookup` | 查询 STM32 寄存器定义 | "查 RCC_CR 寄存器的 bit 0 是什么" |
| `firmware_parse` | 解析 .bin 固件信息 | "解析 firmware.bin 的向量表和段信息" |
| `datasheet_search` | 搜索本地数据手册 | "搜索 MPU6050 的 I2C 地址配置" |

```
┌──────────────────────────────────────────────────┐
│  Agent 调用工具:                                    │
│  "查一下 STM32F411 的 FLASH_ACR 寄存器"             │
│       │                                           │
│       ▼                                           │
│  Harness → mcp__embedded_tools__register_lookup   │
│       │                                           │
│       ▼                                           │
│  MCP Server (Node.js 进程)                         │
│       │                                           │
│       ├── ① 接收 JSON-RPC 请求                     │
│       ├── ② 查询本地数据库 (SQLite)                 │
│       ├── ③ 返回结构化结果                          │
│       └── ④ Agent 看到寄存器信息 → 正确配置代码      │
└──────────────────────────────────────────────────┘
```

## 2. MCP Server 项目结构

```text
.claude/mcp-servers/embedded-tools/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          ← 入口：MCP Server 主程序
│   ├── tools/
│   │   ├── register-lookup.ts  ← 寄存器查询工具
│   │   ├── firmware-parse.ts   ← 固件解析工具
│   │   └── datasheet-search.ts ← 数据手册搜索工具
│   └── data/
│       └── stm32f411_regs.db   ← STM32F411 寄存器数据库 (SQLite)
├── datasheets/            ← 本地数据手册目录
│   ├── stm32f411-datasheet.pdf
│   └── mpu6050-datasheet.pdf
└── README.md
```

## 3. 初始化 MCP Server

```typescript
// src/index.ts — MCP Server 主程序

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registerLookupTool } from "./tools/register-lookup.js";
import { firmwareParseTool } from "./tools/firmware-parse.js";
import { datasheetSearchTool } from "./tools/datasheet-search.js";

// ① 创建 MCP Server 实例
const server = new Server(
  {
    name: "embedded-tools",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},  // 声明支持 tools 能力
    },
  }
);

// ② 注册工具列表（Agent 第一次连接时调用）
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "register_lookup",
        description: `查询 STM32F411 芯片寄存器定义。
          返回: 寄存器地址、位域定义、复位值、访问权限。
          示例: register_lookup("RCC_CR") → RCC 时钟控制寄存器详情`,
        inputSchema: {
          type: "object",
          properties: {
            reg_name: {
              type: "string",
              description: "寄存器名称，如 RCC_CR、GPIOA_MODER、USART2_SR"
            }
          },
          required: ["reg_name"]
        }
      },
      {
        name: "firmware_parse",
        description: `解析 STM32 固件 .bin 文件。
          提取: 向量表、代码段/数据段/只读数据段大小、
          Flash 占用率、入口地址。
          示例: firmware_parse("firmware.bin")`,
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: ".bin 固件文件的路径"
            }
          },
          required: ["file_path"]
        }
      },
      {
        name: "datasheet_search",
        description: `在本地数据手册中搜索关键词。
          搜索范围: datasheets/ 目录下的 PDF 文件。
          返回: 匹配的段落摘录、页码、文件名。`,
        inputSchema: {
          type: "object",
          properties: {
            keyword: {
              type: "string",
              description: "搜索关键词，如 'I2C address'、'power management'"
            },
            chip: {
              type: "string",
              description: "芯片型号过滤，如 'STM32F411'、'MPU6050'（可选）"
            }
          },
          required: ["keyword"]
        }
      }
    ]
  };
});

// ③ 注册工具调用处理器
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "register_lookup":
      return await registerLookupTool(args);
    case "firmware_parse":
      return await firmwareParseTool(args);
    case "datasheet_search":
      return await datasheetSearchTool(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ④ 启动 MCP Server（通过 stdio 与 Harness 通信）
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Embedded Tools MCP Server running on stdio");
}

main().catch(console.error);
```

## 4. 工具一：寄存器查询（register_lookup）

```typescript
// src/tools/register-lookup.ts

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "../data/stm32f411_regs.db"));

interface RegisterField {
  name: string;
  bits: string;    // e.g. "31:16" or "0"
  description: string;
  access: "rw" | "r" | "w" | "rc_w1";
  resetValue: string;
}

interface RegisterInfo {
  name: string;
  address: string;  // e.g. "0x40023800"
  description: string;
  fields: RegisterField[];
}

// 寄存器数据库结构（SQLite）:
// CREATE TABLE registers (
//   name TEXT PRIMARY KEY,       -- RCC_CR
//   address TEXT NOT NULL,       -- 0x40023800
//   description TEXT,
//   fields TEXT NOT NULL         -- JSON array of RegisterField
// );

export async function registerLookupTool(args: { reg_name: string }) {
  const { reg_name } = args;

  // 模糊搜索（支持大小写不敏感）
  const stmt = db.prepare(
    `SELECT * FROM registers WHERE UPPER(name) LIKE UPPER(?)`
  );
  const row = stmt.get(`%${reg_name}%`);

  if (!row) {
    return {
      content: [{
        type: "text",
        text: `未找到寄存器 "${reg_name}"。\n` +
              `可用的寄存器前缀: RCC_, GPIOA_, USART2_, SPI1_, I2C1_, TIM2_, ...\n` +
              `请尝试使用完整寄存器名。`
      }],
      isError: true
    };
  }

  const reg = row as any;
  const fields: RegisterField[] = JSON.parse(reg.fields);

  // 生成 Markdown 表格
  let output = `## ${reg.name} — ${reg.description}\n\n`;
  output += `**地址**: \`${reg.address}\`\n\n`;
  output += `| 位域 | 位段 | 访问 | 复位值 | 描述 |\n`;
  output += `|------|------|------|--------|------|\n`;

  for (const field of fields) {
    output += `| ${field.name} | ${field.bits} | ${field.access} `;
    output += `| ${field.resetValue} | ${field.description} |\n`;
  }

  return {
    content: [{ type: "text", text: output }]
  };
}
```

### 数据库数据示例

```sql
-- STM32F411 寄存器数据（部分示例）
INSERT INTO registers VALUES (
  'RCC_CR',
  '0x40023800',
  'RCC 时钟控制寄存器',
  '[
    {"name":"PLLRDY","bits":"25","description":"PLL 就绪标志","access":"r","resetValue":"0"},
    {"name":"PLLON","bits":"24","description":"PLL 使能","access":"rw","resetValue":"0"},
    {"name":"CSSON","bits":"19","description":"时钟安全系统使能","access":"rw","resetValue":"0"},
    {"name":"HSEBYP","bits":"18","description":"外部高速时钟旁路","access":"rw","resetValue":"0"},
    {"name":"HSERDY","bits":"17","description":"HSE 就绪标志","access":"r","resetValue":"0"},
    {"name":"HSEON","bits":"16","description":"HSE 使能","access":"rw","resetValue":"0"},
    {"name":"HSIRDY","bits":"1","description":"HSI 就绪标志","access":"r","resetValue":"1"},
    {"name":"HSION","bits":"0","description":"HSI 使能","access":"rw","resetValue":"1"}
  ]'
);
```

## 5. 工具二：固件解析（firmware_parse）

```typescript
// src/tools/firmware-parse.ts

import fs from "fs";

interface FirmwareInfo {
  fileSize: number;
  stackPointer: number;
  resetHandler: number;
  segments: {
    text: { start: number; size: number };
    rodata: { start: number; size: number };
    data: { start: number; size: number };
    bss: { start: number; size: number };
  };
  flashUsage: number;
  flashUsagePercent: number;
  entryPoint: number;
}

export async function firmwareParseTool(args: { file_path: string }) {
  const { file_path } = args;

  // 读取二进制文件
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file_path);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `无法读取文件: ${err.message}` }],
      isError: true
    };
  }

  // ① 解析向量表（前 4 个 32-bit 值）
  // Word 0: 初始栈指针 (SP)
  // Word 1: Reset_Handler 地址
  // Word 2: NMI_Handler 地址
  // Word 3: HardFault_Handler 地址
  const sp = buffer.readUInt32LE(0);
  const resetHandler = buffer.readUInt32LE(4);
  const nmiHandler = buffer.readUInt32LE(8);
  const hardFaultHandler = buffer.readUInt32LE(12);

  // ② 解析 ELF 段信息（从 .bin 中无法直接获取，这里是固定映射）
  //    实际项目中可从 .map 文件或 .elf 文件读取段信息
  const flashBase = 0x08000000;
  const appBase = 0x0800C000;    // Bicycle_Watch 的应用起始地址

  const info: FirmwareInfo = {
    fileSize: buffer.length,
    stackPointer: sp,
    resetHandler: resetHandler,
    entryPoint: resetHandler,
    segments: {
      text: {
        start: appBase,
        size: Math.min(buffer.length, 0x20000)  // 估计代码段 ≤128KB
      },
      rodata: {
        start: appBase + 0x20000,
        size: Math.max(0, buffer.length - 0x20000)
      },
      data: { start: 0x20000000, size: 0 },
      bss: { start: 0x20000000, size: 0 }
    },
    flashUsage: buffer.length,
    flashUsagePercent: (buffer.length / (464 * 1024)) * 100  // MAX 464KB
  };

  // ③ 生成报告
  let output = `## 固件解析: ${path.basename(file_path)}\n\n`;
  output += `| 项目 | 值 |\n`;
  output += `|------|----|\n`;
  output += `| 文件大小 | ${(info.fileSize / 1024).toFixed(1)} KB `;
  output += `(${info.fileSize.toLocaleString()} 字节) |\n`;
  output += `| 初始 SP | \`0x${sp.toString(16).toUpperCase()}\` |\n`;
  output += `| Reset_Handler | \`0x${resetHandler.toString(16).toUpperCase()}\` |\n`;
  output += `| NMI_Handler | \`0x${nmiHandler.toString(16).toUpperCase()}\` |\n`;
  output += `| HardFault_Handler | \`0x${hardFaultHandler.toString(16).toUpperCase()}\` |\n`;
  output += `| Flash 占用 | ${info.flashUsagePercent.toFixed(1)}% `;
  output += `(可用 ${(464 * 1024).toLocaleString()} 字节) |\n`;

  // ④ 安全检查
  const warnings: string[] = [];
  if (sp < 0x20000000 || sp > 0x20020000) {
    warnings.push(`⚠️ 栈指针 0x${sp.toString(16)} 超出 SRAM 范围`);
  }
  if (resetHandler < 0x08000000 || resetHandler > 0x08080000) {
    warnings.push(`⚠️ Reset_Handler 0x${resetHandler.toString(16)} 不在 Flash 范围`);
  }
  if (info.flashUsagePercent > 90) {
    warnings.push(`⚠️ Flash 占用 ${info.flashUsagePercent.toFixed(1)}%，接近上限`);
  }

  if (warnings.length > 0) {
    output += `\n### 警告\n${warnings.join('\n')}\n`;
  }

  return {
    content: [{ type: "text", text: output }]
  };
}
```

## 6. 工具三：数据手册搜索（datasheet_search）

```typescript
// src/tools/datasheet-search.ts

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASHEET_DIR = path.join(__dirname, "../../datasheets");

export async function datasheetSearchTool(
  args: { keyword: string; chip?: string }
) {
  const { keyword, chip } = args;

  // 使用 pdftotext 提取 PDF 文本（需安装 poppler-utils）
  // Windows: 下载 xpdf 命令行工具
  // macOS: brew install poppler
  // Linux: apt install poppler-utils

  let results: { file: string; page: number; snippet: string }[] = [];
  const pdfFiles = fs.readdirSync(DATASHEET_DIR)
    .filter(f => f.endsWith('.pdf'))
    .filter(f => !chip || f.toLowerCase().includes(chip.toLowerCase()));

  for (const pdfFile of pdfFiles) {
    const pdfPath = path.join(DATASHEET_DIR, pdfFile);
    try {
      // 将 PDF 转为文本（-layout 保留表格格式）
      const text = execSync(
        `pdftotext -layout "${pdfPath}" -`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      // 按页分割
      const pages = text.split('\f');  // PDF 换页符
      for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i];

        // 大小写不敏感搜索
        if (pageText.toLowerCase().includes(keyword.toLowerCase())) {
          // 提取关键词周围的上下文（前后各 200 字符）
          const idx = pageText.toLowerCase().indexOf(keyword.toLowerCase());
          const start = Math.max(0, idx - 200);
          const end = Math.min(pageText.length, idx + keyword.length + 200);
          const snippet = pageText.substring(start, end)
            .replace(/\s+/g, ' ')
            .trim();

          results.push({
            file: pdfFile,
            page: i + 1,
            snippet: `...${snippet}...`
          });

          if (results.length >= 10) break;  // 最多返回 10 条
        }
      }
    } catch (err: any) {
      // PDF 解析失败 → 跳过该文件
      console.error(`Failed to parse ${pdfFile}: ${err.message}`);
    }
    if (results.length >= 10) break;
  }

  if (results.length === 0) {
    return {
      content: [{
        type: "text",
        text: `在 ${pdfFiles.length} 个数据手册中未找到 "${keyword}"。\n` +
              `可用的数据手册: ${pdfFiles.join(', ')}\n` +
              `提示: 尝试使用英文关键词。`
      }]
    };
  }

  let output = `## 数据手册搜索结果: "${keyword}"\n\n`;
  for (const r of results) {
    output += `### ${r.file} (第 ${r.page} 页)\n\n`;
    output += `\`\`\`\n${r.snippet}\n\`\`\`\n\n`;
  }

  return {
    content: [{ type: "text", text: output }]
  };
}
```

## 7. 注册 MCP Server 到 Harness

```jsonc
// .claude/mcp.json（或 settings.json 的 mcpServers 段）

{
  "mcpServers": {
    "embedded-tools": {
      "command": "node",
      "args": [
        "--loader", "ts-node/esm",
        ".claude/mcp-servers/embedded-tools/src/index.ts"
      ],
      "env": {
        "NODE_ENV": "production",
        "DATASHEET_DIR": ".claude/mcp-servers/embedded-tools/datasheets"
      }
    }
  }
}
```

## 8. 测试 MCP Server

```bash
# ① 先手动测试 MCP Server 是否正常启动
cd .claude/mcp-servers/embedded-tools
npm install
npm run build

# ② 使用 MCP Inspector 调试
npx @modelcontextprotocol/inspector node dist/index.js
# → 浏览器打开 http://localhost:5173
# → 可以手动调用工具、查看返回值

# ③ 在 Claude Code 中测试
# Agent 调用: register_lookup("RCC_CR")
# → 应该返回 RCC 时钟控制寄存器的完整定义

# ④ 检查 tools/list 是否正确返回
# echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```

## 9. MCP Server 开发检查清单

```text
□ package.json 正确声明了依赖 (@modelcontextprotocol/sdk)
□ Server name 和 version 已设置
□ capabilities.tools 已声明
□ 每个工具有完整的 name + description + inputSchema
□ inputSchema 的 required 字段正确
□ 工具处理函数返回格式符合 { content: [{ type: "text", text: "..." }] }
□ 错误情况返回 isError: true
□ Server 通过 stdio transport 启动（不是 HTTP）
□ mcp.json 中 command 和 args 正确
□ Server 进程不会自动退出（保持 stdio 连接）
```

## 10. 系列总结

本系列五篇实战文章覆盖了 Harness 框架的完整扩展开发：

| 文章 | 产出 | 文件位置 |
|------|------|---------|
| 自定义 Agent 类型 | 4 个专用 Agent | `.claude/agents/*.md` |
| 自定义 Skill | 3 个斜杠命令 | `.claude/skills/*.md` |
| Workflow 编排 | 代码审查流水线 | `.claude/workflows/*.js` |
| Hook 自动化管道 | 6 个自动化 Hook | `.claude/hooks/*.sh` + `settings.json` |
| MCP Server 开发 | 嵌入式工具 Server | `.claude/mcp-servers/embedded-tools/` |

> 至此，你已经有能力将 Harness 打造成一支真正为你工作的 AI 工程团队——有专业分工（Agent 类型）、有标准流程（Skills）、有编排系统（Workflows）、有自动化管道（Hooks）、还有可扩展的工具链（MCP Server）。
