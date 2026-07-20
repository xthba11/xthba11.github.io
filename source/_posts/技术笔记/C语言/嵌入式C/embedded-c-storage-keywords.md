---
title: 嵌入式 C 第二篇：volatile、const、static、extern 的真实用法
date: 2024-03-20 10:20:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - volatile
  - const
  - static
  - extern
description: 结合寄存器、中断共享变量、多文件工程和只读配置，讲清楚嵌入式里最容易误用的四个关键字。
cover: /img/covers/articles/embedded-c-storage-keywords.svg
top_img: /img/covers/articles/embedded-c-storage-keywords.svg
---

`volatile`、`const`、`static`、`extern` 这四个关键字，几乎每个嵌入式 C 工程都会用到。它们不是背概念用的，而是直接影响编译器优化、变量生命周期、链接关系和模块边界。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS
- 目标平台：STM32 / 通用 MCU
- 编译器：GCC / Arm GCC
- 适用场景：中断、寄存器、配置表、多文件工程、驱动模块

## volatile：告诉编译器这个值会被外部改变

典型场景一：中断和主循环共享变量。

```c
#include <stdint.h>

// 这个变量会在中断里被修改，所以必须加 volatile
static volatile uint8_t g_uart_rx_done = 0;

void USART_IRQHandler(void)
{
    // 中断收到数据后设置标志位
    g_uart_rx_done = 1;
}

void main_loop(void)
{
    while (1) {
        if (g_uart_rx_done) {
            // 先清标志，再处理事件
            g_uart_rx_done = 0;
            // handle_uart_rx();
        }
    }
}
```

如果没有 `volatile`，编译器可能认为 `g_uart_rx_done` 在 `while` 循环里没人改，于是把读取优化掉。

典型场景二：寄存器访问。

```c
#include <stdint.h>

#define GPIOA_ODR_ADDR 0x40020014UL

// 外设寄存器不是普通内存，必须 volatile
#define GPIOA_ODR (*(volatile uint32_t *)GPIOA_ODR_ADDR)

void gpio_set_pin5(void)
{
    GPIOA_ODR |= (1U << 5);
}
```

`volatile` 的含义是：每次访问都真的读/写内存，不要把它优化成寄存器缓存。

注意：`volatile` 不是锁。它不能解决多任务竞争，也不能保证复合操作原子。

```c
g_count++; // 即使 g_count 是 volatile，这也不是原子操作
```

## const：表达只读意图

`const` 在嵌入式里常用于配置表、字符串、查表数据。

```c
#include <stdint.h>

typedef struct {
    uint32_t baudrate;
    uint8_t data_bits;
    uint8_t stop_bits;
} UartConfig;

// 配置表不应该在运行时被修改
static const UartConfig g_uart1_config = {
    .baudrate = 115200,
    .data_bits = 8,
    .stop_bits = 1,
};
```

`const` 还有一个常见用法：保护函数输入参数。

```c
#include <stddef.h>
#include <stdint.h>

int crc8_calc(const uint8_t *data, size_t len)
{
    uint8_t crc = 0;

    if (data == NULL) {
        return -1;
    }

    for (size_t i = 0; i < len; i++) {
        // const 表示函数承诺不修改 data 指向的数据
        crc ^= data[i];
    }

    return crc;
}
```

### const 指针常见写法

```c
const int *p1;       // p1 指向的 int 不能通过 p1 修改
int * const p2 = &x; // p2 这个指针变量不能改指向
const int * const p3 = &x; // 指针和指向的内容都不能改
```

初学者先记最常用的：

```c
void print_buf(const uint8_t *buf, size_t len);
```

表示函数只读缓冲区。

## static：限制作用域或延长生命周期

`static` 放在函数外，表示这个全局变量/函数只在当前 `.c` 文件可见。

```c
// uart_driver.c
static uint8_t g_rx_buf[128];

static void uart_reset_state(void)
{
    // 这个函数只给 uart_driver.c 内部使用
}
```

这能减少模块之间乱访问全局变量。

`static` 放在函数内，表示变量生命周期贯穿整个程序，但作用域只在函数内。

```c
#include <stdint.h>

uint32_t button_get_click_count(void)
{
    static uint32_t count = 0;

    // count 不会因为函数返回而销毁
    count++;
    return count;
}
```

函数内 `static` 适合保存私有状态，但不要滥用。RTOS 多任务同时调用时要注意并发问题。

## extern：声明别的文件里定义的变量

`extern` 表示“这个变量在别处定义，我这里只是声明”。

错误示例：

```c
// config.h
int g_system_mode = 0; // 错误：头文件里定义变量，多个 .c 包含会重复定义
```

正确写法：

```c
// config.h
#ifndef CONFIG_H
#define CONFIG_H

extern int g_system_mode; // 声明

#endif
```

```c
// config.c
#include "config.h"

int g_system_mode = 0; // 唯一定义
```

```c
// app.c
#include "config.h"

void app_set_mode(int mode)
{
    g_system_mode = mode;
}
```

工程建议：能不用全局变量就不用；必须用时，尽量通过函数接口访问。

```c
// config.h
void config_set_mode(int mode);
int config_get_mode(void);
```

## 综合示例：串口驱动状态

```c
#include <stdint.h>
#include <stddef.h>

#define UART_RX_BUF_SIZE 128

// 只在当前文件可见，避免其他模块直接改
static uint8_t g_rx_buf[UART_RX_BUF_SIZE];

// 中断会修改，所以加 volatile
static volatile size_t g_rx_len = 0;

// 只读配置，防止运行时误修改
static const uint32_t g_default_baudrate = 115200;

void uart_irq_handler(uint8_t byte)
{
    if (g_rx_len < UART_RX_BUF_SIZE) {
        g_rx_buf[g_rx_len] = byte;
        g_rx_len++;
    }
}

size_t uart_read(uint8_t *out, size_t max_len)
{
    size_t len;

    if (out == NULL) {
        return 0;
    }

    // 简化示例：真实工程中这里要关中断或进临界区
    len = g_rx_len;
    if (len > max_len) {
        len = max_len;
    }

    for (size_t i = 0; i < len; i++) {
        out[i] = g_rx_buf[i];
    }

    g_rx_len = 0;
    return len;
}
```

## 常见坑

- 以为 `volatile` 能保证线程安全。
- 把所有全局变量都写进 `.h` 文件。
- 忘记给只读表加 `const`，导致 RAM 占用变大。
- `static` 全局函数没加，导致模块内部函数暴露太多。
- `extern` 声明和实际定义类型不一致。

## 验证方法

多文件验证：

```bash
gcc -Wall -Wextra config.c app.c main.c -o keyword_demo
```

如果你把变量定义写进头文件，链接阶段很可能出现重复定义错误。

## 复盘

这四个关键字可以对应四个问题：

- `volatile`：这个值会不会被编译器看不见的地方改变？
- `const`：这个数据是否应该只读？
- `static`：这个名字是否只应该在当前文件可见？
- `extern`：这个变量是否在别的文件定义？

嵌入式工程越大，越要靠这些关键字把边界写清楚。
