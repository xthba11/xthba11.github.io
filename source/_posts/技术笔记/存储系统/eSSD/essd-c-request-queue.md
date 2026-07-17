---
title: eSSD 固件 C 语言实践：请求队列与状态机设计
date: 2026-05-07
categories:
  - 技术笔记
  - 存储系统
  - eSSD
  - C语言实践
tags:
  - eSSD
  - C语言
  - 请求队列
  - 状态机
  - 固件架构
description: 用 C 语言实现 eSSD 固件中常见的请求队列和状态机框架，理解 Host IO、FTL 和 NAND 请求如何流转。
cover: /img/covers/articles/essd-c-request-queue.svg
top_img: /img/covers/articles/essd-c-request-queue.svg
---

eSSD 固件里充满队列和状态机。Host 命令进来后，通常会被拆成内部请求，再进入 FTL、NAND、DMA 等多个阶段。

这篇文章用 C 语言实现一个简化请求队列和状态机框架。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS，用 PC 程序模拟固件请求队列。
- 目标板/芯片：无真实 eSSD 控制器，当前阶段用 C 语言模型验证队列、状态机和错误路径。
- 内核/SDK/编译器版本：GCC 11/12，C11 标准；后续可迁移到 RTOS 或裸机固件环境。
- 使用工具：`gcc`、`make`、`gdb`、`valgrind`、`perf`、`gcov`。
- 关联项目：存储系统学习实验，用来理解 Host IO、FTL、NAND 请求、GC 请求之间的流转关系。

编译建议打开告警和运行时检查：

```bash
# 编译：开启所有告警，告警视为错误，关闭优化，包含调试符号
gcc -Wall -Wextra -Werror -O0 -g request_queue.c -o request_queue
# 运行时内存检查：检测内存泄漏和非法访问
valgrind --leak-check=full ./request_queue
```

## 问题背景

学习 eSSD 固件时，很容易只看 FTL 映射、垃圾回收、磨损均衡这些概念，但真实固件首先要解决的是“请求怎么流动”。Host 下发一个读写命令后，固件通常不会在一个函数里同步完成所有事情，而是拆成多个阶段：

```text
Host Command
  -> Host Request
  -> FTL Lookup / Allocate
  -> NAND Read/Program/Erase
  -> ECC / DMA Complete
  -> Host Complete
```

如果没有统一请求对象和状态机，后面加超时、重试、优先级、GC 抢占时会非常混乱。所以本文先做一个纯 C 版本的小模型，不依赖真实 NAND，也不依赖操作系统。

## 验证方法

我会用“请求数量守恒”验证这个模型：请求从 free list 分配出来，经过 ready/ftl/nand/complete/error，最后必须回到 free list，不能丢，也不能重复释放。

建议准备一个测试入口：

```c
int main(void)
{
    // 初始化请求池：构建 free list
    ReqPool_Init();

    // 批量分配 1000 个请求，模拟 Host 下发 IO 命令
    for (int i = 0; i < 1000; i++) {
        io_request_t *req = Req_Alloc();
        if (!req) {
            printf("alloc failed at %d\n", i);  // 请求池耗尽
            break;
        }

        req->type = (i % 2) ? IO_READ : IO_WRITE;  // 交替读写
        req->lba = 4096 + i * 8;                    // 模拟 LBA 范围
        req->nlb = 8;                                // 每次 8 个逻辑块
        ReqQueue_Push(&g_ready_queue, req);          // 放入就绪队列等待调度
    }

    // 主调度循环：处理就绪队列直到为空
    while (g_ready_queue.count > 0) {
        Scheduler_RunOnce();
    }

    ReqPool_DumpStats();  // 打印统计：验证 free 数 + active 数 = 池大小
    return 0;
}
```

期望日志：

```text
[REQ] alloc id=0 state=READY lba=4096 nlb=8
[REQ] id=0 READY -> FTL
[REQ] id=0 FTL -> NAND
[REQ] id=0 NAND -> COMPLETE
[REQ] free id=0
[REQ] pool free=256 active=0 lost=0
```

再做三个异常测试：

- 把请求池大小改小，例如 `REQ_POOL_SIZE=4`，确认分配失败时不会崩溃。
- 模拟 NAND 返回错误，确认请求进入 `REQ_ERROR` 后仍然会回收。
- 随机插入读写请求，确认队列 `count` 不会变成负数或超过池大小。

## 复盘

这个实验里最值得盯的是边界条件。

- `Req_Alloc()` 里 `memset()` 后要重新设置 `id`，否则 trace 里的请求号可能被清零。本文示例为了简化代码，实际实现时建议保存 id 后再清结构体。
- 请求进入 `REQ_COMPLETE` 后必须只释放一次，重复释放会破坏 free list。
- 错误路径和正常路径一样重要，任何请求都必须最终完成或释放。
- 队列操作要保证 `head/tail/count` 同步更新，尤其是最后一个节点出队时要把 `tail` 清空。
- 真实固件里 FTL/NAND 多半异步完成，状态机不能假设一次函数调用就完成所有阶段。

