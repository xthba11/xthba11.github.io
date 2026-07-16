---
title: C 语言网络编程：epoll 服务端最小实践
date: 2026-05-02
categories:
  - 技术笔记
  - 网络编程
  - Socket编程
tags:
  - C
  - Linux
  - epoll
  - TCP
  - socket
description: 用 C 语言实现一个 epoll TCP 服务端，理解非阻塞 socket、事件循环、连接管理和常见错误处理。
top_img: /img/embedded-lab-hero.png
---

在 Linux 网络编程中，`epoll` 是实现高并发 TCP 服务端的常用机制。它的核心思想是：把大量 fd 交给内核监控，应用层只处理真正发生事件的连接。

这篇文章实现一个最小 echo server，用来理解 epoll 的基本结构。它也对应 RK3568 车载网关项目里的一个真实需求：网关进程采集 CAN 状态和车道偏离告警后，需要把 JSON 状态推给 Qt Dashboard、调试客户端或者远程日志工具。即使最终使用本地 socket、TCP 或 WebSocket，底层连接管理都绕不开事件循环。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS，先在 PC 上完成 TCP 服务端闭环测试。
- 目标板/芯片：RK3568 Linux 开发板，后续部署到车载网关实验平台。
- 内核/SDK/编译器版本：Ubuntu GCC 11/12；RK3568 侧使用板端 GCC 或 SDK 交叉编译工具链。
- 使用工具：`gcc`、`nc`、`telnet`、`ss`、`strace`、`tcpdump`、`gdb`、`valgrind`。
- 关联项目：RK3568 车载网关与车道偏离预警系统，核心模块包括 SocketCAN Receiver、Vehicle State Manager、Alarm Manager、SQLite Storage 和 Qt Dashboard。

本文的最小程序先做 echo，真实项目里可以把 echo 的位置替换成 JSON 状态推送：

```json
{"speed":42.5,"rpm":1800,"lane_offset":-0.32,"alarm":"lane_departure"}
```

## 问题背景

RK3568 车载网关的数据流大致是：

```text
vcan0/can0 -> SocketCAN 接收线程 -> CAN 队列 -> 车辆状态解析
视频文件/USB 摄像头 -> OpenCV 车道线检测 -> 偏移量计算
车辆状态 + 车道状态 -> 融合告警 -> SQLite + Qt Dashboard
```

Qt Dashboard 可以和网关主进程放在同一个进程里，也可以拆成两个进程。拆成两个进程时，网关进程就需要对外提供状态输出接口。这里先用 TCP 服务端模拟这个接口：Dashboard 或调试工具连接到 `vehicle_gateway`，网关周期性发送车辆状态、ECU 在线状态和告警列表。

这篇文章保留 echo server，是为了把重点放在 `epoll` 的连接生命周期上；等连接管理稳定后，再加入应用层协议。

## 验证方法

先编译并运行最小服务端：

```bash
gcc -Wall -Wextra -O2 epoll_server.c -o epoll_server
./epoll_server
```

另开一个终端连接：

```bash
nc 127.0.0.1 8888
hello rk3568 gateway
```

期望服务端输出：

```text
client connected: 5
```

客户端期望收到原样回显：

```text
hello rk3568 gateway
```

再做三个验证：

```bash
# 查看监听端口
ss -lntp | grep 8888

# 跟踪系统调用，确认 accept/read/write/close 是否符合预期
strace -f -e epoll_wait,accept4,read,write,close ./epoll_server

# 多连接压测，观察服务端是否因为单个连接阻塞
for i in $(seq 1 20); do
  (echo "client-$i"; sleep 1) | nc 127.0.0.1 8888 &
done
wait
```

迁移到 RK3568 后，先不要急着接 Qt，可以先在板端运行服务端，在 PC 上连接板子的 IP：

```bash
# RK3568
./epoll_server

# PC
nc <rk3568_ip> 8888
```

如果 PC 连不上，优先检查 `ip addr`、防火墙、网线/WiFi、端口监听和板端路由。

## 复盘

我把这个实验放在车载网关项目之前，是因为很多网络问题在业务代码写完后才暴露，会很难定位。

- 监听 fd 和客户端 fd 都要设置非阻塞，否则某个慢客户端就可能拖住整个事件循环。
- `accept()` 要循环到 `EAGAIN`，因为一次 epoll 事件可能对应多个排队连接。
- `read()` 返回 0 表示对端正常关闭，不能当成错误继续读。
- `write()` 不保证一次发完。本文 echo 简化处理，真实 JSON 推送要维护发送缓冲区，并在未发完时注册 `EPOLLOUT`。
- 必须处理 `EPOLLHUP`、`EPOLLERR`、`EPOLLRDHUP`，否则 Dashboard 断开后 fd 可能一直挂在 epoll 里。
- 真实项目建议每个连接维护一个 `client_ctx`，保存 fd、接收缓冲区、发送队列、最后活跃时间和订阅状态。

