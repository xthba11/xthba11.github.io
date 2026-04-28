---
title: Linux网络开发专题：常见算法（图算法、滑动窗口、拥塞控制）
date: 2026-04-28
categories:
  - 技术笔记
  - Linux
  - 网络编程
  - 常用算法
tags:
  - Linux
  - 网络编程
  - 算法
  - TCP
  - 滑动窗口
description: 网络编程中常用的算法：最短路径、滑动窗口、拥塞控制算法
top_img: https://source.unsplash.com/1600x900/?network,technology
---

## 1. 最短路径算法 — Dijkstra
---

# Linux 网络开发专题：常用算法

## 1. 最短路径算法 — Dijkstra

```c
#include <stdlib.h>
#include <limits.h>

#define INF INT_MAX
#define MAX_NODES 6

// 邻接矩阵
int graph[MAX_NODES][MAX_NODES] = {
    {0,   4,   INF, INF, INF, INF},
    {4,   0,   6,   INF, INF, INF},
    {INF, 6,   0,   2,   INF, INF},
    {INF, INF, 2,   0,   3,   INF},
    {INF, INF, INF, 3,   0,   5},
    {INF, INF, INF, INF, 5,   0}
};

void dijkstra(int src) {
    int dist[MAX_NODES];
    int visited[MAX_NODES] = {0};

    // 初始化
    for (int i = 0; i < MAX_NODES; i++)
        dist[i] = INF;
    dist[src] = 0;

    for (int count = 0; count < MAX_NODES - 1; count++) {
        // 找最小距离的未访问节点
        int u = -1, min_dist = INF;
        for (int i = 0; i < MAX_NODES; i++) {
            if (!visited[i] && dist[i] < min_dist) {
                min_dist = dist[i];
                u = i;
            }
        }

        if (u == -1) break;
        visited[u] = 1;

        // 更新邻居距离
        for (int v = 0; v < MAX_NODES; v++) {
            if (!visited[v] && graph[u][v] != INF &&
                dist[u] + graph[u][v] < dist[v]) {
                dist[v] = dist[u] + graph[u][v];
            }
        }
    }

    // 打印结果
    printf("从节点 %d 出发的最短距离:\n", src);
    for (int i = 0; i < MAX_NODES; i++)
        printf("  -> %d: %d\n", i, dist[i]);
}

int main(void) {
    dijkstra(0);
    return 0;
}
```

---

## 2. 滑动窗口协议

```c
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define WINDOW_SIZE 4
#define BUFFER_SIZE 1024

// 发送窗口
struct send_window {
    uint8_t buffer[WINDOW_SIZE][BUFFER_SIZE];
    uint32_t seq_base;          // 窗口起始序号
    uint32_t seq_next;          // 下一个待发序号
    uint8_t acked[WINDOW_SIZE]; // ACK状态
};

// 初始化
void sw_init(struct send_window *sw) {
    sw->seq_base = 0;
    sw->seq_next = 0;
    memset(sw->acked, 0, sizeof(sw->acked));
}

// 发送数据
int sw_send(struct send_window *sw, const uint8_t *data, uint32_t len) {
    if (sw->seq_next >= sw->seq_base + WINDOW_SIZE) {
        return -1;  // 窗口满
    }
    uint32_t idx = sw->seq_next & (WINDOW_SIZE - 1);
    memcpy(sw->buffer[idx], data, len);
    sw->seq_next++;
    return 0;
}

// 处理ACK
void sw_handle_ack(struct send_window *sw, uint32_t ack) {
    if (ack > sw->seq_base) {
        uint32_t slide = ack - sw->seq_base;
        sw->seq_base = ack;
        // 移动窗口...
    }
}

// 接收窗口
struct recv_window {
    uint8_t buffer[WINDOW_SIZE][BUFFER_SIZE];
    uint32_t expect_seq;       // 期望收到的下一个序号
    uint8_t received[WINDOW_SIZE]; // 接收状态
};

void rw_init(struct recv_window *rw) {
    rw->expect_seq = 0;
    memset(rw->received, 0, sizeof(rw->received));
}

// 接收数据
int rw_recv(struct recv_window *rw, uint32_t seq, const uint8_t *data, uint32_t len) {
    if (seq == rw->expect_seq) {
        // 顺序到达，直接交付
        memcpy(rw->buffer[0], data, len);
        rw->expect_seq++;
        return 0;
    } else if (seq > rw->expect_seq && seq < rw->expect_seq + WINDOW_SIZE) {
        // 乱序，存入缓冲区
        uint32_t idx = seq & (WINDOW_SIZE - 1);
        memcpy(rw->buffer[idx], data, len);
        rw->received[idx] = 1;
        return 1;  // 乱序
    }
    return -1;  // 超出窗口
}
```

---

## 3. 拥塞控制 — TCP Reno 实现

```c
#include <stdint.h>

// TCP 拥塞控制状态
enum tcp_state {
    TCP_SLOW_START,      // 慢启动
    TCP_CONGESTION_AVOID, // 拥塞避免
    TCP_FAST_RECOVERY    // 快速恢复
};

// 拥塞控制结构
struct tcp_cc {
    uint32_t cwnd;           // 拥塞窗口
    uint32_t ssthresh;       // 慢启动阈值
    uint32_t dup_ack_count;  // 重复ACK计数
    enum tcp_state state;
};

// 初始化
void tcp_cc_init(struct tcp_cc *cc) {
    cc->cwnd = 1;           // 初始窗口 MSS
    cc->ssthresh = 65535;   // 初始阈值
    cc->dup_ack_count = 0;
    cc->state = TCP_SLOW_START;
}

// 收到ACK
void tcp_cc_ack(struct tcp_cc *cc, uint32_t ack) {
    switch (cc->state) {
    case TCP_SLOW_START:
        cc->cwnd += 1;      // 每ACK翻倍
        if (cc->cwnd >= cc->ssthresh)
            cc->state = TCP_CONGESTION_AVOID;
        break;

    case TCP_CONGESTION_AVOID:
        cc->cwnd += 1;      // 每RTT加1
        break;

    case TCP_FAST_RECOVERY:
        cc->cwnd = cc->ssthresh;
        cc->state = TCP_CONGESTION_AVOID;
        break;
    }
}

// 收到重复ACK
void tcp_cc_dup_ack(struct tcp_cc *cc) {
    cc->dup_ack_count++;
    if (cc->dup_ack_count == 3) {
        // 快速重传
        cc->ssthresh = cc->cwnd / 2;
        cc->cwnd = cc->ssthresh + 3;
        cc->state = TCP_FAST_RECOVERY;
    } else if (cc->dup_ack_count > 3) {
        cc->cwnd += 1;
    }
}

// 超时处理
void tcp_cc_timeout(struct tcp_cc *cc) {
    cc->ssthresh = cc->cwnd / 2;
    cc->cwnd = 1;
    cc->dup_ack_count = 0;
    cc->state = TCP_SLOW_START;
}
```

---

## 总结

| 算法 | 时间复杂度 | 应用场景 |
|------|-----------|---------|
| Dijkstra | O(V²) / O(E log V) | 路由计算 |
| 滑动窗口 | O(1) | 流量控制 |
| TCP Reno | - | 拥塞控制 |

> **关键点**：网络算法的核心是在「效率」和「公平」之间找平衡。
