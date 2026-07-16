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
top_img: /img/embedded-lab-hero.png
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
gcc -Wall -Wextra -Werror -O0 -g request_queue.c -o request_queue
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
    ReqPool_Init();

    for (int i = 0; i < 1000; i++) {
        io_request_t *req = Req_Alloc();
        if (!req) {
            printf("alloc failed at %d\n", i);
            break;
        }

        req->type = (i % 2) ? IO_READ : IO_WRITE;
        req->lba = 4096 + i * 8;
        req->nlb = 8;
        ReqQueue_Push(&g_ready_queue, req);
    }

    while (g_ready_queue.count > 0) {
        Scheduler_RunOnce();
    }

    ReqPool_DumpStats();
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
    REQ_FREE = 0,
    REQ_READY,
    REQ_FTL,
    REQ_NAND,
    REQ_COMPLETE,
    REQ_ERROR,
} req_state_t;
```

## 请求对象

```c
typedef enum {
    IO_READ,
    IO_WRITE,
    IO_FLUSH,
    IO_TRIM,
} io_type_t;

typedef struct io_request {
    uint16_t id;
    io_type_t type;
    req_state_t state;
    uint64_t lba;
    uint32_t nlb;
    void *buf;
    int status;
    struct io_request *next;
} io_request_t;
```

这里使用链表指针，是为了方便挂到不同队列。

## 请求池

固件里一般不喜欢频繁 `malloc/free`，更常用固定请求池。

```c
#define REQ_POOL_SIZE 256

static io_request_t g_req_pool[REQ_POOL_SIZE];
static io_request_t *g_free_list;

void ReqPool_Init(void)
{
    g_free_list = NULL;

    for (int i = 0; i < REQ_POOL_SIZE; i++) {
        g_req_pool[i].id = i;
        g_req_pool[i].state = REQ_FREE;
        g_req_pool[i].next = g_free_list;
        g_free_list = &g_req_pool[i];
    }
}
```

## 分配和释放

```c
io_request_t *Req_Alloc(void)
{
    io_request_t *req;

    if (g_free_list == NULL)
        return NULL;

    req = g_free_list;
    g_free_list = req->next;

    memset(req, 0, sizeof(*req));
    req->state = REQ_READY;
    return req;
}

void Req_Free(io_request_t *req)
{
    req->state = REQ_FREE;
    req->next = g_free_list;
    g_free_list = req;
}
```

真实系统要注意并发访问，可能需要关中断、spinlock 或 RTOS mutex。

## 队列结构

```c
typedef struct {
    io_request_t *head;
    io_request_t *tail;
    uint16_t count;
} req_queue_t;
```

入队：

```c
void ReqQueue_Push(req_queue_t *q, io_request_t *req)
{
    req->next = NULL;

    if (q->tail)
        q->tail->next = req;
    else
        q->head = req;

    q->tail = req;
    q->count++;
}
```

出队：

```c
io_request_t *ReqQueue_Pop(req_queue_t *q)
{
    io_request_t *req = q->head;

    if (!req)
        return NULL;

    q->head = req->next;
    if (!q->head)
        q->tail = NULL;

    req->next = NULL;
    q->count--;
    return req;
}
```

## 状态机处理

```c
static void Req_Process(io_request_t *req)
{
    switch (req->state) {
    case REQ_READY:
        req->state = REQ_FTL;
        FTL_Submit(req);
        break;

    case REQ_FTL:
        req->state = REQ_NAND;
        NAND_Submit(req);
        break;

    case REQ_NAND:
        req->state = REQ_COMPLETE;
        Host_Complete(req);
        break;

    case REQ_COMPLETE:
        Req_Free(req);
        break;

    case REQ_ERROR:
        Host_CompleteError(req);
        Req_Free(req);
        break;

    default:
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

    req = ReqQueue_Pop(&g_ready_queue);
    if (!req)
        return;

    Req_Process(req);

    if (req->state != REQ_FREE)
        ReqQueue_Push(&g_ready_queue, req);
}
```

如果需要区分读写优先级，可以准备多个队列：

```c
static req_queue_t g_read_queue;
static req_queue_t g_write_queue;
static req_queue_t g_gc_queue;
```

调度时优先处理读队列，后台 GC 队列限速处理。

## 错误处理

请求对象里要保留错误信息：

```c
typedef enum {
    REQ_OK = 0,
    REQ_ERR_TIMEOUT = -1,
    REQ_ERR_NO_SPACE = -2,
    REQ_ERR_NAND_FAIL = -3,
    REQ_ERR_ECC = -4,
} req_status_t;
```

当 NAND 返回错误时：

```c
void Req_SetError(io_request_t *req, int status)
{
    req->status = status;
    req->state = REQ_ERROR;
}
```

错误处理要避免“请求丢失”。每个请求最终都必须完成或释放。

## 调试建议

建议给请求加 trace：

```c
#define REQ_TRACE(req, fmt, ...) \
    Log_Debug("[req:%u state:%d lba:%llu] " fmt, \
              (req)->id, (req)->state, (unsigned long long)(req)->lba, \
              ##__VA_ARGS__)
```

关键状态切换都打 trace，联调 Host IO 超时时会非常有用。

## 小结

请求队列和状态机是 eSSD 固件的骨架。FTL、NAND、Host、GC 都可以看成不同类型的请求在队列之间流转。

把请求生命周期设计清楚，后续再加并行、优先级、超时、重试和异常恢复，系统才不会越写越乱。
