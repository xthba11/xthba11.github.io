---
title: Linux网络开发专题：常见踩坑与解决方案
date: 2026-04-28
categories:
  - 技术笔记
  - Linux
  - 网络编程
  - 常见坑
tags:
  - Linux
  - 网络编程
  - 踩坑
  - socket
description: 网络编程中常见的坑及其解决方案：字节序、socket选项、粘包、断线重连
---

# Linux 网络开发专题：常见踩坑与解决方案

## 坑 1：字节序问题

### 问题描述
不同平台的字节序不同（大端/小端），网络协议统一用大端序（网络字节序）。

```c
// 错误示例
uint32_t ip = 0xC0A80101;  // 192.168.1.1
write(sockfd, &ip, sizeof(ip));  // 不同平台解析不同！
```

### 解决方案

```c
#include <arpa/inet.h>

// 正确做法：使用 inet_pton / inet_ntop
struct sockaddr_in addr;
inet_pton(AF_INET, "192.168.1.1", &addr.sin_addr);  // 字符串转二进制
// 或
addr.sin_addr.s_addr = htonl(INADDR_ANY);  // 本机序转网络序

// 读取时反向转换
char buf[INET_ADDRSTRLEN];
inet_ntop(AF_INET, &addr.sin_addr, buf, sizeof(buf));

// 数字序列化
uint32_t htonl(uint32_t hostlong);   // 本机序 -> 网络序
uint32_t ntohl(uint32_t netlong);   // 网络序 -> 本机序
uint16_t htons(uint16_t hostshort); // 本机序 -> 网络序
uint16_t ntohs(uint16_t netshort); // 网络序 -> 本机序
```

---

## 坑 2：TCP 粘包 / 半包

### 问题描述
TCP 是流协议，不保留消息边界。接收方可能一次收到多个包或一个包的不完整数据。

```c
// 服务端
while (1) {
    char buf[1024];
    int n = read(client_fd, buf, sizeof(buf));
    // 可能一次收到半个包，或多个包粘在一起
}
```

### 解决方案

**方案 A：固定长度**

```c
#define MSG_LEN 1024

char buf[MSG_LEN];
int total = 0;
while (total < MSG_LEN) {
    int n = read(sockfd, buf + total, MSG_LEN - total);
    if (n <= 0) return;  // 断开
    total += n;
}
```

**方案 B：长度前缀 + 数据**

```c
// 发送：4字节长度 + 数据
uint32_t len = htonl(msg_len);
write(sockfd, &len, 4);
write(sockfd, msg, msg_len);

// 接收：先读长度，再读数据
uint32_t len;
read(sockfd, &len, 4);
len = ntohl(len);
char *msg = malloc(len);
int total = 0;
while (total < len) {
    int n = read(sockfd, msg + total, len - total);
    total += n;
}
```

**方案 C：特殊分隔符（如 \n）**

```c
char buf[4096], *p = buf;
while (read(sockfd, p, 1) == 1) {
    if (*p == '\n') {
        *p = '\0';
        process_message(buf);
        p = buf;
    } else {
        p++;
    }
}
```

---

## 坑 3：SIGPIPE 信号

### 问题描述
向已关闭的 socket 写数据会触发 SIGPIPE 信号，导致进程崩溃。

```c
// 错误示例
write(sockfd, data, len);  // 如果对端关闭，可能触发 SIGPIPE
```

### 解决方案

```c
// 方法 1：忽略 SIGPIPE
signal(SIGPIPE, SIG_IGN);

// 方法 2：使用 MSG_NOSIGNAL
int n = send(sockfd, data, len, MSG_NOSIGNAL);
if (n < 0 && errno == EPIPE) {
    // 处理断开
}
```

---

## 坑 4：TIME_WAIT 堆积

### 问题描述
高并发服务器，主动关闭连接的一方会进入 TIME_WAIT 状态（持续 2MSL），占用端口。

```bash
# 查看连接状态
netstat -ant | grep TIME_WAIT | wc -l
```

### 解决方案

```c
// 方法 1：启用 SO_REUSEADDR
int opt = 1;
setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

// 方法 2：调整短连接为长连接
// 方法 3：客户端使用 SO_LINGER 跳过 TIME_WAIT
struct linger ling = {1, 0};  // 立即关闭，不发送 FIN
setsockopt(sockfd, SOL_SOCKET, SO_LINGER, &ling, sizeof(ling));
```

---

## 坑 5：非阻塞 socket 的 EAGAIN

### 问题描述
非阻塞模式下，操作返回 -1，errno 为 EAGAIN 或 EWOULDBLOCK，表示暂时无数据。

```c
// 错误示例
int n = read(sockfd, buf, len);
if (n < 0) {
    perror("read error");  // EAGAIN 也会触发这个
}
```

### 解决方案

```c
int n = read(sockfd, buf, len);
if (n < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
        // 暂时无数据，稍后再试
        return;
    } else {
        perror("read error");
        return;
    }
} else if (n == 0) {
    // 对端关闭连接
    close(sockfd);
}
```

---

## 坑 6：select 最大 fd 限制

### 问题描述
select 使用 fd_set，有 FD_SETSIZE 限制（通常 1024）。

```c
// 错误示例
fd_set readfds;
FD_ZERO(&readfds);
for (int i = 0; i < 2000; i++) {  // 超出 FD_SETSIZE
    FD_SET(sockfd[i], &readfds);
}
```

### 解决方案

**方案 A：使用 poll（无 fd 数量限制）**

```c
#include <poll.h>

struct pollfd fds[4096];
int nfds = 0;
fds[nfds].fd = sockfd;
fds[nfds].events = POLLIN;
nfds++;

int ret = poll(fds, nfds, timeout_ms);
if (ret > 0) {
    for (int i = 0; i < nfds; i++) {
        if (fds[i].revents & POLLIN) {
            // 处理可读事件
        }
    }
}
```

**方案 B：使用 epoll（Linux 高效方案）**

```c
#include <sys/epoll.h>

int epfd = epoll_create1(0);
struct epoll_event ev, events[1024];

ev.events = EPOLLIN;
ev.data.fd = sockfd;
epoll_ctl(epfd, EPOLL_CTL_ADD, sockfd, &ev);

while (1) {
    int nfds = epoll_wait(epfd, events, 1024, -1);
    for (int i = 0; i < nfds; i++) {
        // 处理事件
    }
}
```

---

## 总结

| 坑 | 关键词 | 解决方案 |
|----|--------|---------|
| 字节序 | 网络序 vs 本机序 | htonl/ntohl |
| 粘包 | 消息边界 | 长度前缀 / 分隔符 |
| SIGPIPE | 写已关闭 socket | SIG_IGN / MSG_NOSIGNAL |
| TIME_WAIT | 端口耗尽 | SO_REUSEADDR |
| EAGAIN | 非阻塞 | errno 判断 |
| fd 限制 | select | poll / epoll |

> **核心原则**：网络编程无小事，每一个「看起来正常」的代码都可能藏坑。
