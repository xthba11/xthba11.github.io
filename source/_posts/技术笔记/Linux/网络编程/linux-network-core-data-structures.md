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
---

# Linux 网络开发专题：核心数据结构

网络协议栈开发中，最核心的三种数据结构。

## 1. 图（Graph）— 路由与拓扑

### 邻接表实现

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_NODES 256

// 邻接表节点
struct adj_node {
    int dest;               // 目标节点
    int weight;             // 权重（如跳数、延迟）
    struct adj_node *next;
};

// 图结构
struct graph {
    struct adj_node *head[MAX_NODES];
    int num_nodes;
};

// 添加边
void add_edge(struct graph *g, int src, int dest, int weight) {
    struct adj_node *node = malloc(sizeof(struct adj_node));
    node->dest = dest;
    node->weight = weight;
    node->next = g->head[src];
    g->head[src] = node;
}

// BFS 遍历路由
void bfs(struct graph *g, int start) {
    int visited[MAX_NODES] = {0};
    int queue[MAX_NODES];
    int front = 0, rear = 0;

    visited[start] = 1;
    queue[rear++] = start;

    while (front < rear) {
        int curr = queue[front++];
        printf("Visit: %d\n", curr);

        struct adj_node *node = g->head[curr];
        while (node) {
            if (!visited[node->dest]) {
                visited[node->dest] = 1;
                queue[rear++] = node->dest;
            }
            node = node->next;
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

#define POOL_SIZE 4096
#define BLOCK_SIZE 64

// 内存块
struct mem_block {
    struct mem_block *next;
    char data[BLOCK_SIZE];
};

// 内存池
struct mem_pool {
    char *buffer;           // 预分配的大块内存
    struct mem_block *free_list;
    int free_count;
};

// 初始化内存池
struct mem_pool *pool_create(void) {
    struct mem_pool *pool = malloc(sizeof(struct mem_pool));
    pool->buffer = malloc(POOL_SIZE);
    pool->free_list = NULL;
    pool->free_count = POOL_SIZE / BLOCK_SIZE;

    // 将所有块加入空闲链表
    for (int i = 0; i < pool->free_count; i++) {
        struct mem_block *block = (struct mem_block *)(pool->buffer + i * BLOCK_SIZE);
        block->next = pool->free_list;
        pool->free_list = block;
    }
    return pool;
}

// 分配
void *pool_alloc(struct mem_pool *pool) {
    if (!pool->free_list) return NULL;
    struct mem_block *block = pool->free_list;
    pool->free_list = block->next;
    pool->free_count--;
    return block->data;
}

// 释放
void pool_free(struct mem_pool *pool, void *ptr) {
    struct mem_block *block = (struct mem_block *)ptr;
    block->next = pool->free_list;
    pool->free_list = block;
    pool->free_count++;
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

#define BUFFER_SIZE 1024

struct ring_buffer {
    uint8_t buffer[BUFFER_SIZE];
    volatile uint32_t write_idx;   // 写索引
    volatile uint32_t read_idx;    // 读索引
};

// 入队（生产者）
int ring_push(struct ring_buffer *ring, const uint8_t *data, uint32_t len) {
    for (uint32_t i = 0; i < len; i++) {
        ring->buffer[ring->write_idx & (BUFFER_SIZE - 1)] = data[i];
        ring->write_idx++;
    }
    return len;
}

// 出队（消费者）
int ring_pop(struct ring_buffer *ring, uint8_t *data, uint32_t len) {
    uint32_t count = 0;
    while (count < len && ring->read_idx < ring->write_idx) {
        data[count++] = ring->buffer[ring->read_idx & (BUFFER_SIZE - 1)];
        ring->read_idx++;
    }
    return count;
}

// 获取可用数据量
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
