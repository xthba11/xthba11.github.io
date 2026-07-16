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

这篇文章记录一种适合中小型 STM32 项目的工程结构。这里的背景是我手里的 STM32F411 智能手表固件，它后续要改造成 RidePulse 自行车码表：既要保留 LVGL、FreeRTOS、传感器、LittleFS、OTA 和看门狗，又要新增轮速采集、骑行状态机和骑行记录。如果工程结构不先整理，后面每加一个功能都会牵动一堆文件。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS / Windows STM32CubeIDE 均可，文章以通用 STM32 HAL 工程结构描述。
- 目标板/芯片：STM32F411 系列，来自现有智能穿戴设备工程。
- 内核/SDK/编译器版本：STM32Cube HAL，FreeRTOS，Arm GNU Toolchain 或 STM32CubeIDE 内置 GCC。
- 使用工具：STM32CubeMX、STM32CubeIDE、J-Link/ST-Link、串口调试助手、逻辑分析仪。
- 关联项目：RidePulse 自行车码表改造，计划复用 LVGL、LittleFS、外部 Flash、Ymodem OTA、低功耗和看门狗。

我建议每次调整工程结构后都做一次最小回归：

```text
1. 能正常下载固件
2. 串口日志能输出启动信息
3. LVGL 页面能刷新
4. 传感器任务能采样
5. 看门狗不会误复位
```

## 问题背景

原始手表工程已经包含不少模块：屏幕、触摸、心率、气压、温湿度、运动传感器、外部 Flash、文件系统、OTA、低功耗、看门狗。把它包装成自行车码表时，不能简单把轮速计算代码塞进 `main.c` 或某个页面文件里。

更合理的拆法是：

```text
轮速传感器 EXTI/TIM 输入 -> BSP/Driver
速度里程计算 -> App/Ride
骑行状态机 -> App/Ride
码表页面刷新 -> UI/LVGL
骑行记录保存 -> Storage/LittleFS
异常和复位原因 -> System/Monitor
```

这样写博客时也更像真实工程：每篇文章都能对应一个目录、一个模块和一组验证方法，而不是泛泛讲“STM32 工程要分层”。

## 验证方法

工程结构调整后，我通常按模块做验证，而不是只看能不能编译通过。

```bash
# 如果工程支持 Makefile/CMake，可以先做全量编译
make clean
make -j
```

板端下载后观察串口日志：

```text
[BOOT] reset_reason=POR
[BSP] gpio init ok
[BSP] uart init ok
[APP] ride module init ok
[UI] lvgl start
[FS] littlefs mount ok
```

RidePulse 相关模块可以这样验：

- 拔掉轮速传感器：速度应保持 0，状态为 `RIDE_IDLE`。
- 手动触发 EXTI 或用信号源模拟脉冲：速度应随周期变化。
- 切换 LVGL 码表页面：UI 只能读取快照数据，不能直接访问 EXTI 变量。
- 模拟骑行结束：LittleFS 中生成一条记录，重启后还能读取。
- 故意让某个任务不喂狗：系统监控能打印任务心跳异常。

## 复盘

我自己整理这类工程时，最容易犯的错误是“目录分了，但依赖没分”。比如 UI 文件直接包含传感器驱动头文件，存储模块直接访问 LVGL 对象，最后目录看着很清楚，实际还是互相缠在一起。

后面我会按这几个规则约束 RidePulse：

- BSP 只处理板级差异，不写业务判断。
- Driver 只负责器件读写，不决定页面怎么显示。
- App 层维护业务状态，例如骑行中、暂停、结束、告警。
- UI 层只读取快照，不直接控制硬件。
- Storage 层只保存结构化记录，不关心当前显示在哪个页面。
- 中断里只投递事件，不做速度浮点计算、不写 Flash、不刷新 UI。

这样做的代价是前期文件会多一点，但后面写博客、定位 bug、替换硬件都会轻松很多。

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
