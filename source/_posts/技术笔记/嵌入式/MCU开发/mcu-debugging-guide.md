---
title: MCU开发专题：调试技术详解
date: 2026-04-28
categories:
  - 技术笔记
  - 嵌入式
  - MCU开发
  - 调试技术
tags:
  - MCU
  - STM32
  - 调试
  - J-Link
  - SWD
description: MCU 调试技术详解：J-Link、SWD、串口调试、printf 重定向
top_img: https://source.unsplash.com/1600x900/?electronics,circuit
---

## 1. 调试接口对比
---

# MCU开发专题：调试技术详解

## 1. 调试接口对比

| 接口 | 引脚数 | 速度 | 备注 |
|------|--------|------|------|
| JTAG | 20 | 中等 | 传统标准 |
| SWD | 2 | 高 | ARM 推荐 |
| SWO | 1 | 高速 | 跟踪输出 |

STM32 主要使用 SWD 接口（2 线：SWDIO + SWCLK）。

---

## 2. J-Link / ST-Link 配置

### 接线

```
MCU板  ----  J-Link
-----------------
VCC   ----  VCC
GND   ----  GND
SWCLK ----  SWCLK
SWDIO ----  SWDIO
```

### Keil 配置步骤

1. **Project → Options → Debug**
2. 选择 **CMSIS-DAP** 或 **J-LINK**
3. 点击 **Settings**
4. 勾选 **SWJ**
5. 选择 **SW** 模式
6. 确认 Max Clock（通常 10MHz）

### 常见问题

```bash
# 错误：No Debug Unit Found
# 解决：检查接线、重启设备、更换 USB 线

# 错误：SWD Pin Error
# 解决：BOOT0 引脚接地，复位后重试
```

---

## 3. printf 重定向到 SWO

### 初始化代码

```c
#include <stdio.h>

// SWO 输出初始化（STM32）
void SWO_Init(void) {
    // 使能 GPIO 时钟
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;

    // 配置 PA4 为复用功能（SWO）
    GPIOA->MODER &= ~GPIO_MODER_MODER4;
    GPIOA->MODER |= GPIO_MODER_MODER4_1;

    // 使能 TRACECK 分区
    DBGMCU->CR |= DBGMCU_CR_TRACE_IOEN;
}

// 输出字符
int fputc(int ch, FILE *f) {
    ITM_SendChar(ch);
    return ch;
}
```

### Keil 配置

1. **Project → Options → Debug → Settings → Trace**
2. 勾选 **Enable**
3. 设置 **Core Clock** = 你的 MCU 主频（如 168MHz）
4. **ETM Trace** 不勾选（SWO 不需要）

### 使用

```c
printf("ADC Value: %d\n", adc_value);
printf("Flag = 0x%02X\n", flag);
```

通过 **View → Serial Windows → Debug (printf) Viewer** 查看输出。

---

## 4. 串口调试（UART）

### 基础配置

```c
#include "usart.h"

void UART_Init(uint32_t baudrate) {
    // 使能时钟
    RCC->APB1ENR |= RCC_APB1ENR_USART2EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;

    // 配置 PA2=USART2_TX, PA3=USART2_RX
    GPIOA->AFR[1] |= (7 << 8) | (7 << 12);  // AF7

    // 波特率
    USART2->BRR = SystemCoreClock / baudrate;

    // 8N1
    USART2->CR1 = USART_CR1_TE | USART_CR1_RE;

    USART2->CR1 |= USART_CR1_UE;
}

void UART_SendByte(uint8_t ch) {
    USART2->DR = ch;
    while (!(USART2->SR & USART_SR_TXE));
}

void UART_SendString(char *str) {
    while (*str) {
        UART_SendByte(*str++);
    }
}
```

### printf 重定向

```c
// 覆盖 fputc
int fputc(int ch, FILE *f) {
    UART_SendByte(ch);
    return ch;
}
```

### RS232/USB 转接

```
MCU UART → TTL 转 USB 模块 → PC 串口助手
```

常用工具：Xshell、SecureCRT、MobaXterm

---

## 5. 断点调试技巧

### 断点类型

| 类型 | 说明 | 适用场景 |
|------|------|---------|
| 软件断点 | 修改内存 | 任意位置 |
| 硬件断点 | CPU 核 | Flash 中必须用硬件 |
| 条件断点 | 满足条件触发 | 大循环中特定值 |
| 数据断点 | 内存变化时停 | 检测变量被改 |

### Keil 调试技巧

```c
// 条件断点示例：在 flag 变为 0x10 时停止
// 右键断点 → Condition → (flag == 0x10)

// 内存查看：Memory Window
// 格式：查看结构体 / 数组

// 寄存器查看：Registers Window
// 实时查看 R0-R15, PSR
```

---

## 6. 常见问题排查

### 程序跑飞

```c
// 原因1：HardFault
// 解决：查看 Fault 寄存器
void HardFault_Handler(void) {
    volatile uint32_t hfsr = SCB->HFSR;
    volatile uint32_t cfsr = SCB->CFSR;
    while (1);
}

// 原因2：看门狗未喂狗
// 解决：确认 WDG 初始化位置

// 原因3：堆栈溢出
// 解决：增大 Stack 大小
```

### 卡在 Default_Handler

```c
// 查看 WWDG_Handler、BLED_Handler 等
// 通常是外设中断未使能但触发了中断
// 解决：在中断向量表中填入正确处理函数
```

### 下载后不运行

1. 检查 BOOT0 引脚（应接地）
2. 检查复位电路
3. 确认 Flash 下载成功（无加密）

---

## 总结

| 调试方式 | 优点 | 缺点 |
|---------|------|------|
| J-Link + SWD | 支持断点、寄存器、内存 | 需要工具 |
| SWO + printf | 轻量、实时 | 只能输出 |
| UART + printf | PC 端查看方便 | 需要 TTL 转 USB |
| 串口助手 | 直观 | 占用硬件资源 |

> **调试原则**：先用简单方式定位问题，再用专业工具深入分析。
