---
title: MCU开发专题：调试技术详解
date: 2024-08-05
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
cover: /img/covers/articles/mcu-debugging-guide.svg
top_img: /img/covers/articles/mcu-debugging-guide.svg
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
# 原因：调试器未检测到目标芯片
# 解决：检查接线、重启设备、更换 USB 线

# 错误：SWD Pin Error
# 原因：SWD 引脚被禁用或复用为普通 IO
# 解决：BOOT0 引脚接地，复位后重试（从系统存储器启动后可恢复 SWD）
```

---

## 3. printf 重定向到 SWO

### 初始化代码

```c
#include <stdio.h>

// SWO（Serial Wire Output）输出初始化（STM32）
// SWO 是 SWD 接口的单线跟踪输出，可在不占用 UART 的情况下输出调试信息
void SWO_Init(void) {
    // 使能 GPIOA 时钟（PA4 复用为 SWO 功能）
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;

    // 配置 PA4 为复用功能模式（MODER4=10b，即 AF 模式）
    GPIOA->MODER &= ~GPIO_MODER_MODER4;    // 先清除 MODER4 两位
    GPIOA->MODER |= GPIO_MODER_MODER4_1;   // 设置 MODER4[1]=1，即 AF 模式

    // 使能调试模块的 TRACE I/O 功能
    // DBGMCU_CR_TRACE_IOEN：将 TRACECK、TRACED 等引脚映射为调试输出
    DBGMCU->CR |= DBGMCU_CR_TRACE_IOEN;
}

// 重写 fputc，将 printf 输出重定向到 ITM（Instrumentation Trace Macrocell）
int fputc(int ch, FILE *f) {
    ITM_SendChar(ch);  // 通过 ITM 通道 0 发送字符到调试器
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
// SWO printf 使用示例：输出变量值，在 Keil Debug Viewer 中查看
printf("ADC Value: %d\n", adc_value);   // 打印 ADC 采样值（十进制）
printf("Flag = 0x%02X\n", flag);        // 打印标志位（十六进制，补齐 2 位）
```

通过 **View → Serial Windows → Debug (printf) Viewer** 查看输出。

---

## 4. 串口调试（UART）

### 基础配置

```c
#include "usart.h"

// UART 寄存器级初始化（以 USART2 为例）
void UART_Init(uint32_t baudrate) {
    // 1. 使能 USART2 和 GPIOA 的时钟
    RCC->APB1ENR |= RCC_APB1ENR_USART2EN;  // USART2 挂在 APB1 总线上
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;   // GPIOA 挂在 AHB1 总线上

    // 2. 配置 PA2=USART2_TX, PA3=USART2_RX 为复用功能 AF7
    // AFR[1] 对应引脚 8-15, 每个引脚占 4 位, PA2 在 bit[11:8], PA3 在 bit[15:12]
    GPIOA->AFR[1] |= (7 << 8) | (7 << 12);  // AF7 = USART2 复用功能

    // 3. 设置波特率（BRR = 系统时钟 / 目标波特率）
    USART2->BRR = SystemCoreClock / baudrate;

    // 4. 配置数据格式：8 位数据、无校验、1 位停止位（8N1）
    USART2->CR1 = USART_CR1_TE     // TE: Transmitter Enable（发送使能）
                | USART_CR1_RE;    // RE: Receiver Enable（接收使能）

    USART2->CR1 |= USART_CR1_UE;   // UE: USART Enable（最终使能外设）
}

// 发送单个字节（阻塞方式：等待发送完成）
void UART_SendByte(uint8_t ch) {
    USART2->DR = ch;                           // 写入数据寄存器，启动发送
    while (!(USART2->SR & USART_SR_TXE));      // 等待 TXE（发送缓冲区空）标志置位
}

// 发送字符串（逐字节阻塞发送）
void UART_SendString(char *str) {
    while (*str) {
        UART_SendByte(*str++);  // 每次发送一个字符，指针后移
    }
}
```

### printf 重定向

```c
// 重写标准库的 fputc，将 printf 输出重定向到 UART
// 编译器在链接时会使用此实现替代默认的 fputc（默认写入半主机调试通道）
int fputc(int ch, FILE *f) {
    UART_SendByte(ch);  // 通过 USART2 发送字符到 PC 串口助手
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
// 操作方法：右键断点 → Condition → 输入 (flag == 0x10)
// 原理：CPU 每次执行到此处都会评估条件表达式，只有为真时才会停下来

// 内存查看：Memory Window
// 用途：查看结构体成员布局、数组内容、栈空间使用情况
// 格式：右键→Add Memory Window，输入变量名或地址

// 寄存器查看：Registers Window
// 用途：实时查看 R0-R15 通用寄存器、PSR 程序状态寄存器、SP 栈指针
// 异常排查时重点关注 PC（程序计数器）和 LR（链接寄存器）
```

---

## 6. 常见问题排查

### 程序跑飞

```c
// 原因1：HardFault 硬件错误（最常见：非法内存访问、未对齐访问、除零）
// 解决：查看 Fault 寄存器定位错误类型
void HardFault_Handler(void) {
    volatile uint32_t hfsr = SCB->HFSR;  // HardFault 状态寄存器：记录 HardFault 原因
    volatile uint32_t cfsr = SCB->CFSR;  // 可配置故障状态寄存器：细分 MemManage/BusFault/UsageFault
    // 调试时在此处设断点，观察 hfsr 和 cfsr 的值
    // 然后查看 SP 寄存器获取栈帧，反推出错前的调用链
    while (1);  // 死循环等待调试器介入
}

// 原因2：看门狗未喂狗导致复位
// 解决：确认 WDG 初始化位置，确保喂狗周期小于看门狗超时时间

// 原因3：堆栈溢出（任务栈或中断栈不够用）
// 解决：增大 startup 文件中的 Stack_Size 或 FreeRTOS 任务栈大小
```

### 卡在 Default_Handler

```c
// 卡在 Default_Handler 的处理思路
// 查看 WWDG_Handler、BLE_Handler 等默认弱定义 handler
// 原因：外设中断被触发但中断向量表中没有注册对应的处理函数
// 解决：在中断向量表中填入正确的处理函数，或在外设初始化时使能对应的 NVIC 中断
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
