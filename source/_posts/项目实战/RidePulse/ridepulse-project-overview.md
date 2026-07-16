---
title: RidePulse 自行车码表项目总览：从智能手表固件到骑行终端
date: 2026-07-16 10:30:00
categories:
  - 项目实战
  - RidePulse
  - 嵌入式
tags:
  - STM32F411
  - FreeRTOS
  - LVGL
  - 自行车码表
  - 嵌入式项目
description: 基于现有 STM32 智能手表固件，规划并改造成一个自行车码表项目，复用 LVGL、FreeRTOS、传感器、外部 Flash、OTA、低功耗和看门狗能力。
top_img: /img/covers/ridepulse-cover.svg
---

这个项目最开始不是自行车码表，而是一套基于 STM32F411 的智能手表固件。它已经具备一个穿戴设备需要的大部分底层能力：屏幕显示、触摸输入、传感器采集、FreeRTOS 多任务、外部 Flash、LittleFS、OTA、低功耗和看门狗。

我准备把它改造成一个自行车码表项目，项目名暂定为 **RidePulse**。这个系列文章会记录整个改造过程，不把它包装成一个已经完全完成的成品，而是从现有工程出发，逐步补齐码表真正需要的速度、里程、骑行状态机和骑行记录。

## 项目目标

RidePulse 的目标不是做一个简单显示速度的 demo，而是做一个比较完整的骑行数据终端：

- 实时显示当前速度、累计里程、骑行时间、心率和电量。
- 支持轮速传感器采集，通过霍尔传感器或干簧管统计车轮脉冲。
- 支持骑行状态机，能区分待机、准备、骑行、暂停和保存状态。
- 支持骑行记录保存，把每次骑行摘要写入外部 Flash。
- 保留原工程已有的传感器能力，例如心率、气压、温湿度、运动传感器。
- 保留 OTA、低功耗和看门狗，让项目更像一个真实嵌入式产品。

改造后的项目可以理解为：

```text
智能手表固件
  ├── LVGL 显示
  ├── FreeRTOS 多任务
  ├── 传感器服务
  ├── 外部 Flash / LittleFS
  ├── OTA
  ├── 低功耗
  └── 看门狗

改造成

自行车码表固件
  ├── 码表主界面
  ├── 轮速采集
  ├── 速度/里程计算
  ├── 骑行状态机
  ├── 骑行记录
  ├── 传感器扩展
  ├── OTA
  └── 低功耗与可靠性
```

## 当前工程基础

当前工程目录名为 `ec_s100_watch_V2.2_T2469`，整体上已经按照多层结构组织：

```text
ec_s100_watch_V2.2_T2469/
  Core/                         STM32CubeMX 生成的 HAL 初始化代码
  Drivers/                      STM32 HAL 与 CMSIS
  Middlewares/                  FreeRTOS、LVGL、Ymodem、公共组件
  01_APP/                       应用层：初始化、UI、显示、ISR
  02_MCU_Platform/              MCU 外设端口封装
  02_BSP_Platform/              板级驱动与传感器适配层
  02_Middleware_Platform/       LittleFS 等中间件平台移植
  03_Config/                    版本和配置
  04_Common_Utils/              算法与通用工具
  04_Debug_Tool/                RTT、EasyLogger 等调试工具
  05_Service/                   业务服务：传感器、OTA、Flash、低功耗、看门狗
  MDK-ARM/                      Keil 工程
```

这套结构的好处是比较适合继续扩展：码表的轮速采集可以放到 BSP 层，骑行数据计算可以放到 Service 层，码表 UI 可以放到 APP/LVGL 层，骑行记录可以接到外部 Flash 服务。

## 硬件与软件环境

当前工程可以按下面的环境来描述：

