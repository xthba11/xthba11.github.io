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
top_img: /img/embedded-lab-hero.png
---

# Linux 网络开发专题：常用算法

## 1. 最短路径算法 — Dijkstra

```c
#include <stdlib.h>
#include <limits.h>

#define INF INT_MAX            // 定义无穷大，表示节点之间不可达
#define MAX_NODES 6            // 图中节点总数

// 邻接矩阵：graph[i][j]表示从节点i到节点j的链路权重
// INF表示两个节点之间没有直接链路（不连通）
// 网络路由场景中，权重可以是跳数、延迟(ms)或链路代价
int graph[MAX_NODES][MAX_NODES] = {
    {0,   4,   INF, INF, INF, INF},  // 节点0：仅连接到节点1（权重4）
    {4,   0,   6,   INF, INF, INF},  // 节点1：连接到节点0和2
    {INF, 6,   0,   2,   INF, INF},  // 节点2：连接到节点1和3
    {INF, INF, 2,   0,   3,   INF},  // 节点3：连接到节点2和4
    {INF, INF, INF, 3,   0,   5},    // 节点4：连接到节点3和5
    {INF, INF, INF, INF, 5,   0}     // 节点5：仅连接到节点4
};

// Dijkstra最短路径算法：计算从源节点src到所有其他节点的最短距离
// 用于网络路由协议（如OSPF）中的SPF（Shortest Path First）计算
void dijkstra(int src) {
    int dist[MAX_NODES];              // dist[i]：从src到节点i的当前已知最短距离
    int visited[MAX_NODES] = {0};     // visited[i]：节点i是否已确定最短路径

    // 第1步：初始化距离数组
    // 源节点到自身距离为0，到其他节点初始为无穷大（未知）
    for (int i = 0; i < MAX_NODES; i++)
        dist[i] = INF;                // 所有距离初始化为无穷大
    dist[src] = 0;                    // 源节点到自身距离为0

    // 第2步：主循环，每次确定一个节点的最短路径（共需要MAX_NODES-1次迭代）
    for (int count = 0; count < MAX_NODES - 1; count++) {
        // 第3步：在所有未确定最短路径的节点中，选择dist最小的节点u
        // 这是Dijkstra的贪心选择——当前距离最小的节点，其最短路径已确定
        int u = -1, min_dist = INF;
        for (int i = 0; i < MAX_NODES; i++) {
            if (!visited[i] && dist[i] < min_dist) {
                min_dist = dist[i];   // 记录当前最小距离
                u = i;                // 记录最小距离对应的节点
            }
        }

        if (u == -1) break;           // 所有剩余节点均不可达，提前结束
        visited[u] = 1;               // 标记节点u的最短路径已确定

        // 第4步：松弛操作——用节点u更新其所有邻居v的距离
        // 如果经过u到达v的路径比当前已知的dist[v]更短，则更新dist[v]
        for (int v = 0; v < MAX_NODES; v++) {
            if (!visited[v]                    // v未确定最短路径
                && graph[u][v] != INF          // u到v有直接链路
                && dist[u] + graph[u][v] < dist[v]) { // 经过u的路径更短
                dist[v] = dist[u] + graph[u][v];       // 松弛：更新v的距离
            }
        }
    }

    // 第5步：打印从src到所有节点的最短距离结果
    printf("从节点 %d 出发的最短距离:\n", src);
    for (int i = 0; i < MAX_NODES; i++)
        printf("  -> %d: %d\n", i, dist[i]);
}

int main(void) {
    dijkstra(0);                    // 从节点0开始计算最短路径
    return 0;
}
```

---

## 2. 滑动窗口协议

