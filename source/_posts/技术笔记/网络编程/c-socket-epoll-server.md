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
# 编译 epoll 服务端，开启所有警告和 O2 优化
gcc -Wall -Wextra -O2 epoll_server.c -o epoll_server
# 启动服务端，监听 8888 端口
./epoll_server
```

另开一个终端连接：

```bash
# 用 nc (netcat) 连接服务端，测试 TCP 收发
nc 127.0.0.1 8888
# 输入任意内容，echo server 应原样返回
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
# 验证 1：查看 8888 端口是否处于 LISTEN 状态
ss -lntp | grep 8888

# 验证 2：跟踪系统调用，确认 accept/read/write/close 的调用顺序是否符合预期
strace -f -e epoll_wait,accept4,read,write,close ./epoll_server

# 验证 3：模拟 20 个并发客户端连接，测试事件循环是否会因为某个慢连接而阻塞
for i in $(seq 1 20); do
  (echo "client-$i"; sleep 1) | nc 127.0.0.1 8888 &
done
wait   # 等待所有后台 nc 进程结束
```

迁移到 RK3568 后，先不要急着接 Qt，可以先在板端运行服务端，在 PC 上连接板子的 IP：

```bash
# RK3568 板端启动服务端（先交叉编译或板端编译）
./epoll_server

# PC 端连接板子的 IP 进行测试
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

// 将 fd 设置为非阻塞模式 —— epoll 服务端的基础要求
static int set_nonblock(int fd)
{
    // 先获取当前 fd 的文件状态标志
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0)
        return -1;

    // 在原有标志上追加 O_NONBLOCK，再写回 fd
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
```

非阻塞是 epoll 服务端的基础。否则某个连接的 `read/write` 可能阻塞整个事件循环。

## 创建监听 socket

```c
// 创建监听 socket 并绑定端口，返回非阻塞的监听 fd
static int create_listen_socket(int port)
{
    int fd;
    int on = 1;
    struct sockaddr_in addr;

    // 步骤1：创建 TCP socket（AF_INET=IPv4, SOCK_STREAM=TCP）
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;

    // 步骤2：设置 SO_REUSEADDR，重启后可立即复用端口
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));

    // 步骤3：绑定地址结构（监听所有网卡 IP，指定端口）
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;               // IPv4
    addr.sin_addr.s_addr = htonl(INADDR_ANY); // 0.0.0.0，监听所有本地 IP
    addr.sin_port = htons(port);              // 端口号转网络字节序

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0)
        return -1;

    // 步骤4：开始监听，backlog=128 表示内核允许的最大排队连接数
    if (listen(fd, 128) < 0)
        return -1;

    // 步骤5：设为非阻塞，避免 accept() 阻塞事件循环
    set_nonblock(fd);
    return fd;
}
```

`SO_REUSEADDR` 可以避免服务重启时因为 TIME_WAIT 导致端口暂时不可用。

## 注册 epoll 事件

```c
// 将 fd 注册到 epoll 实例，让内核监控指定的事件类型
static int epoll_add(int epfd, int fd, uint32_t events)
{
    struct epoll_event ev;

    memset(&ev, 0, sizeof(ev));     // 清零结构体，避免未初始化字段
    ev.events = events;             // 设置要监控的事件类型（如 EPOLLIN）
    ev.data.fd = fd;                // 绑定用户数据（这里直接存 fd，方便事件回调时识别）

    // 调用 epoll_ctl 将 fd 加入 epoll 的监控列表
    return epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev);
}
```

对于监听 fd，我们关注 `EPOLLIN`；对于客户端 fd，也先关注可读事件。

## 接收新连接

```c
// 处理新连接：循环 accept 直到队列为空，每个客户端 fd 注册到 epoll
static void handle_accept(int epfd, int listen_fd)
{
    while (1) {  // 必须循环 accept，因为一次 epoll 事件可能对应多个排队连接
        struct sockaddr_in cli;
        socklen_t len = sizeof(cli);
        // accept4 从全连接队列取出一个已完成三次握手的连接
        int client_fd = accept(listen_fd, (struct sockaddr *)&cli, &len);

        if (client_fd < 0) {
            // EAGAIN 表示全连接队列已空，所有排队连接都已处理完毕
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                break;
            perror("accept");
            break;
        }

        // 客户端 fd 也必须设为非阻塞，防止读写阻塞事件循环
        set_nonblock(client_fd);
        // 注册到 epoll：监听可读 + 对端半关闭（EPOLLRDHUP 用于检测客户端断开）
        epoll_add(epfd, client_fd, EPOLLIN | EPOLLRDHUP);
        printf("client connected: %d\n", client_fd);
    }
}
```

注意这里用 `while` 循环把当前已经到来的连接全部 accept 完。

## 处理客户端数据

```c
// 处理客户端数据：循环读取并回显（echo），直到无数据可读或连接关闭
static void handle_client(int epfd, int fd)
{
    char buf[1024];

    while (1) {
        // 从客户端 fd 非阻塞读取数据
        ssize_t n = read(fd, buf, sizeof(buf));

        if (n > 0) {
            // 读到数据，原样写回（echo 回显）
            write(fd, buf, n);
            continue;  // 继续尝试读取，处理粘包或连续数据
        }

        if (n == 0) {
            // read 返回 0：对端正常关闭连接（发送了 FIN）
            printf("client closed: %d\n", fd);
            close(fd);  // 关闭 fd 会自动从 epoll 中移除
            return;
        }

        // n < 0：EAGAIN 表示内核缓冲区已空，暂无数据可读
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return;  // 正常返回，等待 epoll 下次通知

        // 其他 errno 才是真正的读写错误
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
    // 步骤1：创建监听 socket，绑定 8888 端口
    int listen_fd = create_listen_socket(8888);
    // 步骤2：创建 epoll 实例，参数 0 等价于 epoll_create(1)
    int epfd = epoll_create1(0);
    struct epoll_event events[64];  // 就绪事件数组，每轮最多返回 64 个

    if (listen_fd < 0 || epfd < 0) {
        perror("init");
        return -1;
    }

    // 步骤3：将监听 fd 注册到 epoll，关注可读事件（即有新连接到来）
    epoll_add(epfd, listen_fd, EPOLLIN);

    // 步骤4：进入事件循环
    while (1) {
        // 阻塞等待事件，超时 1000ms
        // 返回值 n 是本次就绪的 fd 数量
        int n = epoll_wait(epfd, events, 64, 1000);

        // 步骤5：遍历所有就绪事件，按事件类型分发处理
        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;      // 出事件的 fd
            uint32_t ev = events[i].events;  // 实际发生的事件类型

            // 分支1：监听 fd 可读 -> 有新连接，调用 accept 处理
            if (fd == listen_fd) {
                handle_accept(epfd, listen_fd);
                continue;
            }

            // 分支2：客户端 fd 发生异常事件，直接关闭
            // EPOLLHUP: 连接挂起, EPOLLERR: 错误, EPOLLRDHUP: 对端半关闭
            if (ev & (EPOLLHUP | EPOLLERR | EPOLLRDHUP)) {
                close(fd);  // close 会自动将该 fd 从 epoll 监控中移除
                continue;
            }

            // 分支3：客户端 fd 可读 -> 读取并回显数据
            if (ev & EPOLLIN)
                handle_client(epfd, fd);
        }
    }
}
```

## 测试

```bash
# 编译 epoll 服务端
gcc epoll_server.c -o epoll_server
# 启动服务端，阻塞等待客户端连接
./epoll_server

# 在另一个终端用 nc 连接测试
nc 127.0.0.1 8888
# 输入任意内容，echo server 会原样返回
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
