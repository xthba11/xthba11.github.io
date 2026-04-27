# 个人技术博客网站规格文档

## 1. 项目概述

### 项目名称
`code-notes` — 嵌入式工程师技术博客

### 项目定位
个人技术分享网站，用于记录嵌入式 MCU 开发、Linux 内核/驱动编程、C 语言网络编程的学习笔记，同时展示个人开源项目。

### 目标用户
- 博主本人（内容创作者）
- 同领域开发者（嵌入式 / Linux / 网络编程）
- 求职者（展示技术实力）

### 核心价值
- 知识沉淀：系统化整理嵌入式开发经验
- 技术分享：帮助他人，少走弯路
- 个人品牌：建立技术影响力

---

## 2. 技术方案

### 框架选型

| 类别 | 选择 | 说明 |
|------|------|------|
| 静态博客框架 | **Hexo 7.x** | Node.js 构建，成熟稳定 |
| 主题 | **Butterfly 4.x** | 美观、插件丰富、社区活跃 |
| 评论系统 | **Giscus** | GitHub Discussions 驱动，免费无需登录 |
| 访问量统计 | **不蒜子** | 轻量级，配置简单 |
| 搜索 | **Local Search** | Hexo 插件，无需第三方服务 |

### 部署方案

| 平台 | 方式 | 自动化 |
|------|------|--------|
| GitHub Pages | `main` 分支 | GitHub Actions 自动部署 |

### 依赖环境

- **Node.js** >= 18.0.0
- **Git**
- **GitHub 账号**

---

## 3. 功能规划

### 3.1 内容管理

| 功能 | 状态 | 说明 |
|------|------|------|
| 写文章（Markdown） | 必须 | 支持 Markdown + Front-matter |
| 分类（Categories） | 必须 | 按技术领域分：嵌入式 / Linux / 网络编程 |
| 标签（Tags） | 必须 | 按具体技术点打标签 |
| 目录（Table of Contents） | 必须 | 文章自动生成侧边栏目录 |
| 搜索（Local Search） | 必须 | 本地全文搜索 |
| 锚点定位 | 必须 | 文章内标题自动生成锚点 |
| 代码高亮 | 必须 | 支持 C 语言语法高亮 |

### 3.2 主题功能

| 功能 | 状态 | 说明 |
|------|------|------|
| 暗色模式 | 必须 | 自动跟随系统 + 手动切换 |
| 响应式布局 | 必须 | 适配手机 / 平板 / 桌面 |
| 主页 Banner | 必须 | 显示博主介绍 |
| 友链页面 | 必须 | 链接其他技术博主 |
| 404 页面 | 必须 | 自定义 404 页面 |
| 鼠标点击特效 | 可选 | 暂时禁用，保持专业感 |
| 滚动条美化 | 可选 | 保持默认 |

### 3.3 SEO 与可发现性

| 功能 | 状态 | 说明 |
|------|------|------|
| Sitemap | 必须 | 生成站点地图 |
| robots.txt | 必须 | 允许搜索引擎爬取 |
| Open Graph | 必须 | 分享到社交平台时显示预览 |
| 永久链接 | 必须 | 语义化 URL 结构 |

### 3.4 访客互动

| 功能 | 状态 | 说明 |
|------|------|------|
| 评论系统 | 必须 | Giscus（GitHub Discussions） |
| 访问量统计 | 必须 | 文章阅读量 |
| 访客总数统计 | 可选 | 站点总访问量 |

---

## 4. 内容结构

### 4.1 分类体系

```
技术笔记
├── 嵌入式
│   ├── MCU开发      (STM32 / 瑞芯微 / FreeRTOS)
│   ├── 通信协议    (UART / I2C / SPI / CAN)
│   └── 外设驱动    (GPIO / PWM / ADC / DMA)
├── Linux
│   ├── 内核模块    (字符设备 / 块设备 / 网络设备)
│   ├── 驱动开发    (I2C/SPI/GPIO子系统)
│   └── 系统工具    (Makefile / GDB / Perf)
└── 网络编程
    ├── 协议栈      (TCP / UDP / IP)
    ├── Socket编程  (阻塞 / 非阻塞 / epoll)
    └── 应用层      (HTTP / MQTT / CoAP)

项目展示
├── myTCP           (C语言实现的轻量级TCP协议栈)
├── led-driver      (Linux GPIO驱动)
└── rtos-demo       (FreeRTOS学习示例)
```

### 4.2 文章 Front-matter 示例

```yaml
---
title: Linux内核模块从入门到实战
date: 2026-04-20
categories:
  - 技术笔记
  - Linux
  - 内核模块
tags:
  - Linux Kernel
  - Makefile
  - 字符设备驱动
description: 详细介绍Linux内核模块的编写、编译、加载过程，以及如何编写一个简单的字符设备驱动。
top_img: /img/linux-kernel.jpg
---
```