| 项目 | 内容 |
|---|---|
| MCU | STM32F411 |
| 开发框架 | STM32 HAL |
| RTOS | FreeRTOS |
| GUI | LVGL |
| IDE | Keil MDK / STM32CubeMX |
| 存储 | 外部 Flash + LittleFS |
| 升级 | USART + Ymodem OTA |
| 传感器 | MPU6050、心率、气压、温湿度等 |
| 调试 | 串口日志、RTT、Keil/J-Link |

如果后续改造成码表，建议新增：

| 新增模块 | 建议方案 |
|---|---|
| 轮速输入 | 霍尔传感器或干簧管 + EXTI |
| 速度计算 | 两次轮速脉冲间隔 |
| 里程累计 | 每个有效脉冲增加一圈轮径 |
| 骑行记录 | LittleFS 文件保存 |
| 码表 UI | LVGL 新增 BikeMain / BikeDetail / RideHistory 页面 |

## 已有能力怎么映射到码表

### LVGL 显示能力

原工程已有 LVGL 页面、图片资源和显示任务：

```text
01_APP/User_Display/user_display.c
01_APP/User_Display/Port/lvgl_port.c
01_APP/LVGL_ui/
```

这些可以直接复用到码表 UI。码表最重要的是一眼可读，所以 UI 改造时应该把速度放在主视觉位置：

```text
┌────────────────────┐
│       28.6          │
│        km/h         │
│                    │
│  12.4 km  00:38:21 │
│  HR 142   BAT 78%  │
└────────────────────┘
```

原工程的 `lvgl_port.c` 已经承担了 UI 与业务层之间的数据交换职责。后续应该新增类似接口：

```c
void lvgl_ride_speed_get_data(uint16_t speed_x10_kmh);     /* 写入当前速度 (km/h * 10) */
void lvgl_ride_distance_get_data(uint32_t distance_m);     /* 写入累计里程 (米) */
void lvgl_ride_time_get_data(uint32_t ride_time_s);        /* 写入骑行时长 (秒) */
```

不要让 LVGL 页面直接读传感器或全局业务状态。UI 层只负责展示，骑行数据由 `RideService` 计算后推给 UI。

### FreeRTOS 多任务能力

原工程已有任务配置表：

```text
01_APP/User_Init/User_Task_Config/user_task_reso_config.c
```

当前已经有这些典型任务：

- `Thread_5ms_Task`
- `SensorTask`
- `ExtFlashTask`
- `LVGLTask`
- `OTA_task`
- `DwAppData_task`
- `LowPower_Thread`
- `WatchDog_Thread`

后续建议新增：

```text
RideTask
```

它负责：

- 读取轮速脉冲计数。
- 计算当前速度。
- 累计里程。
- 更新骑行状态。
- 周期性推送数据给 LVGL。
- 在骑行结束时请求存储服务保存记录。

### 传感器服务能力

原工程已有传感器服务：

```text
05_Service/Service_Sensor/service_sensor.c
```

现有传感器可以在码表中这样使用：

| 已有数据 | 码表中的用途 |
|---|---|
| 心率 | 骑行强度显示 |
| 气压/海拔 | 海拔变化、爬升趋势 |
| 温湿度 | 环境信息 |
| MPU6050 | 运动检测、自动唤醒、震动检测 |
| RTC | 骑行时间、记录时间戳 |

传感器服务里已经有按 UI 页面切换采样频率的设计。例如进入心率页时提高心率采样频率，进入天气页时开启温湿度采样。码表页面也可以利用这个机制：

```c
case UI_STATE_BikeMain:
    sensor_start_sampling(SENSOR_HEARTRATE, 1000);
    sensor_start_sampling(SENSOR_PRESSURE, 2000);
    break;
```

### 外部 Flash 与 LittleFS

原工程已有外部 Flash 管理和 LittleFS：

```text
05_Service/Service_ExternflashManage/service_externflash_manage.c
02_Middleware_Platform/LittleFS/
```

这部分非常适合包装成骑行记录保存：