后续如果继续扩展，我会给这个模型加上超时轮询、读写优先级、GC 后台队列和请求 trace ring buffer。这样它就不只是一个链表练习，而是能映射到真实 eSSD 固件调度骨架。

## 请求生命周期

```text
FREE
  -> READY
  -> FTL
  -> NAND
  -> COMPLETE
  -> FREE
```

如果发生错误，可能进入 `ERROR`，再由上层决定重试或失败返回。

```c
typedef enum {
    REQ_FREE = 0,   // 空闲状态：请求在 free list 中，可被分配
    REQ_READY,      // 就绪状态：请求已分配，等待调度器处理
    REQ_FTL,        // FTL 处理中：正在进行 L2P 地址转换或页分配
    REQ_NAND,       // NAND 操作中：正在执行 NAND 读写擦操作
    REQ_COMPLETE,   // 完成状态：请求处理完毕，等待释放回 free list
    REQ_ERROR,      // 错误状态：处理过程中发生错误，需释放或重试
} req_state_t;
```

## 请求对象

```c
typedef enum {
    IO_READ,   // 读 IO
    IO_WRITE,  // 写 IO
    IO_FLUSH,  // 刷写 IO：确保缓存数据落盘
    IO_TRIM,   // 裁剪 IO：释放不再使用的 LBA 范围
} io_type_t;

typedef struct io_request {
    uint16_t id;              // 请求唯一 ID，用于 trace 和调试
    io_type_t type;           // IO 类型（读/写/刷写/裁剪）
    req_state_t state;        // 请求当前状态（驱动状态机流转）
    uint64_t lba;             // 起始逻辑块地址
    uint32_t nlb;             // 逻辑块数量
    void *buf;                // 数据缓冲区指针
    int status;               // 错误码（0 成功，负值表示错误类型）
    struct io_request *next;  // 链表指针：挂载到队列或 free list
} io_request_t;
```

这里使用链表指针，是为了方便挂到不同队列。

## 请求池

固件里一般不喜欢频繁 `malloc/free`，更常用固定请求池。

```c
#define REQ_POOL_SIZE 256       // 请求池容量：固定 256 个请求对象

static io_request_t g_req_pool[REQ_POOL_SIZE];  // 静态请求数组，避免动态内存分配
static io_request_t *g_free_list;               // 空闲链表头指针（单链表）

void ReqPool_Init(void)
{
    g_free_list = NULL;

    // 遍历请求池数组，将所有请求对象串成单链表
    // 采用头插法：新节点插入链表头部，构建空闲链表
    for (int i = 0; i < REQ_POOL_SIZE; i++) {
        g_req_pool[i].id = i;                    // 分配唯一 ID（等于数组索引）
        g_req_pool[i].state = REQ_FREE;          // 初始状态：空闲
        g_req_pool[i].next = g_free_list;        // 将当前节点指向原链表头
        g_free_list = &g_req_pool[i];            // 更新链表头为当前节点
    }
}
```

## 分配和释放

```c
io_request_t *Req_Alloc(void)
{
    io_request_t *req;

    // 边界条件：free list 为空，请求池耗尽，返回 NULL
    if (g_free_list == NULL)
        return NULL;

    // 从 free list 头部取出一个请求对象
    req = g_free_list;
    g_free_list = req->next;

    // 清零请求结构体（注意：id 被清零后需重新设置）
    memset(req, 0, sizeof(*req));
    req->state = REQ_READY;  // 初始状态设为"就绪"，等待调度
    return req;
}

void Req_Free(io_request_t *req)
{
    // 将请求归还到 free list 头部
    req->state = REQ_FREE;           // 状态恢复为空闲
    req->next = g_free_list;         // 将当前节点链接到原链表头
    g_free_list = req;               // 更新链表头指针
}
```

真实系统要注意并发访问，可能需要关中断、spinlock 或 RTOS mutex。

## 队列结构

```c
typedef struct {
    io_request_t *head;   // 队列头指针：指向第一个请求（出队位置）
    io_request_t *tail;   // 队列尾指针：指向最后一个请求（入队位置）
    uint16_t count;       // 队列中请求数量：用于调试和流量控制
} req_queue_t;
```

入队：

```c
void ReqQueue_Push(req_queue_t *q, io_request_t *req)
{
    req->next = NULL;  // 新节点作为队尾，next 置空

    // 边界条件：队列是否为空
    if (q->tail)
        q->tail->next = req;  // 队列非空：链接到当前队尾后面
    else
        q->head = req;        // 队列为空：同时设置 head 指针

    q->tail = req;   // 更新队尾指针
    q->count++;      // 计数加一
}
```

