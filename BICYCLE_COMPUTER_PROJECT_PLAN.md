# 自行车码表项目包装与落地计划

## 项目定位

把 `ec_s100_watch_V2.2_T2469` 包装成一个“基于 STM32F411 的自行车码表/骑行数据终端”项目。

这个项目不能简单写成“我做了一个码表成品”，因为当前代码本质上是智能手表/穿戴设备工程。更真实、更可信的表述应该是：

> 基于已有智能穿戴设备固件工程，将其改造成自行车码表：复用 LVGL 显示、FreeRTOS 任务调度、传感器采集、外部 Flash、OTA、低功耗和看门狗能力，新增骑行速度、里程、骑行记录和码表 UI。

这样写既不会夸大，又能突出真实工程量。

## 当前项目可包装的核心能力

### 1. MCU 与系统框架

项目基于 STM32F411，使用 STM32 HAL、FreeRTOS、CMSIS-RTOS 风格接口和 Keil MDK 工程。

可以在网站中强调：

- STM32F411 嵌入式固件开发
- FreeRTOS 多任务调度
- OSAL 抽象层
- 队列、互斥锁、信号量、事件组
- 任务优先级规划
- 低功耗状态机
- 独立看门狗 + 软件看门狗

相关代码：

- `Core/Src/main.c`
- `Core/Inc/FreeRTOSConfig.h`
- `01_APP/User_Init/User_Task_Config/user_task_reso_config.c`
- `05_Service/Service_5ms_Cycle/service_5ms_cycle.c`
- `05_Service/Service_WatchdogMonitor/service_watchdog_monitor.c`

### 2. 显示与交互

项目已有 LVGL UI、触摸输入、页面切换、传感器数据刷新接口。

可以包装成码表的显示能力：

- 主骑行页：速度、里程、时间、心率、电量
- 数据页：海拔、气压、温湿度、步数/运动状态
- 设置页：亮度、系统更新、校准、低功耗
- OTA 页：固件升级进度

相关代码：

- `01_APP/User_Display/user_display.c`
- `01_APP/User_Display/Port/lvgl_port.c`
- `01_APP/LVGL_ui/`
- `01_APP/LVGL_ui/images/`

### 3. 传感器采集

项目已有多类传感器服务，适合转成骑行数据采集模块。

已有能力：

- 温湿度传感器
- 气压/海拔数据
- 心率数据
- MPU6050 加速度/陀螺仪数据
- 步数/运动检测算法
- UI 页面进入后按需开启对应传感器采样

相关代码：

- `05_Service/Service_Sensor/service_sensor.c`
- `05_Service/Service_Sensor/SportMonitor/sport_monitor.c`
- `04_Common_Utils/02_Step_Algorithm/step_algo.c`
- `04_Common_Utils/03_Heart_Algorithm/heartRate.c`
- `02_BSP_Platform/Bsp_Integration/mpu6050_Integration/`

### 4. 外部 Flash 与骑行记录

项目已经有外部 Flash 管理和 LittleFS，可包装成“骑行记录存储”的基础。

已有能力：

- 外部 Flash 读写
- LittleFS 挂载、格式化和文件读写
- LVGL 资源读取
- OTA 数据写入
- Flash 互斥访问

可以改造成：

- 每次骑行生成一个记录文件
- 存储开始时间、结束时间、总里程、平均速度、最大速度、心率区间
- 存储最近 N 次骑行摘要

相关代码：

- `05_Service/Service_ExternflashManage/service_externflash_manage.c`
- `02_Middleware_Platform/LittleFS/`
- `02_BSP_Platform/Bsp_Drivers/`

### 5. OTA 与产品完整度

项目已有 Ymodem、串口接收、双区/标志位式 OTA 逻辑和 OTA UI 状态交互。

可以包装成：

- 码表固件升级能力
- OTA 进度显示
- 升级状态机
- 失败保护和版本管理

相关代码：

- `05_Service/Service_OtaManager/service_ota_manager.c`
- `05_Service/Service_OtaManager/Ota_FlashHandler/`
- `Middlewares/Ymodem/`
- `03_Config/Smart_WatchVersion/`

### 6. 稳定性与低功耗

项目已有系统状态管理、低功耗、RTC 唤醒、软件看门狗、硬件 IWDG。

可以包装成骑行终端的可靠性设计：

- 长时间运行防卡死
- 空闲自动息屏/低功耗
- 任务级心跳监控
- 异常复位计数
- 安全模式

相关代码：

- `05_Service/Service_PowerManage/LowPowerMonitor/`
- `05_Service/Service_5ms_Cycle/Moudle_Task/SystemStateManage/`
- `05_Service/Service_WatchdogMonitor/service_watchdog_monitor.c`
- `Core/Src/rtc.c`