```text
/rides/
  ride_20260716_083000.dat
  ride_20260717_191500.dat
```

每条记录保存：

- 开始时间
- 结束时间
- 骑行时间
- 总里程
- 平均速度
- 最大速度
- 平均心率
- 最大心率

这会让项目从“实时显示数据”变成“能记录一次完整骑行”的产品形态。

### OTA 与稳定性

原工程已有 OTA 相关代码：

```text
05_Service/Service_OtaManager/service_ota_manager.c
05_Service/Service_OtaManager/Ota_FlashHandler/
Middlewares/Ymodem/
```

码表项目可以保留 OTA，作为一个完整设备的升级能力。博客里可以重点讲：

- OTA 状态机。
- 下载进度如何推给 LVGL。
- App 标志位如何防止异常升级。
- OTA 期间如何处理看门狗。

看门狗相关代码：

```text
05_Service/Service_WatchdogMonitor/service_watchdog_monitor.c
```

它已经实现任务注册、任务喂狗、硬件 IWDG 刷新、安全模式等逻辑。对于码表这种长时间运行设备，看门狗是很有展示价值的工程点。

## 新增模块规划

码表改造建议新增两个核心模块。

### 1. 轮速 BSP

目录建议：

```text
02_BSP_Platform/Bsp_Drivers/WheelSpeed/
  bsp_wheel_speed.c
  bsp_wheel_speed.h
```

职责：

- 初始化轮速 GPIO。
- 配置 EXTI 中断。
- 在中断中记录脉冲时间。
- 做基本消抖。
- 提供脉冲计数和最近脉冲时间给上层。

接口建议：

```c
void bsp_wheel_speed_init(void);                           /* 初始化轮速 GPIO 和静态变量 */
void bsp_wheel_speed_on_exti_irq(uint32_t tick_ms);        /* 由 EXTI 中断回调调用，记录脉冲时间 */
uint32_t bsp_wheel_speed_get_pulse_count(void);            /* 获取累计脉冲数 */
uint32_t bsp_wheel_speed_get_last_pulse_tick(void);        /* 获取最后一次脉冲的系统 tick */
```

注意：中断里不要做浮点计算，也不要直接操作 LVGL。

### 2. 骑行服务 RideService

目录建议：

```text
05_Service/Service_Ride/
  ride_computer.c
  ride_computer.h
```

职责：

- 管理骑行状态机。
- 计算当前速度、平均速度、最大速度。
- 累计里程。
- 统计骑行时间。
- 周期性更新 UI。
- 结束骑行时保存记录。

接口建议：

```c
void ride_computer_init(void);                  /* 初始化骑行数据结构和轮速 BSP */
void ride_computer_task(void *argument);         /* FreeRTOS 任务入口，周期更新骑行数据 */
void ride_start(void);                           /* 开始骑行：清零数据，进入 RIDING 状态 */
void ride_pause(void);                           /* 暂停骑行：速度归零，停止累计时间 */
void ride_resume(void);                          /* 恢复骑行：从 PAUSED 恢复到 RIDING */
void ride_stop_and_save(void);                   /* 结束骑行：保存记录到 LittleFS */
void ride_get_data(ride_data_t *out);            /* 读取当前骑行数据快照 */
```

## 数据流设计

改造后的数据流建议这样设计：

```text
Wheel Sensor
  |
  | EXTI interrupt
  v
BSP WheelSpeed
  |
  | pulse_count / last_pulse_tick
  v
RideService
  |
  | speed / distance / time
  +-----------> LVGL Port -----------> Bike UI
  |
  | ride_record_t
  v
ExtFlash Service + LittleFS
```

关键原则：

- 中断层只记录事件。
- RideService 负责业务计算。
- LVGL 只负责展示。
- Flash 服务负责存储。
- 不要让 UI、传感器、中断和存储互相直接调用太深。

## 骑行状态机

建议新增状态：

