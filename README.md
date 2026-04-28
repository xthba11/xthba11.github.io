# 嵌入式技术栈

基于 Hexo + Butterfly 主题构建的个人技术博客，记录嵌入式开发、Linux 内核编程、C 语言网络编程的学习笔记。

## 技术栈

- **框架**: Hexo 7.x
- **主题**: Butterfly 4.x
- **评论**: Giscus (GitHub Discussions)
- **部署**: GitHub Pages

## 快速开始

### 本地预览

```bash
# 安装依赖
npm install

# 本地预览
hexo server
```

### 写文章

```bash
# 创建新文章
hexo new "文章标题"

# 或直接在 source/_posts/ 目录下创建 .md 文件
```

### 部署

```bash
# 推送到 master 分支，GitHub Actions 自动部署
git add .
git commit -m "Update content"
git push
```

## 文章结构

```
source/_posts/
├── 技术笔记/
│   ├── Linux/
│   │   └── 网络编程/      # 网络编程专题
│   │       ├── linux-network-core-data-structures.md
│   │       ├── linux-network-common-algorithms.md
│   │       ├── linux-network-common-pitfalls.md
│   │       └── wireshark-network-debugging.md
│   └── 嵌入式/
└── 项目/
```

## 写作规范

```markdown
---
title: 文章标题
date: 2026-04-28
categories:
  - 技术笔记
  - Linux
  - 网络编程
tags:
  - Linux
  - 网络编程
description: 文章描述
---

# 正文
```

## 许可证

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
