---
title: 嵌入式 C 第七篇：map 文件与 MCU 内存分布
date: 2024-04-02 11:10:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - map文件
  - 内存分布
  - MCU
description: 讲清楚 text、rodata、data、bss、heap、stack 的含义，以及如何通过 map 文件分析 Flash 和 RAM 占用。
cover: /img/covers/articles/embedded-c-map-memory.svg
top_img: /img/covers/articles/embedded-c-map-memory.svg
---

嵌入式工程师必须会看内存占用。程序能编译通过，不代表能稳定运行。Flash 不够、RAM 不够、栈溢出、全局数组太大，都会让系统出问题。

`map` 文件就是分析这些问题的重要工具。

## 常见内存区域

```text
.text    代码，一般放 Flash
.rodata  只读常量，一般放 Flash
.data    已初始化全局/静态变量，运行时在 RAM，初值在 Flash
.bss     未初始化全局/静态变量，运行时在 RAM
heap     动态分配区域
stack    函数调用栈
```

## 示例代码

```c
#include <stdint.h>

const uint8_t g_table[256] = {1, 2, 3}; // .rodata

uint8_t g_rx_buf[1024];                 // .bss
uint32_t g_counter = 10;                // .data

static uint8_t g_private_buf[512];      // .bss，static 只影响链接可见性

void func(void)
{
    uint8_t local_buf[128];             // stack
    local_buf[0] = 1;
}
```

要点：

- `const` 大表通常进 Flash。
- 未初始化全局数组进 `.bss`，占 RAM。
- 局部数组进栈。
- `static` 不等于放 Flash。

## 生成 map 文件

GCC 链接参数：

```bash
gcc main.c -Wl,-Map=firmware.map -o app
```

Arm GCC 裸机工程通常类似：

```bash
arm-none-eabi-gcc ... -Wl,-Map=build/output.map
```

Keil、IAR、STM32CubeIDE 也都能生成 map 文件。

## 看总体占用

常见输出：

```text
Memory region         Used Size  Region Size  %age Used
FLASH                 64 KB      512 KB       12.5%
RAM                   48 KB      128 KB       37.5%
```

如果 RAM 占用接近上限，要重点看：

- 大的 `.bss` 数组。
- LVGL framebuffer。
- RTOS 任务栈。
- 文件系统缓存。
- 通信缓冲区。

## 找大对象

map 文件里可以搜索：

```text
.bss
.data
.rodata
```

例如：

```text
.bss.g_rx_buf      0x20000000    0x400  uart.o
.bss.g_frame_buf   0x20000400   0x5000  lvgl_port.o
```

这里 `0x5000` 是 20KB，说明 framebuffer 占用很大。

## 栈和堆

裸机工程里通常在启动文件或链接脚本里定义：

```text
_Min_Heap_Size = 0x200;
_Min_Stack_Size = 0x400;
```

FreeRTOS 工程还要考虑每个任务栈：

```c
xTaskCreate(UiTask, "ui", 1024, NULL, 3, NULL);
```

这里的 `1024` 在 FreeRTOS 中通常是 word 数，不一定是字节。32 位 MCU 上 1024 word 是 4096 字节。

## 减少 RAM 占用

### 大表加 const

```c
static const uint16_t sine_table[1024] = {
    // 查表数据
};
```

不加 `const` 可能进 RAM。

### 避免大局部数组

```c
void bad(void)
{
    uint8_t buf[4096]; // 可能导致栈溢出
}
```

改成静态缓冲区或全局缓冲区：

```c
static uint8_t s_buf[4096];
```

但全局缓冲会占 `.bss`，要在 map 文件里确认。

### 缓冲区复用

如果两个模块不会同时使用大缓冲区，可以设计共享工作区，但要写清所有权和使用时机。

## 常见坑

- 只看 Flash，不看 RAM。
- `const` 漏写导致表进 RAM。
- 局部大数组导致栈溢出。
- FreeRTOS 任务栈单位理解错。
- map 文件里看到 `static` 就以为不占 RAM。

## 验证方法

编译后查看：

```bash
arm-none-eabi-size firmware.elf
```

输出类似：

```text
text data bss dec hex filename
```

含义：

- `text`：代码和只读数据。
- `data`：已初始化 RAM 数据。
- `bss`：未初始化 RAM 数据。

再打开 `.map` 文件，找到具体是哪个对象占用。

## 复盘

嵌入式里内存问题不是等崩溃才看。每次新增 LVGL 缓冲、文件系统缓存、通信队列、大数组，都应该看一次 map 文件。

会看 map 文件，你就能回答：

- Flash 为什么变大？
- RAM 被谁吃掉了？
- 哪个模块最占空间？
- 栈和堆还有多少余量？
