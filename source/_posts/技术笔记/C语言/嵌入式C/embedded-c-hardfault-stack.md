---
title: 嵌入式 C 第八篇：HardFault 和栈溢出定位
date: 2024-07-08 11:20:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - HardFault
  - 栈溢出
  - 调试
description: 从空指针、越界、未对齐访问和栈溢出出发，整理 Cortex-M HardFault 的常见原因和定位步骤。
cover: /img/covers/articles/embedded-c-hardfault-stack.svg
top_img: /img/covers/articles/embedded-c-hardfault-stack.svg
---

嵌入式调试里最让人头疼的现象之一是 HardFault。程序突然跳进 HardFault_Handler，串口没日志，屏幕不刷新，任务停住。

HardFault 不是原因，而是结果。它通常说明 CPU 遇到了无法继续执行的异常。

## 常见原因

- 空指针或野指针访问。
- 数组越界破坏栈。
- 函数指针错误。
- 栈溢出。
- 未对齐访问。
- 访问非法地址。
- 中断优先级配置错误。

## 最小错误例子

```c
void bad_null_pointer(void)
{
    int *p = 0;

    // 访问地址 0，通常会触发异常
    *p = 10;
}
```

数组越界：

```c
void bad_overflow(void)
{
    int arr[4];

    for (int i = 0; i < 100; i++) {
        // 越界写会破坏栈上的其他数据
        arr[i] = i;
    }
}
```

函数指针错误：

```c
typedef void (*func_t)(void);

void bad_func_pointer(void)
{
    func_t fn = (func_t)0x12345678;

    // 跳到错误地址执行
    fn();
}
```

## HardFault 现场信息

Cortex-M 进入异常时，会自动压栈部分寄存器：

```text
R0 R1 R2 R3 R12 LR PC xPSR
```

其中 PC 最关键，它表示异常发生时准备执行的地址。

一个常见 HardFault handler：

```c
__attribute__((naked)) void HardFault_Handler(void)
{
    __asm volatile
    (
        "tst lr, #4                        \n"
        "ite eq                            \n"
        "mrseq r0, msp                     \n"
        "mrsne r0, psp                     \n"
        "b hardfault_c_handler             \n"
    );
}

void hardfault_c_handler(uint32_t *stack)
{
    volatile uint32_t r0  = stack[0];
    volatile uint32_t r1  = stack[1];
    volatile uint32_t r2  = stack[2];
    volatile uint32_t r3  = stack[3];
    volatile uint32_t r12 = stack[4];
    volatile uint32_t lr  = stack[5];
    volatile uint32_t pc  = stack[6];
    volatile uint32_t psr = stack[7];

    (void)r0;
    (void)r1;
    (void)r2;
    (void)r3;
    (void)r12;
    (void)lr;
    (void)pc;
    (void)psr;

    while (1) {
        // 在调试器里查看 pc/lr 等变量
    }
}
```

用调试器暂停后看 `pc`，再对照 map 文件或反汇编，就能找到崩溃附近的代码。

## 栈溢出

栈溢出很隐蔽。比如：

```c
void task_func(void)
{
    uint8_t big_buf[4096]; // 任务栈可能不够

    big_buf[0] = 1;
}
```

FreeRTOS 中要打开栈检查：

```c
#define configCHECK_FOR_STACK_OVERFLOW 2

void vApplicationStackOverflowHook(TaskHandle_t task, char *name)
{
    // 打印任务名，然后停住
    printf("stack overflow: %s\n", name);
    taskDISABLE_INTERRUPTS();
    while (1) {
    }
}
```

检查任务栈高水位：

```c
void print_stack_watermark(void)
{
    UBaseType_t remain = uxTaskGetStackHighWaterMark(NULL);

    // remain 越小，说明剩余栈越少
    printf("stack remain word=%lu\n", (unsigned long)remain);
}
```

注意 FreeRTOS 的栈单位通常是 word。

## 定位步骤

1. 先看最近改了什么。
2. 用调试器停在 HardFault。
3. 读取 stacked PC 和 LR。
4. 查 map 文件，确认 PC 落在哪个函数附近。
5. 检查该函数里的指针、数组、函数指针、大局部变量。
6. 如果是 RTOS，检查任务栈高水位。
7. 如果偶发，打开更多日志和断言。

## 防御性写法

参数判空：

```c
int sensor_read(int *out)
{
    if (out == NULL) {
        return -1;
    }

    *out = 123;
    return 0;
}
```

边界检查：

```c
int copy_data(uint8_t *dst, size_t dst_size, const uint8_t *src, size_t len)
{
    if (dst == NULL || src == NULL) {
        return -1;
    }

    if (len > dst_size) {
        return -2;
    }

    for (size_t i = 0; i < len; i++) {
        dst[i] = src[i];
    }

    return 0;
}
```

断言：

```c
#define ASSERT_PARAM(expr)        \
    do {                          \
        if (!(expr)) {            \
            while (1) {           \
            }                     \
        }                         \
    } while (0)
```

## 常见坑

- HardFault 后只复位，不保留现场。
- 大数组放任务栈。
- 中断栈和任务栈混淆。
- 只加大栈，不定位谁在吃栈。
- 关闭编译告警，错过指针类型问题。

## 验证方法

在可控 demo 里故意制造空指针或栈溢出，确认 handler 能抓到 PC。

真实项目里建议记录：

- 异常类型寄存器。
- stacked PC/LR。
- 当前任务名。
- 最近一次系统状态。

## 复盘

HardFault 定位的核心是保存现场，而不是猜。只要能拿到 PC、LR、当前任务和 map 文件，很多问题都能缩小到具体函数。

平时写代码时，参数判空、边界检查、减少大局部数组，是减少 HardFault 的第一道防线。