出队：

```c
io_request_t *ReqQueue_Pop(req_queue_t *q)
{
    io_request_t *req = q->head;

    // 边界条件：队列为空，返回 NULL
    if (!req)
        return NULL;

    // 移动 head 指针到下一个节点
    q->head = req->next;

    // 边界条件：出队后队列为空，必须将 tail 也置空
    // 否则 Push 时会误认为队列非空，导致链表损坏
    if (!q->head)
        q->tail = NULL;

    req->next = NULL;   // 断开已出队节点的链表链接
    q->count--;         // 计数减一
    return req;
}
```

## 状态机处理

```c
static void Req_Process(io_request_t *req)
{
    // 状态机：根据请求当前状态，执行对应阶段操作并转换到下一状态
    switch (req->state) {
    case REQ_READY:
        // 就绪 -> FTL：提交给 FTL 模块做地址转换和页分配
        req->state = REQ_FTL;
        FTL_Submit(req);
        break;

    case REQ_FTL:
        // FTL -> NAND：FTL 处理完毕，提交给 NAND 模块执行物理操作
        req->state = REQ_NAND;
        NAND_Submit(req);
        break;

    case REQ_NAND:
        // NAND -> 完成：NAND 操作完成，通知 Host （写 cq entry）
        req->state = REQ_COMPLETE;
        Host_Complete(req);
        break;

    case REQ_COMPLETE:
        // 完成 -> 释放：请求处理完毕，归还到 free list
        Req_Free(req);
        break;

    case REQ_ERROR:
        // 错误处理：先通知 Host 错误信息，再释放请求
        Host_CompleteError(req);
        Req_Free(req);
        break;

    default:
        // 未知状态：标记为错误状态
        req->state = REQ_ERROR;
        break;
    }
}
```

这个模型很简化。真实固件里 FTL 和 NAND 往往是异步完成，通过 callback 或 completion event 推动状态机继续走。

## 调度循环

```c
void Scheduler_RunOnce(void)
{
    io_request_t *req;

    // 1. 从就绪队列取出一个请求进行处理
    req = ReqQueue_Pop(&g_ready_queue);
    if (!req)
        return;  // 队列为空，无事可做

    // 2. 调用状态机处理请求（推进一个状态转换）
    Req_Process(req);

    // 3. 处理完后如果请求未释放（还未到 COMPLETE/ERROR 状态），
    //    重新放回就绪队列，等待下次调度继续推进状态
    if (req->state != REQ_FREE)
        ReqQueue_Push(&g_ready_queue, req);
}
```

如果需要区分读写优先级，可以准备多个队列：

```c
static req_queue_t g_read_queue;   // 读请求队列（优先级最高）
static req_queue_t g_write_queue;  // 写请求队列（正常优先级）
static req_queue_t g_gc_queue;     // GC 请求队列（后台队列，需限速避免抢占前台 IO）
```

调度时优先处理读队列，后台 GC 队列限速处理。

## 错误处理

请求对象里要保留错误信息：

```c
typedef enum {
    REQ_OK = 0,              // 成功
    REQ_ERR_TIMEOUT = -1,     // 超时错误：命令在规定时间内未完成
    REQ_ERR_NO_SPACE = -2,    // 空间不足：无空闲页或空闲块可分配
    REQ_ERR_NAND_FAIL = -3,   // NAND 操作失败：编程/擦除/读取失败
    REQ_ERR_ECC = -4,         // ECC 不可纠正错误：数据已损坏
} req_status_t;
```

当 NAND 返回错误时：

```c
void Req_SetError(io_request_t *req, int status)
{
    // 记录错误码并切换状态机到错误状态
    // 注意：状态切换后请求仍会在调度循环中被处理（进入 REQ_ERROR case），
    // 最终一定会走到 Req_Free，不会丢失
    req->status = status;
    req->state = REQ_ERROR;
}
```

错误处理要避免“请求丢失”。每个请求最终都必须完成或释放。

## 调试建议

建议给请求加 trace：

```c
// 请求追踪宏：在状态切换时打印关键信息，方便联调定位
// 输出格式：[req:id state:当前状态 lba:起始地址] 自定义消息
#define REQ_TRACE(req, fmt, ...) \
    Log_Debug("[req:%u state:%d lba:%llu] " fmt, \
              (req)->id, (req)->state, (unsigned long long)(req)->lba, \
              ##__VA_ARGS__)
```

关键状态切换都打 trace，联调 Host IO 超时时会非常有用。

## 小结

请求队列和状态机是 eSSD 固件的骨架。FTL、NAND、Host、GC 都可以看成不同类型的请求在队列之间流转。

把请求生命周期设计清楚，后续再加并行、优先级、超时、重试和异常恢复，系统才不会越写越乱。
