---
title: 嵌入式 C 第四篇：环形缓冲区，串口接收最常用的数据结构
date: 2026-07-17 10:40:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - 环形缓冲区
  - 串口
  - 中断
description: 从串口中断接收场景出发，实现一个带注释的 ring buffer，并说明满/空判断、并发风险和协议解析接入方式。
cover: /img/covers/articles/embedded-c-ring-buffer-uart.svg
top_img: /img/covers/articles/embedded-c-ring-buffer-uart.svg
---

串口接收是嵌入式里最常见的输入场景。中断里一个字节一个字节进来，主循环或任务慢慢解析。如果没有缓冲区，中断和业务处理就会互相干扰。

环形缓冲区就是解决这个问题的经典结构。

## 为什么需要环形缓冲区

串口数据流：

```text
UART RX 中断 -> 写入 ring buffer -> 主循环/任务读取 -> 协议解析
```

中断要快，不能在里面做复杂协议解析；主循环可能慢，不能要求每个字节来时都立刻处理。所以需要一个中间队列。

## 数据结构

```c
#include <stdint.h>
#include <stddef.h>

typedef struct {
    uint8_t *buf;     // 外部提供的存储区
    size_t size;      // 存储区大小
    size_t read;      // 读索引
    size_t write;     // 写索引
} RingBuffer;
```

这里让用户提供数组，不在 ring buffer 内部 `malloc`，更适合 MCU。

## 初始化

```c
int rb_init(RingBuffer *rb, uint8_t *buf, size_t size)
{
    if (rb == NULL || buf == NULL || size < 2) {
        return -1;
    }

    rb->buf = buf;
    rb->size = size;
    rb->read = 0;
    rb->write = 0;
    return 0;
}
```

为什么 `size < 2` 不允许？因为我们采用“空一个位置”的方式区分满和空。

## 空和满

```c
static size_t rb_next(const RingBuffer *rb, size_t index)
{
    index++;
    if (index >= rb->size) {
        index = 0;
    }
    return index;
}

int rb_is_empty(const RingBuffer *rb)
{
    return rb->read == rb->write;
}

int rb_is_full(const RingBuffer *rb)
{
    return rb_next(rb, rb->write) == rb->read;
}
```

判断满时留一个空位：

```text
next(write) == read 表示满
read == write 表示空
```

这样逻辑简单，但实际可用容量是 `size - 1`。

## 写入一个字节

```c
int rb_push(RingBuffer *rb, uint8_t data)
{
    size_t next;

    if (rb == NULL) {
        return -1;
    }

    next = rb_next(rb, rb->write);

    if (next == rb->read) {
        // 缓冲区满，不能写入
        return -2;
    }

    rb->buf[rb->write] = data;
    rb->write = next;
    return 0;
}
```

中断里可以调用 `rb_push()`，但真实工程里要注意读写索引的原子性。

## 读取一个字节

```c
int rb_pop(RingBuffer *rb, uint8_t *out)
{
    if (rb == NULL || out == NULL) {
        return -1;
    }

    if (rb->read == rb->write) {
        // 缓冲区空
        return -2;
    }

    *out = rb->buf[rb->read];
    rb->read = rb_next(rb, rb->read);
    return 0;
}
```

## 串口中断接入

```c
#define UART_RX_BUF_SIZE 128

static uint8_t g_uart_rx_storage[UART_RX_BUF_SIZE];
static RingBuffer g_uart_rx_rb;

void uart_init_buffer(void)
{
    rb_init(&g_uart_rx_rb, g_uart_rx_storage, sizeof(g_uart_rx_storage));
}

void USART_IRQHandler(void)
{
    uint8_t byte;

    // 这里用伪代码表示读取串口数据寄存器
    byte = UART_READ_DATA_REGISTER();

    // 中断里只入队，不解析协议，不打印日志
    (void)rb_push(&g_uart_rx_rb, byte);
}
```

中断里不要 `printf`，不要跑状态机，不要写 Flash。

## 主循环解析

```c
void uart_poll(void)
{
    uint8_t byte;

    while (rb_pop(&g_uart_rx_rb, &byte) == 0) {
        // 每次取出一个字节，交给协议状态机
        protocol_input_byte(byte);
    }
}
```

协议解析单独写成状态机，环形缓冲区只负责存字节。

## 统计剩余数据长度

```c
size_t rb_available(const RingBuffer *rb)
{
    if (rb->write >= rb->read) {
        return rb->write - rb->read;
    }

    return rb->size - rb->read + rb->write;
}
```

这个函数适合调试时打印：

```c
printf("uart pending=%zu\n", rb_available(&g_uart_rx_rb));
```

如果 pending 长期接近满，说明主循环处理太慢。

## 并发注意点

如果一个中断写，一个主循环读，通常要注意：

- `read/write` 索引类型要是 CPU 能原子读写的宽度。
- 多字节变量在 8 位 MCU 上可能不是原子访问。
- 如果需要批量读写，最好短暂关闭中断保护临界区。

示例：

```c
void critical_read_example(void)
{
    uint8_t byte;

    DISABLE_IRQ();
    int ret = rb_pop(&g_uart_rx_rb, &byte);
    ENABLE_IRQ();

    if (ret == 0) {
        protocol_input_byte(byte);
    }
}
```

不要长时间关中断，只保护必要的索引操作。

## 常见坑

- 满和空判断混乱。
- 忘记容量实际是 `size - 1`。
- 中断里解析协议导致中断耗时过长。
- 缓冲区满时没有统计丢包。
- 多任务同时读写没有加锁。

## 验证方法

用 PC 程序模拟：

```bash
gcc -Wall -Wextra -g ring_buffer.c -o ring_buffer
./ring_buffer
```

测试用例建议包括：

- 空缓冲区读取。
- 写满后再写。
- 写到末尾后回绕。
- 读写交替。
- 随机 push/pop。

## 复盘

环形缓冲区是嵌入式串口接收的基本功。它的核心不是代码多复杂，而是边界要清楚：

- 谁写，谁读。
- 满了怎么办。
- 是否需要临界区。
- 协议解析放在哪里。

把这个模块写稳，后面的 AT 指令、串口屏、蓝牙模块、GPS、RS485 协议都会好处理。