```c
typedef enum {
    RIDE_STATE_IDLE = 0,   /* 空闲：未进入码表页面 */
    RIDE_STATE_READY,      /* 就绪：已进入页面，等待开始 */
    RIDE_STATE_RIDING,     /* 骑行中：正在累计里程和时间 */
    RIDE_STATE_PAUSED,     /* 暂停：超时无脉冲或用户手动暂停 */
    RIDE_STATE_SAVING,     /* 保存中：骑行结束，正在写入 Flash */
} ride_state_t;
```

状态转换：

```text
IDLE
  -> READY       进入码表页面
READY
  -> RIDING      用户点击开始，或检测到轮速脉冲
RIDING
  -> PAUSED      超过 N 秒没有轮速脉冲
PAUSED
  -> RIDING      再次检测到轮速脉冲
RIDING/PAUSED
  -> SAVING      用户点击结束
SAVING
  -> IDLE        记录保存完成
```

为什么要有状态机？因为真实码表不只是算速度：

- 没开始骑行时不应该累计里程。
- 停车等红灯时应该暂停骑行时间。
- 结束时需要保存记录。
- 低功耗策略要知道当前是不是骑行中。

## 文章系列安排

这个项目建议拆成 5 篇文章：

1. **项目总览**：说明从智能手表固件到码表的改造思路。
2. **RTOS 架构**：分析任务、队列、互斥锁、信号量和看门狗。
3. **轮速计算**：实现霍尔传感器脉冲采集、速度和里程计算。
4. **LVGL 码表 UI**：实现速度大数字、里程、时间和心率显示。
5. **LittleFS 骑行记录**：把一次骑行摘要保存到外部 Flash。

后续如果继续完善，还可以再写：

- GPS 模块接入与 NMEA 解析。
- 码表低功耗策略。
- OTA 升级完整流程。
- 断电恢复与骑行记录保护。

## 第一阶段最小闭环

不要一开始就追求功能很多。第一阶段只做最小闭环：

```text
轮速输入
  -> 速度计算
  -> LVGL 显示
  -> 串口日志验证
```

验收标准：

- 手动触发轮速 GPIO 中断，串口能打印脉冲。
- 能根据脉冲间隔计算速度。
- 能累计里程。
- LVGL 页面能显示速度和里程。
- 停止触发脉冲后速度能自动归零。

建议先用按键或杜邦线模拟轮速脉冲，不急着上车测试。

## 后续改造顺序

推荐按这个顺序改：

1. 新增 `bsp_wheel_speed`，先在中断里统计脉冲。
2. 新增 `RideTask`，每 100ms 或 200ms 读取脉冲并计算速度。
3. 在 LVGL 里新增码表页面，只显示速度、里程、时间。
4. 接入心率和电量显示。
5. 用 LittleFS 保存一条骑行记录。
6. 增加历史记录页面。
7. 再考虑 GPS、海拔爬升、平均速度、最大速度等扩展。

## 写进网站时要保持真实

这个项目的优势是真实工程结构比较完整，但目前还需要补骑行核心能力。所以在项目页和文章里建议这样写：

推荐写法：

> 这个项目基于已有智能手表固件改造。当前已经完成显示、传感器、存储、OTA、低功耗和看门狗等底层能力，正在补齐码表核心的轮速采集、速度里程计算和骑行记录。

不建议写法：

> 已完整实现商用级 GPS 自行车码表。

真实地写“改造过程”，反而更像一个工程师做的项目。

## 小结

RidePulse 的价值不在于“从零写一个速度计算 demo”，而在于把一个已有穿戴设备工程改造成更明确的应用产品。这个过程会涉及 RTOS 任务划分、UI 与业务解耦、传感器采样、外部存储、OTA、低功耗和可靠性设计。

后续几篇文章会从代码层面展开，先从 FreeRTOS 架构开始，再实现轮速计算、码表 UI 和骑行记录。