## 码表项目需要新增或改造的功能

### 必须新增：速度与里程

码表最核心的数据是速度和里程。当前代码里没有看到完整的 GPS 或轮速传感器逻辑，所以需要明确补一个方案。

推荐两种方案：

| 方案 | 实现方式 | 优点 | 缺点 |
|---|---|---|---|
| 轮速霍尔传感器 | 车轮磁铁 + 霍尔/干簧管 + EXTI 中断计数 | 实现简单，适合 STM32，码表味最强 | 需要外接传感器，轮径需要校准 |
| GPS 模块 | UART 读取 NMEA 数据，解析速度/位置 | 可记录轨迹，展示效果强 | 功耗高，室内调试不方便，解析工作量更大 |

建议第一阶段用“霍尔轮速方案”，因为它最贴合嵌入式基础能力，也最容易写出真实调试过程。

### 轮速计算设计

新增模块建议命名：

```text
05_Service/Service_Ride/
  ride_computer.c
  ride_computer.h

02_BSP_Platform/Bsp_Drivers/WheelSpeed/
  bsp_wheel_speed.c
  bsp_wheel_speed.h
```

核心数据结构：

```c
typedef struct {
    uint32_t wheel_circumference_mm;
    uint32_t pulse_count;
    uint32_t last_pulse_tick;
    uint32_t current_speed_x10_kmh;
    uint32_t distance_m;
    uint32_t ride_time_s;
    uint32_t max_speed_x10_kmh;
    uint32_t avg_speed_x10_kmh;
} ride_data_t;
```

计算逻辑：

- 每次轮速中断记录脉冲时间。
- 两次脉冲间隔 `delta_ms` 用来计算瞬时速度。
- 每个脉冲增加一圈轮径距离。
- 超过一定时间没有脉冲，速度归零。
- UI 每 200ms 或 500ms 刷新一次骑行数据。

速度公式：

```text
speed_kmh = wheel_circumference_mm / delta_ms * 3.6
```

如果用定点数：

```text
speed_x10_kmh = wheel_circumference_mm * 36 / delta_ms
```

### 建议新增：骑行状态机

新增骑行状态：

```text
IDLE
  -> READY
  -> RIDING
  -> PAUSED
  -> SAVING
  -> IDLE
```

状态含义：

- `IDLE`：未开始骑行，低频刷新。
- `READY`：用户进入码表页，等待开始。
- `RIDING`：检测到轮速脉冲或用户点击开始。
- `PAUSED`：长时间无脉冲，自动暂停。
- `SAVING`：结束骑行，写入 LittleFS。

### 建议新增：骑行记录文件

基于 LittleFS 新增骑行记录：

```text
/rides/
  ride_20260716_083000.dat
  ride_20260717_191500.dat
```

记录内容：

```c
typedef struct {
    uint32_t start_timestamp;
    uint32_t end_timestamp;
    uint32_t distance_m;
    uint32_t ride_time_s;
    uint32_t avg_speed_x10_kmh;
    uint32_t max_speed_x10_kmh;
    uint16_t avg_heart_rate;
    uint16_t max_heart_rate;
} ride_record_t;
```

网站文章里可以写成“外部 Flash + LittleFS 保存骑行历史记录”。

### 建议新增：码表 UI 页面

新增或改造 LVGL 页面：

```text
BikeMain
  当前速度
  本次里程
  骑行时间
  心率
  电量

BikeDetail
  平均速度
  最大速度
  海拔/气压
  温度

RideHistory
  最近骑行记录
```

视觉建议：

- 速度数字最大，放屏幕中心。
- 单位 `km/h` 小一号。
- 里程、时间、心率放底部三栏。
- 使用深色背景，骑行场景下对比度更高。
- 不要写太多说明文字，码表 UI 要一眼可读。

## 网站中的包装方式

### 项目名称建议

推荐名称：

> RidePulse：基于 STM32F411 的自行车码表

备选：

- `BikeMeter-STM32`
- `RideDash`
- `STM32 Cycling Computer`
- `FreeRTOS Bike Computer`

中文页面可写：

> RidePulse 自行车码表：一个从智能手表固件改造而来的骑行数据终端

### 项目一句话介绍

推荐文案：

> 基于 STM32F411、FreeRTOS 和 LVGL 开发的自行车码表项目，支持骑行数据采集、实时显示、心率/气压等传感器扩展、外部 Flash 记录、低功耗和 OTA 升级。

### 项目页结构

在 `source/projects/index.md` 中新增一个项目条目：

