---
title: 嵌入式 C 第一篇：位操作与寄存器控制
date: 2026-07-17 10:10:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - 嵌入式
  - 位操作
  - 寄存器
description: 从置位、清零、取反、读取位到寄存器读改写，讲清楚嵌入式 C 最常用的位操作模式。
cover: /img/covers/articles/embedded-c-bit-register.svg
top_img: /img/covers/articles/embedded-c-bit-register.svg
---

嵌入式 C 和普通 C 最大的区别之一是：嵌入式 C 经常要直接控制硬件寄存器。

GPIO 输出高低电平、使能外设时钟、配置中断触发方式、读取状态标志，本质上都是在操作寄存器里的某几位。位操作不熟，寄存器代码就只能靠抄。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS，可用普通 C 程序模拟寄存器。
- 目标平台：STM32 / RK3568 / 通用 MCU 思路一致。
- 编译器：GCC / Arm GCC。
- 使用工具：`gcc -Wall -Wextra -g`、串口日志、调试器寄存器窗口。

## 问题背景

一个 32 位寄存器可以看成 32 个开关：

```text
bit31 ... bit3 bit2 bit1 bit0
```

例如 GPIO 输出寄存器中：

- bit0 控制 PA0。
- bit1 控制 PA1。
- bit5 控制 PA5。

我们通常不是一次改完整个寄存器，而是只改其中几位，同时保持其他位不变。

## 基础位操作

### 置位

```c
reg |= (1U << 5);
```

含义：把 bit5 设置为 1，其他位保持不变。

### 清零

```c
reg &= ~(1U << 5);
```

含义：把 bit5 清成 0，其他位保持不变。

### 取反

```c
reg ^= (1U << 5);
```

含义：bit5 原来是 0 变 1，原来是 1 变 0。

### 判断某一位

```c
if (reg & (1U << 5)) {
    // bit5 为 1
}
```

完整示例：

```c
#include <stdint.h>
#include <stdio.h>

#define BIT(n) (1U << (n))

int main(void)
{
    uint32_t reg = 0;

    reg |= BIT(5);       // 置位 bit5
    reg &= ~BIT(5);      // 清零 bit5
    reg ^= BIT(2);       // 翻转 bit2

    if (reg & BIT(2)) {  // 判断 bit2 是否为 1
        printf("bit2 is set\n");
    }

    return 0;
}
```

## 多位字段操作

很多寄存器不是单个 bit，而是几个 bit 组成字段。

例如：

```text
MODE[1:0]
00 输入
01 输出
10 复用
11 模拟
```

设置字段不能只 `|=`，必须先清掉旧值，再写入新值。

```c
#include <stdint.h>

#define GPIO_MODE_SHIFT(pin) ((pin) * 2U)
#define GPIO_MODE_MASK(pin)  (0x3U << GPIO_MODE_SHIFT(pin))
#define GPIO_MODE_OUTPUT     0x1U

void gpio_set_output_mode(uint32_t *moder, uint32_t pin)
{
    uint32_t shift = GPIO_MODE_SHIFT(pin);

    // 先清除该 pin 对应的 2 个模式位
    *moder &= ~GPIO_MODE_MASK(pin);

    // 再写入 01，表示输出模式
    *moder |= (GPIO_MODE_OUTPUT << shift);
}
```

这里最关键的是“先清再写”。如果只写：

```c
*moder |= (GPIO_MODE_OUTPUT << shift);
```

旧值可能还留着，字段最终不是你想要的值。

## 模拟寄存器控制 LED

下面用普通变量模拟 GPIO 寄存器：

```c
#include <stdint.h>
#include <stdio.h>

#define BIT(n) (1U << (n))

typedef struct {
    uint32_t MODER;  // 模式寄存器
    uint32_t ODR;    // 输出数据寄存器
    uint32_t IDR;    // 输入数据寄存器
} GPIO_TypeDef;

static GPIO_TypeDef GPIOA_SIM;

void led_init(GPIO_TypeDef *gpio, uint32_t pin)
{
    uint32_t shift = pin * 2U;

    // 每个 pin 用 2 bit 表示模式，这里先清除旧模式
    gpio->MODER &= ~(0x3U << shift);

    // 写入 01，表示输出模式
    gpio->MODER |= (0x1U << shift);
}

void led_on(GPIO_TypeDef *gpio, uint32_t pin)
{
    // 输出寄存器对应位写 1
    gpio->ODR |= BIT(pin);
}

void led_off(GPIO_TypeDef *gpio, uint32_t pin)
{
    // 输出寄存器对应位写 0
    gpio->ODR &= ~BIT(pin);
}

int main(void)
{
    led_init(&GPIOA_SIM, 5);
    led_on(&GPIOA_SIM, 5);

    printf("MODER=0x%08X ODR=0x%08X\n", GPIOA_SIM.MODER, GPIOA_SIM.ODR);

    led_off(&GPIOA_SIM, 5);
    printf("MODER=0x%08X ODR=0x%08X\n", GPIOA_SIM.MODER, GPIOA_SIM.ODR);

    return 0;
}
```

真实 MCU 中，`GPIOA_SIM` 会换成寄存器基地址映射出来的结构体。

## 读改写风险

这类代码很常见：

```c
reg |= BIT(5);
```

它实际不是一个动作，而是三个动作：

```text
读 reg
修改 bit5
写回 reg
```

如果寄存器某些位是“写 1 清除”，或者在中断里也会改同一个寄存器，就要小心读改写带来的副作用。

很多 MCU 提供专门的置位/清零寄存器，例如 STM32 的 `BSRR`：

```c
// 低 16 位写 1 表示置位
GPIOA->BSRR = BIT(5);

// 高 16 位写 1 表示清零
GPIOA->BSRR = BIT(5 + 16);
```

这种写法比直接改 `ODR` 更安全。

## 常见坑

- 忘记加 `U`：`1 << 31` 可能触发有符号整数问题，建议写 `1U << 31`。
- 清字段前没有先 mask，导致旧配置残留。
- 把 `|=` 用在需要覆盖的字段上。
- 对有特殊含义的状态寄存器做普通读改写。
- 忘记寄存器指针需要 `volatile`。

## 验证方法

保存为 `bit_register.c`：

```bash
gcc -Wall -Wextra -g bit_register.c -o bit_register
./bit_register
```

在真实 MCU 上验证时，建议同时看：

- 串口打印的寄存器值。
- 调试器寄存器窗口。
- 逻辑分析仪或示波器上的 GPIO 波形。

## 复盘

位操作的核心不是记公式，而是知道你要改哪几位、保留哪几位。

嵌入式里最常见的安全模式是：

```c
reg &= ~MASK;          // 清掉目标字段
reg |= value << shift; // 写入新字段
```

学会这个模式，外设寄存器、协议字段、状态标志都会清晰很多。
