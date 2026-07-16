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
    HOST_CMD_READ     = 0x01,  // 读命令
    HOST_CMD_WRITE    = 0x02,  // 写命令
    HOST_CMD_FLUSH    = 0x03,  // 刷写命令：确保写缓存落盘
    HOST_CMD_IDENTIFY = 0x04,  // 识别命令：获取设备基本信息
} host_cmd_opcode_t;

typedef struct {
    uint8_t  opcode;      // 命令操作码：对应 host_cmd_opcode_t
    uint16_t cid;         // 命令 ID：用于匹配 completion entry
    uint64_t lba;         // 起始逻辑块地址
    uint32_t nlb;         // 逻辑块数量（通常 1 block = 512B 或 4KB）
    uint64_t data_addr;   // 数据缓冲区物理地址（DMA 使用的 IOVA 或物理地址）
    uint32_t data_len;    // 数据长度（字节）
} host_cmd_t;
```

真实 NVMe 命令结构比这个复杂，但学习时可以先用这种简化模型理解数据流。

## Completion 结构

```c
typedef struct {
    uint16_t cid;      // 命令 ID：与提交命令的 cid 匹配
    uint16_t status;   // 完成状态：0 表示成功，非 0 表示错误码
    uint32_t result;   // 命令特定结果（如 Identify 返回的数据长度）
} host_cpl_t;
```

`cid` 用来匹配提交命令，`status` 表示执行结果。

## 环形队列

SQ/CQ 通常都是环形队列。

```c
#define QUEUE_DEPTH 256   // 队列深度：最多 256 个未完成的命令

typedef struct {
    host_cmd_t entry[QUEUE_DEPTH];  // 环形缓冲区：存放命令条目
    uint16_t head;                   // 头指针：设备取命令的位置（由设备更新）
    uint16_t tail;                   // 尾指针：Host 写入新命令的位置（由 Host 更新）
} submission_queue_t;

static int SQ_IsFull(submission_queue_t *q)
{
    // 环形队列满判断：tail + 1 == head（保留一个空位区分满/空）
    return ((q->tail + 1) % QUEUE_DEPTH) == q->head;
}

static int SQ_Push(submission_queue_t *q, const host_cmd_t *cmd)
{
    // 入队前先检查队列是否已满
    if (SQ_IsFull(q))
        return -1;  // 队列已满，无法提交命令

    q->entry[q->tail] = *cmd;                       // 将命令拷贝到 tail 位置
    q->tail = (q->tail + 1) % QUEUE_DEPTH;          // 尾指针循环递增
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
    void *vaddr;          // 虚拟地址：Host 侧程序读写缓冲区时使用
    uint64_t dma_addr;    // DMA 地址（IOVA 或物理地址）：设备 DMA 传输时使用
    uint32_t size;        // 缓冲区大小（字节）
} dma_buffer_t;
```

写命令：Host buffer -> Device  
读命令：Device -> Host buffer

## 提交流程

```c
int Host_SubmitWrite(uint64_t lba, void *buf, uint32_t len)
{
    host_cmd_t cmd = {0};  // 初始化命令结构体（全零）

    // 1. 填充命令字段
    cmd.opcode = HOST_CMD_WRITE;        // 操作码：写命令
    cmd.cid = Alloc_CommandId();         // 分配唯一命令 ID
    cmd.lba = lba;                       // 起始逻辑块地址
    cmd.nlb = len / 4096;                // 逻辑块数量（假设 4KB block size）
    cmd.data_addr = Get_DmaAddr(buf);    // 获取 DMA 物理地址
    cmd.data_len = len;                  // 数据长度

    // 2. 将命令写入提交队列 (SQ)
    if (SQ_Push(&g_sq, &cmd) != 0)
        return -1;  // 队列已满，提交失败

    // 3. 写 Doorbell 寄存器通知设备有新命令
    Ring_Doorbell();
    return cmd.cid;  // 返回命令 ID，供 completion 匹配
}
```

## 完成处理

```c
void Host_PollCompletion(void)
{
    host_cpl_t cpl;

    // 轮询完成队列 (CQ)，循环处理所有已完成的命令
    while (CQ_Pop(&g_cq, &cpl) == 0) {
        if (cpl.status == 0)
            On_CommandDone(cpl.cid);              // 命令成功：通知上层
        else
            On_CommandError(cpl.cid, cpl.status); // 命令失败：处理错误码
    }
    // 高性能场景常用 polling 而非中断，以减少上下文切换开销
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
    HOST_OK = 0,              // 成功
    HOST_ERR_TIMEOUT,         // 超时错误：命令在规定时间内未完成
    HOST_ERR_QUEUE_FULL,      // 队列已满：SQ 无可用的提交槽位
    HOST_ERR_DMA,             // DMA 错误：映射失败或传输异常
    HOST_ERR_DEVICE,          // 设备错误：设备返回非零状态码
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