后续把这个服务端接入 RK3568 网关时，我会让 CAN 解析线程只更新车辆状态，网络线程只负责把状态快照编码成 JSON 并发送，避免在 epoll 回调里做耗时的 OpenCV 或 SQLite 操作。

## 服务端流程

```text
socket()
  -> bind()
  -> listen()
  -> set_nonblock(listen_fd)
  -> epoll_create1()
  -> epoll_ctl(ADD listen_fd)
  -> epoll_wait()
       -> accept 新连接
       -> read 客户端数据
       -> write 回显数据
       -> close 异常连接
```

## 设置非阻塞

```c
#include <fcntl.h>

static int set_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0)
        return -1;

    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
```

非阻塞是 epoll 服务端的基础。否则某个连接的 `read/write` 可能阻塞整个事件循环。

## 创建监听 socket

```c
static int create_listen_socket(int port)
{
    int fd;
    int on = 1;
    struct sockaddr_in addr;

    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;

    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));

    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(port);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0)
        return -1;

    if (listen(fd, 128) < 0)
        return -1;

    set_nonblock(fd);
    return fd;
}
```

`SO_REUSEADDR` 可以避免服务重启时因为 TIME_WAIT 导致端口暂时不可用。

## 注册 epoll 事件

```c
static int epoll_add(int epfd, int fd, uint32_t events)
{
    struct epoll_event ev;

    memset(&ev, 0, sizeof(ev));
    ev.events = events;
    ev.data.fd = fd;

    return epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev);
}
```

对于监听 fd，我们关注 `EPOLLIN`；对于客户端 fd，也先关注可读事件。

## 接收新连接

```c
static void handle_accept(int epfd, int listen_fd)
{
    while (1) {
        struct sockaddr_in cli;
        socklen_t len = sizeof(cli);
        int client_fd = accept(listen_fd, (struct sockaddr *)&cli, &len);

        if (client_fd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                break;
            perror("accept");
            break;
        }

        set_nonblock(client_fd);
        epoll_add(epfd, client_fd, EPOLLIN | EPOLLRDHUP);
        printf("client connected: %d\n", client_fd);
    }
}
```

注意这里用 `while` 循环把当前已经到来的连接全部 accept 完。

## 处理客户端数据

```c
static void handle_client(int epfd, int fd)
{
    char buf[1024];

    while (1) {
        ssize_t n = read(fd, buf, sizeof(buf));

        if (n > 0) {
            write(fd, buf, n);
            continue;
        }

        if (n == 0) {
            printf("client closed: %d\n", fd);
            close(fd);
            return;
        }

        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return;

        perror("read");
        close(fd);
        return;
    }
}
```

这只是 echo server 的简化写法。真实项目里 `write` 也要处理半包发送，需要发送缓冲区和 `EPOLLOUT`。

## 主事件循环

```c
int main(void)
{
    int listen_fd = create_listen_socket(8888);
    int epfd = epoll_create1(0);
    struct epoll_event events[64];

    if (listen_fd < 0 || epfd < 0) {
        perror("init");
        return -1;
    }

    epoll_add(epfd, listen_fd, EPOLLIN);

    while (1) {
        int n = epoll_wait(epfd, events, 64, 1000);

        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;
            uint32_t ev = events[i].events;

            if (fd == listen_fd) {
                handle_accept(epfd, listen_fd);
                continue;
            }

            if (ev & (EPOLLHUP | EPOLLERR | EPOLLRDHUP)) {
                close(fd);
                continue;
            }

            if (ev & EPOLLIN)
                handle_client(epfd, fd);
        }
    }
}
```

## 测试

```bash
gcc epoll_server.c -o epoll_server
./epoll_server

# 另一个终端
nc 127.0.0.1 8888
hello
```

## LT 与 ET

epoll 有两种常见触发模式：

- LT：水平触发，默认模式。只要 fd 还有数据，下次还会通知。
- ET：边缘触发，只在状态变化时通知。必须循环读到 `EAGAIN`。

新手建议先用 LT，理解事件循环后再使用 ET。

## 常见坑

- fd 没有设置非阻塞
- ET 模式没有读到 `EAGAIN`
- 忘记处理 `EPOLLHUP/EPOLLERR/EPOLLRDHUP`
- `write` 假设一次能发完
- 没有连接对象，导致协议状态无法管理
- 没有心跳和超时，死连接长期占资源

## 下一步

这个最小服务端只解决“能收发”。真实项目还需要：

- 每个连接一个上下文结构
- 接收缓冲区和发送缓冲区
- 协议帧解析
- 心跳和超时管理
- 限流和最大连接数控制
- 日志和抓包分析

epoll 的难点不在 API，而在连接生命周期管理。把连接对象设计好，后面的协议解析和业务处理才不会乱。