```c
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define WINDOW_SIZE 4          // 滑动窗口大小（TCP中通常远大于此，这里简化为4）
#define BUFFER_SIZE 1024       // 每个分组的最大数据长度

// 发送窗口：维护发送端待确认的数据范围
// seq_base到seq_base+WINDOW_SIZE-1为窗口范围，seq_base到seq_next-1为已发送未确认
struct send_window {
    uint8_t buffer[WINDOW_SIZE][BUFFER_SIZE]; // 窗口内每个分组的缓冲区（用于可能的重传）
    uint32_t seq_base;          // 窗口左边界：最小的未确认序号（收到ACK后向右滑动）
    uint32_t seq_next;          // 下一个可发送的序号（seq_next - seq_base = 已发送未确认数）
    uint8_t acked[WINDOW_SIZE]; // ACK状态位图：acked[i]=1表示窗口内第i个分组已被确认
};

// 初始化发送窗口：所有序号从0开始，ACK位图清零
void sw_init(struct send_window *sw) {
    sw->seq_base = 0;                  // 窗口起始序号为0
    sw->seq_next = 0;                  // 下一个待发序号为0
    memset(sw->acked, 0, sizeof(sw->acked)); // 清除所有ACK标记
}

// 发送数据：将数据复制到窗口缓冲区并推进seq_next
// 返回0表示成功，返回-1表示窗口已满（达到发送上限，需等待ACK）
int sw_send(struct send_window *sw, const uint8_t *data, uint32_t len) {
    // 滑动窗口核心判断：seq_next不能超过窗口右边界seq_base+WINDOW_SIZE
    if (sw->seq_next >= sw->seq_base + WINDOW_SIZE) {
        return -1;  // 窗口已满，无法发送新数据（流量控制：发送速率受窗口限制）
    }
    uint32_t idx = sw->seq_next & (WINDOW_SIZE - 1); // 取模得到buffer数组下标
    memcpy(sw->buffer[idx], data, len);             // 复制数据到窗口缓冲区
    sw->seq_next++;                                  // 推进发送序号
    return 0;
}

// 处理接收到的ACK：确认序号ack表示之前的所有数据已被接收方正确收到
// 窗口向右滑动，释放已确认的缓冲区空间
void sw_handle_ack(struct send_window *sw, uint32_t ack) {
    if (ack > sw->seq_base) {          // 累积ACK：确认了新的数据
        uint32_t slide = ack - sw->seq_base; // 计算窗口滑动量
        sw->seq_base = ack;            // 窗口左边界右移到ack位置
        // 窗口滑动后，seq_base到seq_next之间的空间增大，可以发送更多数据
        // 实际实现中还需更新acked位图，此处省略...
    }
}

// 接收窗口：维护接收端期望的数据范围
// 用于处理TCP中的顺序接收和乱序缓存
struct recv_window {
    uint8_t buffer[WINDOW_SIZE][BUFFER_SIZE]; // 乱序到达时的暂存缓冲区
    uint32_t expect_seq;        // 期望收到的下一个序号（即下一个应顺序交付给应用层的数据）
    uint8_t received[WINDOW_SIZE]; // 接收状态位图：received[i]=1表示该序号数据已缓存
};

// 初始化接收窗口
void rw_init(struct recv_window *rw) {
    rw->expect_seq = 0;                                    // 期望从序号0开始接收
    memset(rw->received, 0, sizeof(rw->received));         // 清除所有接收标记
}

// 接收数据分组：根据序号判断是顺序到达、乱序到达还是超出窗口范围
// 返回值：0=顺序交付，1=乱序已缓存，-1=超出窗口丢弃
int rw_recv(struct recv_window *rw, uint32_t seq, const uint8_t *data, uint32_t len) {
    if (seq == rw->expect_seq) {
        // 情况1：正好是期望的序号——顺序到达，可以直接交付给应用层
        memcpy(rw->buffer[0], data, len);
        rw->expect_seq++;            // 期望序号推进一位
        // 实际TCP会检查received位图，看后续缓存的数据是否也变成可交付的
        return 0;                    // 返回0表示顺序交付成功
    } else if (seq > rw->expect_seq && seq < rw->expect_seq + WINDOW_SIZE) {
        // 情况2：序号大于期望值但在窗口范围内——乱序到达，先缓存起来
        uint32_t idx = seq & (WINDOW_SIZE - 1); // 取模得到buffer下标
        memcpy(rw->buffer[idx], data, len);
        rw->received[idx] = 1;       // 标记该序号已收到
        return 1;                    // 返回1表示乱序（触发了重复ACK，发送端会进行快速重传）
    }
    // 情况3：序号超出窗口范围，视为无效或重复分组
    return -1;                       // 返回-1表示超出窗口，丢弃该分组
}
```

---

## 3. 拥塞控制 — TCP Reno 实现

