---
title: Linux网络开发专题：核心数据结构（图、内存池、RingBuffer）
date: 2026-04-28
categories:
  - 技术笔记
  - Linux
  - 网络编程
  - 核心数据结构
tags:
  - Linux
  - 网络编程
  - 数据结构
  - 内存池
  - RingBuffer
description: 深入理解网络协议栈中最常用的三种数据结构：图结构、内存池和环形缓冲区
cover: /img/covers/articles/linux-network-core-data-structures.svg
top_img: /img/covers/articles/linux-network-core-data-structures.svg
---

# Linux 网络开发专题：核心数据结构

网络协议栈开发中，最核心的三种数据结构。

## 1. 图（Graph）— 路由与拓扑

### 邻接表实现

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_NODES 256         // 图中最大节点数

// 邻接表节点：表示图中的一条边
// 网络路由中，每个邻接点代表一跳可达的邻居路由器/交换机
struct adj_node {
    int dest;                // 目标节点编号（邻居节点ID）
    int weight;              // 边的权重（路由度量：跳数、延迟、带宽代价等）
    struct adj_node *next;   // 指向下一条邻接边（链表实现）
};

// 图结构：用邻接表存储网络拓扑
// head[i] 指向节点i的所有出边链表，用于路由计算和拓扑发现
struct graph {
    struct adj_node *head[MAX_NODES]; // 每个节点的邻接表头指针数组
    int num_nodes;                    // 图中当前节点数量
};

// 添加边：在网络拓扑中加入一条链路（src -> dest）
// 头插法将新边插入邻接链表，O(1)时间复杂度
void add_edge(struct graph *g, int src, int dest, int weight) {
    struct adj_node *node = malloc(sizeof(struct adj_node)); // 分配新邻接节点
    node->dest = dest;                // 设置目标节点
    node->weight = weight;            // 设置链路权重
    node->next = g->head[src];        // 新节点指向当前链表头
    g->head[src] = node;              // 头指针指向新节点（头插法）
}

// BFS 遍历路由：广度优先搜索整个网络拓扑
// 从start节点出发，按层次遍历所有可达节点，用于拓扑发现
void bfs(struct graph *g, int start) {
    int visited[MAX_NODES] = {0};     // 访问标记数组，防止重复访问
    int queue[MAX_NODES];             // BFS队列（用数组模拟循环队列）
    int front = 0, rear = 0;          // 队列头尾指针

    visited[start] = 1;               // 标记起点已访问
    queue[rear++] = start;            // 起点入队

    while (front < rear) {            // 队列非空则继续遍历
        int curr = queue[front++];    // 出队当前节点
        printf("Visit: %d\n", curr);  // 访问（在实际路由中可能是更新路由表）

        struct adj_node *node = g->head[curr]; // 遍历当前节点的所有邻居
        while (node) {
            if (!visited[node->dest]) {        // 如果邻居未访问过
                visited[node->dest] = 1;       // 标记为已访问
                queue[rear++] = node->dest;    // 邻居入队待访问
            }
            node = node->next;                 // 继续遍历下一个邻居
        }
    }
}
```

### 应用场景
- 路由选择算法（Dijkstra、Bellman-Ford）
- 网络拓扑发现
- 流量工程

---

## 2. 内存池（Memory Pool）— 高效内存管理

### 固定大小内存池

```c
#include <stdlib.h>
#include <string.h>

#define POOL_SIZE 4096       // 内存池总大小（字节）
#define BLOCK_SIZE 64        // 每个内存块大小（字节），类比网络包的最小分配单元

// 内存块：内存池中的最小分配单元
// 空闲时通过next指针链接成空闲链表，分配后data字段返回给调用者
struct mem_block {
    struct mem_block *next;  // 空闲链表指针（仅块空闲时有效）
    char data[BLOCK_SIZE];   // 实际数据区，大小为BLOCK_SIZE字节
};

// 内存池：预分配一大块连续内存，避免运行时频繁malloc/free
// 网络协议栈中用于sk_buff等高频分配场景，O(1)分配/释放
struct mem_pool {
    char *buffer;            // 预分配的大块连续内存（POOL_SIZE字节）
    struct mem_block *free_list; // 空闲块链表头指针，为NULL表示池已空
    int free_count;          // 当前剩余的空闲块数量
};

// 初始化内存池：分配大块内存并构建空闲块链表
// 返回初始化好的内存池指针，失败时内部malloc可能返回NULL
struct mem_pool *pool_create(void) {
    struct mem_pool *pool = malloc(sizeof(struct mem_pool)); // 分配池管理结构
    pool->buffer = malloc(POOL_SIZE);                        // 分配底层大块内存
    pool->free_list = NULL;                                  // 空闲链表初始为空
    pool->free_count = POOL_SIZE / BLOCK_SIZE;               // 计算可切分的块数