### 4.3 预计初始文章

| 标题 | 分类 | 优先级 |
|------|------|--------|
| Ubuntu 22.04 开发环境搭建 | Linux | P0 |
| VSCode + Remote-SSH 远程开发配置 | Linux | P0 |
| C语言网络编程：Socket从入门到精通 | 网络编程 | P0 |
| Linux内核模块编程入门 | Linux / 内核模块 | P1 |
| 一文搞懂CRC校验原理与实现 | 嵌入式 / 通信协议 | P1 |
| I2C子系统详解：从驱动到设备 | Linux / 驱动开发 | P1 |

---

## 5. 视觉规范

### 5.1 配色方案

**主题**：Butterfly 内置 `Maccy` 配色（淡雅、适合技术文档）

| 元素 | 颜色 |
|------|------|
| 主色 | `#49b1f5`（科技蓝） |
| 强调色 | `#ff7242`（活力橙） |
| 背景色 | `#ffffff`（亮色） / `#1a1a1a`（暗色） |
| 文字色 | `#4a4a4a`（亮色） / `#c9d1d9`（暗色） |
| 代码背景 | `#f6f8fa`（亮色） / `#2d2d2d`（暗色） |

### 5.2 字体规范

| 元素 | 字体 |
|------|------|
| 中文字体 | "PingFang SC", "Microsoft YaHei", sans-serif |
| 英文/代码 | "JetBrains Mono", "Fira Code", monospace |
| 标题字体 | 字重 600-700 |

### 5.3 布局规范

| 区块 | 尺寸 |
|------|------|
| 主内容区 | 最大宽度 900px |
| 侧边栏 | 固定宽度 260px（桌面端） |
| 文章卡片间距 | 24px |
| 移动端断点 | 768px |

### 5.4 动效规范

| 动效 | 参数 |
|------|------|
| 页面切换 | 无（保持静态，利于 SEO） |
| 滚动动画 | 关闭（避免干扰阅读） |
| 导航栏 | 滚动时背景模糊 + 阴影 |

---

## 6. 站点配置

### 6.1 基础信息

```yaml
title: 嵌入式技术栈
subtitle: '记录嵌入式的点点滴滴'
description: 'C语言 | Linux内核 | MCU开发 | 网络编程'
author: 你的名字
language: zh-CN
timezone: Asia/Shanghai
```

### 6.2 导航菜单

```
首页        /
笔记        /categories/
项目        /projects/
友链        /link/
关于        /about/
```

### 6.3 社交链接

- GitHub: https://github.com/xthba11
- Email: 112301306@fzu.edu.cn

---

## 7. 部署流程

### 7.1 GitHub Actions 自动部署

推送到 `main` 分支后自动：
1. 切换到 `main` 分支
2. 执行 `hexo generate`
3. 将 `public/` 目录部署到 GitHub Pages

### 7.2 部署状态

```
main 分支 (源码)
  │
  ▼  push
GitHub Actions (hexo generate + deploy)
  │
  ▼
gh-pages 分支 (静态文件) → GitHub Pages 服务
```

### 7.3 访问地址

- 网站：`https://xthba11.github.io`
- 仓库：`https://github.com/xthba11/xthba11.github.io`

---

## 8. 项目里程碑

| 阶段 | 任务 | 交付物 |
|------|------|--------|
| P0 | 初始化项目 + 基础配置 | 可访问的空白博客 |
| P0 | 配置 Butterfly 主题 + 暗色模式 | 完整主题风格 |
| P0 | 部署到 GitHub Pages | 公开可访问的网站 |
| P1 | 评论系统 + 搜索功能 | 访客互动能力 |
| P1 | 撰写 3-5 篇初始文章 | 真实内容填充 |
| P2 | SEO 优化 + Sitemap | 搜索引擎收录 |
| P2 | 友链页面 + 关于页面 | 完整站点功能 |

---

## 9. 后续维护

### 内容更新频率
- 目标：每月 1-2 篇新文章
- 触发：学新技术 / 做项目 / 踩坑记录

### 主题更新
- 关注 Butterfly GitHub 仓库
- 半年评估一次是否升级主题

### 安全更新
- 依赖包：`npm audit fix` 定期检查
- Hexo 版本：每年评估升级

---

## 10. 参考资源

- [Hexo 官方文档](https://hexo.io/zh-cn/docs/)
- [Butterfly 主题文档](https://butterfly.js.org/posts/21cfbf15/)
- [GitHub Pages 官方文档](https://docs.github.com/cn/pages)
- [Giscus 官网](https://giscus.app/zh-CN)
