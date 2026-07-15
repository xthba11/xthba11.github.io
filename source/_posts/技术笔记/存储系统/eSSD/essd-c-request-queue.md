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
