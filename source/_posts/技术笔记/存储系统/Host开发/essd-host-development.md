---
title: eSSD Host 开发学习笔记：命令队列、DMA 与性能测试
date: 2026-05-06
categories:
  - 技术笔记
  - 存储系统
  - Host开发
tags:
  - eSSD Host
  - NVMe
  - DMA
  - 性能测试
  - C语言
description: eSSD Host 侧开发入门：命令队列模型、提交/完成路径、DMA 缓冲区、性能测试和错误处理。
top_img: /img/embedded-lab-hero.png
---

学习 eSSD 不能只看固件侧。Host 侧开发同样重要，因为 SSD 的行为最终要通过 Host 命令、队列、DMA 和性能测试体现出来。

本文从 Host 侧视角理解 eSSD 交互模型。

## Host 侧关注什么

Host 开发通常关注：

- 如何构造读写命令
- 如何管理 submission/completion 队列
- 如何准备 DMA buffer
- 如何处理超时、错误码和重试
- 如何测试吞吐、延迟、IOPS
- 如何设计诊断命令和日志读取接口

如果是 NVMe 设备，核心概念是 SQ/CQ。如果是私有 PCIe 或仿真接口，也通常会抽象出类似队列。

## 队列模型

```text
Host Memory
  ├── Submission Queue
  ├── Completion Queue
  └── Data Buffer

Device
  ├── Fetch Command
  ├── DMA Read/Write Data
  └── Write Completion
```

Host 把命令写入 SQ，然后通知设备；设备处理完成后，把结果写入 CQ。

## 命令结构抽象

```c
typedef enum {
    HOST_CMD_READ = 0x01,
    HOST_CMD_WRITE = 0x02,
    HOST_CMD_FLUSH = 0x03,
    HOST_CMD_IDENTIFY = 0x04,
} host_cmd_opcode_t;

typedef struct {
    uint8_t opcode;
    uint16_t cid;
    uint64_t lba;
    uint32_t nlb;
    uint64_t data_addr;
    uint32_t data_len;
} host_cmd_t;
```

真实 NVMe 命令结构比这个复杂，但学习时可以先用这种简化模型理解数据流。

## Completion 结构

```c
typedef struct {
    uint16_t cid;
    uint16_t status;
    uint32_t result;
} host_cpl_t;
```

`cid` 用来匹配提交命令，`status` 表示执行结果。

## 环形队列

SQ/CQ 通常都是环形队列。

```c
#define QUEUE_DEPTH 256

typedef struct {
    host_cmd_t entry[QUEUE_DEPTH];
    uint16_t head;
    uint16_t tail;
} submission_queue_t;

static int SQ_IsFull(submission_queue_t *q)
{
    return ((q->tail + 1) % QUEUE_DEPTH) == q->head;
}

static int SQ_Push(submission_queue_t *q, const host_cmd_t *cmd)
{
    if (SQ_IsFull(q))
        return -1;

    q->entry[q->tail] = *cmd;
    q->tail = (q->tail + 1) % QUEUE_DEPTH;
    return 0;
}
```

队列深度直接影响并发能力。

## DMA Buffer

Host 下发读写命令前，需要准备数据缓冲区。实际驱动中要考虑：

- 物理地址或 IOVA
- 对齐要求
- cache 一致性
- scatter-gather
- DMA mapping/unmapping

简化模型可以这样表示：

```c
typedef struct {
    void *vaddr;
    uint64_t dma_addr;
    uint32_t size;
} dma_buffer_t;
```

写命令：Host buffer -> Device  
读命令：Device -> Host buffer

## 提交流程

```c
int Host_SubmitWrite(uint64_t lba, void *buf, uint32_t len)
{
    host_cmd_t cmd = {0};

    cmd.opcode = HOST_CMD_WRITE;
    cmd.cid = Alloc_CommandId();
    cmd.lba = lba;
    cmd.nlb = len / 4096;
    cmd.data_addr = Get_DmaAddr(buf);
    cmd.data_len = len;

    if (SQ_Push(&g_sq, &cmd) != 0)
        return -1;

    Ring_Doorbell();
    return cmd.cid;
}
```

## 完成处理

```c
void Host_PollCompletion(void)
{
    host_cpl_t cpl;

    while (CQ_Pop(&g_cq, &cpl) == 0) {
        if (cpl.status == 0)
            On_CommandDone(cpl.cid);
        else
            On_CommandError(cpl.cid, cpl.status);
    }
}
```

实际系统中可能使用中断，也可能使用 polling。高性能场景常用 polling 降低中断开销。

## 性能测试指标

常见指标：

- 顺序读写吞吐：MB/s
- 随机读写 IOPS
- 平均延迟
- P99/P999 延迟
- 队列深度 QD
- IO 大小：4K、16K、128K、1M

测试时要明确 workload，否则结果没有可比性。

```text
4K random read, QD=32
128K sequential write, QD=16
70% read / 30% write mixed workload
```

## 错误处理

Host 侧要处理：

- 命令超时
- 队列满
- DMA 映射失败
- 设备返回错误状态
- reset 后命令重放或失败上报

```c
typedef enum {
    HOST_OK = 0,
    HOST_ERR_TIMEOUT,
    HOST_ERR_QUEUE_FULL,
    HOST_ERR_DMA,
    HOST_ERR_DEVICE,
} host_status_t;
```

错误码一定要保留足够上下文：qid、cid、opcode、lba、nlb、耗时。

## Host 与固件联调

联调时建议固定一条命令路径，从最小闭环开始：

1. Identify 命令能返回基本信息
2. 单个 4K write 成功
3. 单个 4K read 读回一致
4. 顺序多块读写
5. 随机读写
6. 多队列并发
7. reset 和异常注入

## 小结

Host 开发的关键不是简单发命令，而是把队列、DMA、完成路径、超时和性能测试串成完整闭环。

对 eSSD 固件工程师来说，懂 Host 侧能更快定位问题：到底是 Host 命令构造错、DMA 地址错、队列状态错，还是固件内部 FTL/NAND 路径出了问题。
