---
title: STM32 工程结构设计：从能跑到好维护
date: 2026-04-29
categories:
  - 技术笔记
  - 嵌入式
  - MCU开发
  - 工程架构
tags:
  - MCU
  - STM32
  - 工程架构
  - BSP
  - HAL
description: 如何组织一个可维护的 STM32 工程：目录结构、BSP、驱动层、应用层、日志和错误处理。
top_img: /img/embedded-lab-hero.png
---

很多 MCU 项目一开始只是点灯、读传感器、发串口，代码都写在 `main.c` 里也能跑。但项目一旦加入通信协议、状态机、低功耗、Bootloader、异常恢复，混在一起的代码会很快失控。

这篇文章记录一种适合中小型 STM32 项目的工程结构。

## 设计目标

一个可维护的 MCU 工程至少要满足这些要求：

- 硬件相关代码集中在 BSP 层，换板子时改动范围可控
- 外设驱动和业务逻辑分离，避免应用层直接操作寄存器细节
- 日志、错误码、状态机、配置参数有统一约定
- 中断里只做最少工作，复杂逻辑放到主循环或 RTOS 任务
- 每个模块能单独验证，不依赖整个系统都跑起来

## 推荐目录结构

```text
project/
├── App/
│   ├── app_main.c
│   ├── app_state.c
│   └── app_config.h
├── BSP/
│   ├── bsp_gpio.c
│   ├── bsp_uart.c
│   ├── bsp_timer.c
│   └── bsp_board.h
├── Drivers/
│   ├── sensor_xxx.c
│   ├── motor_driver.c
│   └── protocol_uart.c
├── Middleware/
│   ├── ring_buffer.c
│   ├── log.c
│   └── crc16.c
├── Core/
│   ├── Inc/
│   └── Src/
└── README.md
```

## 分层职责

### BSP 层

BSP 只描述板级硬件差异，例如某个 LED 接在哪个 GPIO、某个 UART 用哪个实例、某个传感器的片选脚在哪里。

```c
// bsp_board.h
#define LED_RUN_GPIO_PORT      GPIOC
#define LED_RUN_GPIO_PIN       GPIO_PIN_13

#define DEBUG_UART_HANDLE      huart1
#define SENSOR_SPI_HANDLE      hspi1
```

```c
// bsp_gpio.c
void BSP_LED_Set(uint8_t on)
{
    HAL_GPIO_WritePin(
        LED_RUN_GPIO_PORT,
        LED_RUN_GPIO_PIN,
        on ? GPIO_PIN_RESET : GPIO_PIN_SET
    );
}
```

这样应用层只关心 `BSP_LED_Set(1)`，不关心 LED 是高电平亮还是低电平亮。

### Driver 层

Driver 层封装具体器件或协议。例如温度传感器、电机驱动、串口协议解析。

```c
typedef struct {
    int16_t temperature_x10;
    uint16_t humidity_x10;
    uint8_t valid;
} sensor_data_t;

int Sensor_Read(sensor_data_t *out);
```

好的驱动接口要避免泄漏硬件细节。应用层不应该知道传感器内部寄存器地址，也不应该直接拼 SPI 命令。

### Middleware 层

Middleware 放可复用组件，例如环形缓冲区、CRC、日志系统、命令行解析器。

```c
typedef struct {
    uint8_t *buf;
    uint16_t size;
    uint16_t read;
    uint16_t write;
} ring_buffer_t;

uint16_t RingBuffer_Write(ring_buffer_t *rb, const uint8_t *data, uint16_t len);
uint16_t RingBuffer_Read(ring_buffer_t *rb, uint8_t *out, uint16_t len);
```

这类代码尽量不要依赖 HAL，方便在 PC 上做单元测试。

## main 函数应该做什么

`main.c` 最好只保留系统初始化和主循环调度。

```c
int main(void)
{
    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART1_UART_Init();
    MX_TIM2_Init();

    BSP_Init();
    Log_Init();
    App_Init();

    while (1) {
        App_Poll();
        Log_Poll();
        Watchdog_Feed();
    }
}
```

如果使用 RTOS，主循环会变成任务创建和调度器启动。

## 错误码设计

不要让每个模块随手返回 `0/-1`，建议定义统一错误码。

```c
typedef enum {
    ERR_OK = 0,
    ERR_TIMEOUT = -1,
    ERR_INVALID_PARAM = -2,
    ERR_NO_MEMORY = -3,
    ERR_HW_FAULT = -4,
    ERR_BUSY = -5,
} error_t;
```

错误码的价值在于：日志里能知道失败原因，调用方能做不同处理。

## 日志建议

嵌入式日志要控制成本。建议至少分级：

```c
#define LOGE(fmt, ...) Log_Print("E", __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#define LOGW(fmt, ...) Log_Print("W", __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#define LOGI(fmt, ...) Log_Print("I", __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#define LOGD(fmt, ...) Log_Print("D", __FILE__, __LINE__, fmt, ##__VA_ARGS__)
```

生产版本可以关闭 `LOGD`，保留关键错误和状态切换。

## 中断处理原则

中断里尽量只做三件事：

- 读取必要状态
- 清除中断标志
- 投递事件或设置标志位

不要在中断里做复杂解析、长时间循环、阻塞式串口打印。

```c
volatile uint8_t uart_rx_event = 0;

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
    if (huart == &huart1) {
        uart_rx_event = 1;
    }
}
```

真正的协议解析放到主循环或任务里处理。

## 小结

工程结构的目标不是“目录看起来高级”，而是让项目在变复杂后依然能定位问题、替换模块、复用代码。

我的经验是：当你第二次复制某段外设代码时，就该考虑抽 BSP；当你第三次手写同类缓冲逻辑时，就该抽 Middleware；当状态判断开始散落在多个文件时，就该做状态机。
