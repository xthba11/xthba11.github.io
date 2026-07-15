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

这篇文章实现一个最小 echo server，用来理解 epoll 的基本结构。

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