    // 第1步：遍历底层buffer，将每个BLOCK_SIZE大小的区域转为mem_block
    // 第2步：使用头插法将所有块串联成空闲链表
    for (int i = 0; i < pool->free_count; i++) {
        struct mem_block *block = (struct mem_block *)(pool->buffer + i * BLOCK_SIZE); // 定位第i块
        block->next = pool->free_list;  // 新块指向当前链表头
        pool->free_list = block;        // 链表头移到新块（头插法）
    }
    return pool;
}

// 分配一个内存块：从空闲链表中取出头部块，O(1)操作
// 返回指向data字段的指针，调用者可安全使用BLOCK_SIZE字节
void *pool_alloc(struct mem_pool *pool) {
    if (!pool->free_list) return NULL;     // 空闲链表为空，内存池已耗尽
    struct mem_block *block = pool->free_list; // 取出链表头部块
    pool->free_list = block->next;         // 链表头后移，跳过已分配的块
    pool->free_count--;                    // 空闲计数减一
    return block->data;                    // 返回数据区指针给调用者
}

// 释放一个内存块：将块归还到空闲链表头部，O(1)操作
// ptr必须是由pool_alloc从同一个内存池返回的指针
void pool_free(struct mem_pool *pool, void *ptr) {
    struct mem_block *block = (struct mem_block *)ptr; // ptr即block->data的地址
    block->next = pool->free_list;   // 归还的块指向当前链表头
    pool->free_list = block;         // 链表头移到归还的块（头插法归还）
    pool->free_count++;              // 空闲计数加一
}
```

### 应用场景
- sk_buff（Socket Buffer）管理
- DMA 缓冲区分配
- 中断上下文中不能睡眠的内存分配

---

## 3. 环形缓冲区（RingBuffer）— 无锁队列

### 单生产者单消费者实现

```c
#include <stdint.h>
#include <string.h>

#define BUFFER_SIZE 1024      // 环形缓冲区容量，必须是2的幂以便位运算取模

// 环形缓冲区：单生产者单消费者无锁队列
// 利用索引单调递增 + 位掩码取模实现环绕，避免取模运算开销
// write_idx和read_idx用volatile修饰，防止编译器优化导致读写顺序问题
struct ring_buffer {
    uint8_t buffer[BUFFER_SIZE];     // 底层数据存储数组
    volatile uint32_t write_idx;     // 写索引（生产者维护，单调递增，永不减小）
    volatile uint32_t read_idx;      // 读索引（消费者维护，单调递增，永不减小）
};

// 入队（生产者调用）：将数据写入环形缓冲区
// 逐字节写入，write_idx单调递增，通过 & (BUFFER_SIZE - 1) 实现环绕
int ring_push(struct ring_buffer *ring, const uint8_t *data, uint32_t len) {
    for (uint32_t i = 0; i < len; i++) {
        // write_idx & (BUFFER_SIZE-1) 等价于 write_idx % BUFFER_SIZE，但位运算更快
        ring->buffer[ring->write_idx & (BUFFER_SIZE - 1)] = data[i];
        ring->write_idx++;           // 写索引递增（不取模，利用uint32自然溢出环绕）
    }
    return len;                      // 返回写入的字节数（简化实现，未检查空间）
}

// 出队（消费者调用）：从环形缓冲区读取数据
// 只有read_idx < write_idx时才有数据可读（防止读空队列）
int ring_pop(struct ring_buffer *ring, uint8_t *data, uint32_t len) {
    uint32_t count = 0;
    // 循环条件：还有请求的数据 且 队列非空（read_idx未追上write_idx）
    while (count < len && ring->read_idx < ring->write_idx) {
        // read_idx & (BUFFER_SIZE-1) 获取当前读取位置的数组下标
        data[count++] = ring->buffer[ring->read_idx & (BUFFER_SIZE - 1)];
        ring->read_idx++;            // 读索引递增，释放该位置供生产者覆写
    }
    return count;                    // 返回实际读取的字节数
}

// 获取环形缓冲区中可读数据量（队列中待消费的字节数）
// write_idx - read_idx 即已写入但未读取的字节数
uint32_t ring_available(struct ring_buffer *ring) {
    return ring->write_idx - ring->read_idx;
}
```

### 应用场景
- 网络数据包接收队列
- 日志系统缓冲区
- 进程间通信

---

## 总结

| 数据结构 | 时间复杂度 | 空间复杂度 | 典型应用 |
|---------|-----------|-----------|---------|
| 图 | O(V+E) | O(V+E) | 路由算法 |
| 内存池 | O(1) | 固定 | sk_buff、DMA |
| RingBuffer | O(1) | 固定 | 数据包队列 |

> **核心原则**：网络开发中，尽量避免频繁的 malloc/free，使用预分配的数据结构能显著提升性能。
