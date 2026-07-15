---
title: eSSD 固件学习笔记：整体架构与核心模块
date: 2026-05-03
categories:
  - 技术笔记
  - 存储系统
  - eSSD
tags:
  - eSSD
  - SSD固件
  - FTL
  - NAND Flash
  - C语言
description: eSSD 固件整体架构学习：Host 接口、命令调度、FTL、NAND 管理、后台任务和异常恢复。
top_img: /img/embedded-lab-hero.png
---

eSSD 固件可以理解为运行在 SSD 控制器上的嵌入式系统。它一边响应 Host 的读写命令，一边管理 NAND Flash 的擦写寿命、坏块、映射表、GC 和掉电保护。

从软件角度看，eSSD 固件不是单一模块，而是一组实时协作的子系统。

## 整体数据路径

```text
Host
  |
  | NVMe / PCIe / SATA
  v
Host Interface
  |
  v
Command Scheduler
  |
  v
FTL
  |
  v
NAND Manager
  |
  v
NAND Flash
```

写命令大致流程：

1. Host 下发写命令
2. Host Interface 解析命令，准备 DMA
3. Scheduler 分配内部请求
4. FTL 把 LBA 转换为物理地址
5. NAND Manager 编程 page
6. 更新映射表和元数据
7. 返回完成状态给 Host

读命令流程类似，但核心是查映射表、读取 NAND、做 ECC 校验和数据返回。

## Host Interface

Host Interface 负责和主机协议打交道。不同产品可能是 NVMe、SATA 或私有接口。

这一层通常关注：

- 命令队列解析
- Doorbell 或中断处理
- PRP/SGL 或 DMA 地址解析
- Completion Queue 回写
- 超时和错误状态上报

固件内部最好不要让 FTL 直接依赖 Host 协议细节。Host 命令可以转换成统一内部请求。

```c
typedef enum {
    REQ_READ,
    REQ_WRITE,
    REQ_FLUSH,
    REQ_TRIM,
} req_type_t;

typedef struct {
    req_type_t type;
    uint64_t lba;
    uint32_t nlb;
    void *buf;
    uint16_t qid;
    uint16_t cid;
} io_req_t;
```

## Command Scheduler

Scheduler 负责内部请求排队和调度。

常见策略包括：

- 读优先：降低读延迟
- 写合并：提高顺序写效率
- 多 die/channel 并行：提升吞吐
- 后台任务限速：避免 GC 抢占前台 IO

```c
typedef struct {
    io_req_t *items[256];
    uint16_t head;
    uint16_t tail;
    uint16_t count;
} req_queue_t;
```

实际固件里通常会区分前台队列和后台队列，例如 Host IO、GC IO、Wear Leveling IO、元数据刷写 IO。

## FTL

FTL 是 SSD 固件的核心。它解决两个问题：

- Host 看到的是连续 LBA
- NAND 实际只能按 page 编程、按 block 擦除，并且有寿命限制

FTL 负责维护逻辑地址到物理地址的映射。

```c
typedef struct {
    uint16_t ch;
    uint16_t lun;
    uint16_t block;
    uint16_t page;
} ppa_t;

typedef struct {
    ppa_t *l2p_table;
    uint32_t entry_count;
} ftl_context_t;
```

当 Host 写同一个 LBA 时，FTL 通常不会原地覆盖，而是写到新的物理 page，然后把旧 page 标记为 invalid。

## NAND Manager

NAND Manager 负责把上层请求转换为 NAND 操作：

- read page
- program page
- erase block
- read status
- bad block mark
- retry / read reclaim

NAND 操作需要考虑并行性。典型维度包括 channel、CE、LUN、plane。

```c
typedef enum {
    NAND_READ,
    NAND_PROGRAM,
    NAND_ERASE,
} nand_op_t;

typedef struct {
    nand_op_t op;
    ppa_t ppa;
    void *data;
    void *meta;
} nand_req_t;
```

## 后台任务

SSD 固件里后台任务非常关键：

- GC：回收无效页较多的 block
- Wear Leveling：均衡擦写次数
- Bad Block Management：管理出厂坏块和运行时坏块
- Read Scrub：处理长期保存导致的数据可靠性下降
- Metadata Flush：把映射表、块状态等元数据持久化

这些任务不能无限抢占前台 IO，否则 Host 延迟会抖动。

## 掉电保护

掉电时最怕映射表和 NAND 数据状态不一致。

常见策略：

- 元数据日志化
- 定期 checkpoint
- 写入顺序保证
- capacitor 供电窗口内完成关键刷写
- 启动时 replay log 恢复状态

```c
typedef struct {
    uint32_t magic;
    uint32_t seq;
    uint64_t lba;
    ppa_t new_ppa;
    ppa_t old_ppa;
    uint32_t crc;
} map_journal_t;
```

## 学习路线

建议按下面顺序学习：

1. NAND Flash 基础：page、block、plane、坏块、ECC
2. FTL 基础：L2P、P2L、垃圾回收、写放大
3. Host 命令路径：NVMe/SATA 命令队列和 completion
4. 调度器：前台 IO 与后台任务协作
5. 异常恢复：掉电、坏块、读错误、元数据损坏

## 小结

eSSD 固件是一个强实时、高可靠、强状态管理的嵌入式系统。它的难点不只是读写 NAND，而是在 Host 性能、NAND 寿命、数据一致性和异常恢复之间做工程取舍。