```c
#include <stdint.h>

// TCP 拥塞控制状态机（Reno版本）
// 三种状态之间的转换由ACK事件驱动：
// 慢启动 --(cwnd >= ssthresh)--> 拥塞避免
// 拥塞避免 --(3个重复ACK)--> 快速恢复 --(新ACK)--> 拥塞避免
// 任意状态 --(超时)--> 慢启动
enum tcp_state {
    TCP_SLOW_START,          // 慢启动：连接建立初期或超时后，cwnd指数增长探测可用带宽
    TCP_CONGESTION_AVOID,    // 拥塞避免：cwnd已接近网络容量，线性增长避免拥塞
    TCP_FAST_RECOVERY        // 快速恢复：收到3个重复ACK后进入，执行快速重传后恢复
};

// 拥塞控制结构：维护每个TCP连接独立的拥塞状态
// cwnd、ssthresh和state共同决定发送端的发送速率上限
struct tcp_cc {
    uint32_t cwnd;           // 拥塞窗口（Congestion Window）：限制发送端在未收到ACK时最多可发送的MSS数
    uint32_t ssthresh;       // 慢启动阈值（Slow Start Threshold）：cwnd超过此值后从慢启动切换到拥塞避免
    uint32_t dup_ack_count;  // 重复ACK计数器：收到连续相同ACK的数量，用于触发快速重传
    enum tcp_state state;    // 当前拥塞控制状态（慢启动/拥塞避免/快速恢复）
};

// 初始化拥塞控制：新连接从慢启动开始
// cwnd=1（1个MSS），ssthresh设为大值使初始阶段充分探测
void tcp_cc_init(struct tcp_cc *cc) {
    cc->cwnd = 1;              // 初始拥塞窗口为1个MSS（最大报文段长度）
    cc->ssthresh = 65535;      // 初始慢启动阈值设为极大值，确保慢启动阶段充分展开
    cc->dup_ack_count = 0;     // 重复ACK计数清零
    cc->state = TCP_SLOW_START;// 初始状态为慢启动
}

// 收到新的ACK（正常确认，非重复ACK）
// 根据不同状态执行不同的窗口增长策略
void tcp_cc_ack(struct tcp_cc *cc, uint32_t ack) {
    switch (cc->state) {
    case TCP_SLOW_START:
        // 慢启动阶段：每收到一个ACK，cwnd增加1个MSS
        // 效果上每个RTT后cwnd翻倍（指数增长），快速探测网络可用带宽
        cc->cwnd += 1;
        // 状态转换：cwnd达到ssthresh时，从慢启动切换为拥塞避免
        // 目的：接近网络容量上限时减缓增长速度，避免突然造成拥塞
        if (cc->cwnd >= cc->ssthresh)
            cc->state = TCP_CONGESTION_AVOID; // 慢启动 -> 拥塞避免
        break;

    case TCP_CONGESTION_AVOID:
        // 拥塞避免阶段：每收到一个ACK，cwnd增加 1/cwnd 个MSS
        // 简化实现为每个RTT线性增加1个MSS（加法增大，AIMD中的AI）
        cc->cwnd += 1;         // 注：准确实现应为每RTT加1，此处简化
        break;

    case TCP_FAST_RECOVERY:
        // 快速恢复阶段收到新ACK：说明快速重传成功，网络已恢复
        // 将cwnd缩减到ssthresh（丢包时已减半），退出快速恢复
        cc->cwnd = cc->ssthresh;                       // cwnd缩减到当前阈值
        cc->state = TCP_CONGESTION_AVOID;               // 快速恢复 -> 拥塞避免
        break;
    }
}

// 收到重复ACK（Duplicate ACK）
// 重复ACK通常意味着有分组丢失（接收方收到了乱序数据）
void tcp_cc_dup_ack(struct tcp_cc *cc) {
    cc->dup_ack_count++;                     // 重复ACK计数加1
    if (cc->dup_ack_count == 3) {
        // 收到第3个重复ACK——触发快速重传（Fast Retransmit）
        // 无需等待超时，立即重传丢失的分组
        // 拥塞控制动作：减半ssthresh和cwnd，而非像超时那样骤降到1
        cc->ssthresh = cc->cwnd / 2;         // ssthresh设为当前cwnd的一半（乘法减小，AIMD中的MD）
        cc->cwnd = cc->ssthresh + 3;         // cwnd = ssthresh + 3个已收到的重复ACK
        cc->state = TCP_FAST_RECOVERY;       // 拥塞避免 -> 快速恢复
        // 进入快速恢复后，每个额外的重复ACK都会临时膨胀cwnd：
    } else if (cc->dup_ack_count > 3) {
        // 收到第4个及以后的重复ACK：说明后续分组仍在到达（网络未完全堵塞）
        // 临时膨胀cwnd以保持数据流动（inflate操作）
        cc->cwnd += 1;                       // 每个额外重复ACK膨胀1个MSS
        // 注意：退出快速恢复时，cwnd会被缩减回ssthresh
    }
}

// 超时处理（RTO Timeout）：最严重的拥塞信号
// 超时意味着不仅分组丢失，而且整个网络可能严重拥塞
void tcp_cc_timeout(struct tcp_cc *cc) {
    // 超时后的策略比快速重传更激进：cwnd直接降到1，重新开始慢启动
    cc->ssthresh = cc->cwnd / 2;             // 记录当前窗口一半作为新的ssthresh
    cc->cwnd = 1;                            // cwnd骤降到1个MSS，重新开始探测
    cc->dup_ack_count = 0;                   // 重复ACK计数清零
    cc->state = TCP_SLOW_START;              // 任意状态 -> 慢启动（重新开始）
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