```markdown
## RidePulse：STM32 自行车码表

### 项目背景

这个项目来源于我之前做的一套 STM32 智能手表固件。原工程已经具备 LVGL 显示、FreeRTOS 多任务、传感器采集、外部 Flash、OTA 和低功耗能力，因此我计划将它改造成一个自行车码表，用来记录速度、里程、骑行时间和心率等数据。

### 当前状态

- 已完成：系统框架、LVGL UI、传感器服务、外部 Flash、LittleFS、OTA、低功耗、看门狗。
- 改造中：码表主界面、轮速采集、骑行状态机。
- 计划补充：骑行记录、历史数据页面、速度校准、异常断电恢复。

### 技术栈

- MCU：STM32F411
- RTOS：FreeRTOS
- GUI：LVGL
- 存储：外部 Flash + LittleFS
- 通信/升级：USART + Ymodem OTA
- 传感器：MPU6050、心率、气压、温湿度，后续增加轮速霍尔传感器

### 我负责/重点实现

- FreeRTOS 任务与资源配置
- LVGL 页面与传感器数据交互
- 传感器采样策略
- 外部 Flash 与 LittleFS 存储验证
- OTA 状态机与升级 UI
- 看门狗与低功耗策略梳理
```

### 推荐写成 5 篇文章

#### 文章 1：项目总览

标题：

> RidePulse 自行车码表项目总览：从智能手表固件到骑行终端

内容：

- 为什么选择把手表工程改造成码表
- 硬件资源
- 软件架构
- 已完成能力
- 待改造能力
- 系统任务图

重点展示：

- `user_task_reso_config.c` 任务表
- LVGL UI 图片
- 传感器服务
- 外部 Flash/OTA/看门狗

#### 文章 2：FreeRTOS 架构

标题：

> STM32 码表的 FreeRTOS 任务划分：显示、传感器、存储、OTA 与看门狗

内容：

- 为什么拆这些任务
- 每个任务优先级
- 队列/互斥锁/信号量用途
- 哪些任务需要喂软件看门狗
- 哪些任务可以暂停进入低功耗

重点代码：

- `01_APP/User_Init/User_Task_Config/user_task_reso_config.c`
- `05_Service/Service_WatchdogMonitor/service_watchdog_monitor.c`

#### 文章 3：码表速度和里程计算

标题：

> 自行车码表轮速采集：霍尔传感器、EXTI 中断与速度里程计算

内容：

- 轮速传感器接线
- 轮径校准
- EXTI 中断消抖
- 脉冲间隔计算速度
- 低速/停车判断
- 数据同步到 LVGL

这是最能体现“码表”的核心文章，建议优先实现。

#### 文章 4：LVGL 码表界面

标题：

> LVGL 实现码表主界面：速度大数字、骑行时间、里程和心率刷新

内容：

- UI 信息层级
- 数据刷新周期
- LVGL 和 Sensor/Ride 服务的数据接口
- 如何避免 UI 线程直接读传感器
- 字体、图标、布局取舍

重点代码：

- `01_APP/User_Display/user_display.c`
- `01_APP/User_Display/Port/lvgl_port.c`
- 新增 `lvgl_ride_data_get_data()`

#### 文章 5：骑行记录存储

标题：

> 用 LittleFS 保存骑行记录：外部 Flash 文件系统在 STM32 码表中的应用

内容：

- 为什么不用裸地址直接写
- LittleFS 挂载/格式化
- 骑行记录结构体
- 断电保护
- 最近记录读取

重点代码：

- `05_Service/Service_ExternflashManage/service_externflash_manage.c`
- `02_Middleware_Platform/LittleFS/`

## 展示材料清单

为了让项目在网站里更像真实项目，建议补这些材料。

### 图片

- 实物图：开发板、屏幕、传感器接线。
- UI 图：当前手表页面和改造后的码表页面。
- 架构图：任务、队列、传感器、UI、存储之间的数据流。
- 调试图：串口日志、Keil 工程、Flash 文件系统日志。

### 日志

建议保留几段真实日志：

```text
SensorTask start
LVGLTask start
ExtFlash mount ok
boot_count_read 12
wheel pulse delta=842ms speed=9.2km/h distance=2.1m
ride save ok distance=3580m time=912s
```

### 代码片段

博客里不要大段贴完整源码，重点贴：

- 任务配置表
- 轮速中断回调
- 速度计算函数
- LVGL 数据写入接口
- LittleFS 保存骑行记录函数
- 看门狗注册/喂狗逻辑

## 代码注释补强建议

当前项目有不少注释乱码或英文模板注释，放到博客里会影响观感。建议优先整理这些位置：

### `service_sensor.c`

重点补：

- UI 事件为什么决定传感器采样频率。
- 心率/气压/温湿度为什么不同页面采样频率不同。
- 传感器数据为什么先写 `g_system_status`，再回调 LVGL。

### `lvgl_port.c`

重点补：

- 这是 UI 与业务服务之间的隔离层。
- LVGL 不直接访问传感器，避免 UI 线程阻塞。
- OTA 状态和传感器状态为什么都通过接口同步。

### `user_task_reso_config.c`

重点补：

- 每个任务职责。
- 栈大小和优先级为什么这样配置。
- 队列/互斥锁/信号量分别服务哪个模块。

### `service_watchdog_monitor.c`

重点补：

- 软件看门狗和硬件 IWDG 的关系。
- 为什么只有所有任务健康才喂硬件狗。
- 低功耗时为什么要 pause/resume。
- safe mode 的意义。

### 新增轮速模块

必须写清楚：

- 中断里只记录时间和计数，不做复杂计算。
- 消抖阈值如何设置。
- 为什么速度计算放到任务中做。
- 为什么停车超时后速度归零。

## 第一阶段落地步骤

### Step 1：先改项目页

把网站 `source/projects/index.md` 中新增 RidePulse 项目，先按“已完成/改造中/计划补充”写，避免夸大。

### Step 2：写项目总览文章

新增文章：

```text
source/_posts/项目实战/RidePulse/ridepulse-project-overview.md
```

先不写速度算法，重点写已有工程：

- 系统架构
- 任务表
- UI
- 传感器
- 存储
- OTA
- 低功耗和看门狗

### Step 3：新增码表最小闭环

先实现最小功能：

- 一个轮速输入中断。
- 一个 `RideTask`。
- 计算当前速度和累计里程。
- LVGL 主界面显示速度/里程。

这一步完成后，项目就从“包装成码表”变成“确实是码表”。

### Step 4：补博客证据

补：

- 轮速传感器接线图。
- 串口调试日志。
- UI 截图。
- 一段速度计算代码。
- 一段 LittleFS 骑行记录保存代码。

### Step 5：写核心技术文章

按这个顺序写：

1. 项目总览
2. 轮速采集与速度计算
3. LVGL 码表 UI
4. LittleFS 骑行记录
5. 低功耗与看门狗

## 网站文案建议

### 简历/项目展示版

> RidePulse 是一个基于 STM32F411、FreeRTOS 和 LVGL 的自行车码表项目，由一套智能穿戴设备固件改造而来。项目实现了多任务调度、传感器采集、实时 UI 显示、外部 Flash 文件系统、OTA 升级、低功耗管理和任务级看门狗，并计划扩展轮速采集、骑行记录和历史数据统计。

### 博客自然叙事版

> 这个项目最初不是自行车码表，而是一套智能手表固件。后来我发现它已经具备码表需要的大部分底层能力：屏幕、触摸、传感器、RTOS、外部 Flash、低功耗和 OTA。真正缺的是“骑行数据模型”：速度、里程、骑行状态和历史记录。所以我决定把它改造成一个自行车码表项目，并把改造过程完整记录下来。

## 不建议这样写

避免以下表述：

- “完整实现 GPS 自行车码表”。
- “支持骑行轨迹记录”，除非你后续真的接入 GPS 并保存轨迹。
- “商用品质”，除非做过长时间稳定性、电池续航、防水、震动测试。
- “已完成全部功能”，因为当前还需要补轮速/里程闭环。

推荐表述：

- “基于智能手表固件改造的码表项目”。
- “已完成底层系统能力，正在补齐骑行数据闭环”。
- “项目重点在 FreeRTOS 架构、LVGL UI、传感器服务、Flash 存储和可靠性设计”。

## 最小可展示版本标准

做到下面这些，就可以正式写进网站首页和项目页：

- LVGL 有一个码表主页面。
- 页面显示当前速度、里程、骑行时间、电量/心率中的至少 3 项。
- 速度来自霍尔轮速脉冲或可解释的模拟输入。
- 串口能打印速度、里程、脉冲间隔。
- 外部 Flash 或 RAM 中能保存一条骑行摘要。
- 文章里明确说明哪些已完成，哪些待完善。

## 结论

这个项目非常适合作为个人博客里的核心项目，因为它比普通 demo 更完整：有 UI、有 RTOS、有传感器、有存储、有 OTA、有低功耗、有看门狗，也有真实工程问题。

包装重点应该放在“从智能手表固件改造成自行车码表”的过程，而不是假装它一开始就是完整码表。这样写出来更真实，也更能体现你的工程能力。
