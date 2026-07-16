---
title: STM32 码表的 FreeRTOS 任务划分：显示、传感器、存储、OTA 与看门狗
date: 2026-07-16 10:40:00
categories:
  - 项目实战
  - RidePulse
  - RTOS
tags:
  - FreeRTOS
  - STM32F411
  - 任务调度
  - 看门狗
  - 嵌入式架构
description: 基于现有智能手表工程，梳理 FreeRTOS 任务、队列、互斥锁、信号量和看门狗设计，并规划自行车码表 RideTask 的接入方式。
top_img: /img/covers/rtos-cover.svg
---

自行车码表看起来只是“显示速度和里程”，但如果要做成一个稳定运行的嵌入式项目，背后会涉及很多并发问题：显示刷新不能被传感器阻塞，Flash 写入不能卡住 UI，OTA 期间不能误触发看门狗，低功耗时任务要能暂停和恢复。

这个项目原本是智能手表固件，已经有比较完整的 FreeRTOS 任务框架。本文先基于现有工程梳理任务划分，再规划自行车码表新增的 `RideTask` 应该怎么接进去。

## 当前 RTOS 资源入口

当前工程的任务、队列、互斥锁、信号量主要集中在：

```text
01_APP/User_Init/User_Task_Config/user_task_reso_config.c
01_APP/User_Init/User_Task_Config/user_task_reso_config.h
```

这个文件可以看成整个应用层 RTOS 资源的总表。它做了几件事：

- 定义任务数组 `st_usertaskcfg`。
- 定义队列数组 `st_userqueuecfg`。
- 定义互斥锁数组 `st_usermutexcfg`。
- 定义信号量数组 `st_usersemacfg`。
- 统一创建资源。
- 统一创建任务。

这种设计比到处散落 `xTaskCreate()` 更容易维护，因为后续增加 `RideTask` 时，只需要补任务表、枚举值和函数声明。

## 当前任务划分

当前任务表大致如下：

```c
st_usertaskcfg_t st_usertaskcfg[USER_IDX_MAX] =
{
    {"Thread_5ms_Task",  thread_5ms_task,                 256, PRI_SOFT_REALTIME + 4, NULL, NULL},
    {"SensorTask",      sensor_polling_task,             512, PRI_SOFT_REALTIME + 3, NULL, NULL},
    {"ExtFlashTask",    storage_manager_task,            512, PRI_SOFT_REALTIME + 1, NULL, NULL},
    {"LVGLTask",        display_refresh_task,            512, PRI_SOFT_REALTIME + 3, NULL, NULL},
    {"tempHandlerTask", temp_humi_handler_thread,        512, PRI_HARD_REALTIME + 1, NULL, &input_arg},
    {"ExtFlashDrv",     flash_handler_thread,            512, PRI_HARD_REALTIME + 1, NULL, &flash_handler_all_input_arg},
    {"OTA_task",        ota_task_runnable,               512, PRI_SOFT_REALTIME + 2, NULL, NULL},
    {"DwAppData_task",  download_app_data_task_runnable, 512, PRI_SOFT_REALTIME + 3, NULL, NULL},
    {"LowPower_Thread", low_power_monitor_task,          256, PRI_SOFT_REALTIME,     NULL, NULL},
    {"WatchDog_Thread", server_watchdog_task,            256, PRI_SOFT_REALTIME + 3, NULL, NULL}
};
```

这些任务对应的职责：

| 任务 | 职责 | 码表改造中的作用 |
|---|---|---|
| `Thread_5ms_Task` | 5ms 周期任务，处理电池、系统状态、背光等 | 保留，用于系统状态和背光控制 |
| `SensorTask` | 根据 UI 状态按需采样传感器 | 保留，用于心率、气压、温湿度 |
| `ExtFlashTask` | 外部 Flash 读写调度 | 保留，用于骑行记录保存 |
| `LVGLTask` | LVGL 初始化和页面刷新 | 保留，用于码表 UI |
| `tempHandlerTask` | 温湿度底层处理 | 保留 |
| `ExtFlashDrv` | Flash 驱动线程 | 保留 |
| `OTA_task` | OTA 状态机 | 保留 |
| `DwAppData_task` | OTA 数据下载 | 保留 |
| `LowPower_Thread` | 低功耗进入/退出 | 保留，后续要考虑骑行中禁止深睡眠 |
| `WatchDog_Thread` | 任务级看门狗监控 | 保留，新增 RideTask 后也要注册 |

后续新增：

| 新任务 | 职责 |
|---|---|
| `RideTask` | 轮速采集处理、速度/里程计算、骑行状态机、UI 数据推送 |

## 为什么要单独加 RideTask

码表数据看起来可以放在 `SensorTask` 里处理，但我不建议这样做。原因有三个：

### 1. 轮速不是普通传感器

温湿度、气压、心率都可以按固定周期采样。但轮速来自外部脉冲，中断到来的频率和骑行速度相关：

- 低速时，几秒才有一个脉冲。
- 高速时，脉冲间隔会明显缩短。
- 停车时没有脉冲，但 UI 仍然要更新速度为 0。

它更像一个实时事件流，不适合简单套用普通传感器采样逻辑。

### 2. 骑行状态需要独立管理

RideTask 不只是算速度，还要管理状态：

```text
IDLE -> READY -> RIDING -> PAUSED -> SAVING
```

这些状态会影响：

- 是否累计里程。
- 是否累计骑行时间。
- 是否允许进入低功耗。
- 是否需要保存骑行记录。
- UI 显示“开始/暂停/结束”哪种状态。

### 3. 方便看门狗监控

RideTask 是核心业务任务，应该独立注册到软件看门狗。如果它卡死，系统能通过看门狗复位恢复。

## 建议新增任务配置

先在 `user_task_reso_config.h` 中增加任务枚举。示例：

```c
typedef enum {
    USER_IDX_thread_5ms_task = 0,
    USER_IDX_sensor_polling_task,
    USER_IDX_storage_manager_task,
    USER_IDX_display_refresh_task,
    USER_IDX_temp_humi_handler_thread,
    USER_IDX_flash_handler_thread,
    USER_IDX_ota_task,
    USER_IDX_download_app_data_task,
    USER_IDX_low_power_monitor_task,
    USER_IDX_watchdog_task,
    USER_IDX_ride_task,          /* 新增：自行车码表任务 */
    USER_IDX_MAX
} user_task_idx_t;
```

然后在 `user_task_reso_config.c` 声明任务函数：

```c
void ride_computer_task(void *argument);
```

任务表中新增：

```c
{"RideTask", ride_computer_task, 512, PRI_SOFT_REALTIME + 3, NULL, NULL},
```

为什么栈先给 512？

- RideTask 后续可能会做状态机、格式化日志、调用 UI 接口、准备骑行记录结构体。
- 512 比较保守，先保证不因为栈太小引入难查问题。
- 后续可以通过 `uxTaskGetStackHighWaterMark()` 观察实际水位，再决定是否缩小。

优先级建议：

- 不要高于真正硬实时的底层驱动任务。
- 可以和 `SensorTask`、`LVGLTask` 接近。
- 如果速度刷新要求高，可以设置为 `PRI_SOFT_REALTIME + 3`。

## RideTask 的基本循环

RideTask 建议以 100ms 或 200ms 为周期。

如果只是码表显示，200ms 已经够用；如果希望速度变化更灵敏，可以用 100ms。

示例：

```c
void ride_computer_task(void *argument)
{
    ride_computer_init();
    watchdog_register(osal_task_get_current_handle(), 1000, "RideTask");

    for (;;) {
        watchdog_feed(osal_task_get_current_handle());

        ride_computer_update(osal_task_get_tick_count());
        ride_computer_publish_to_ui();

        osal_task_delay_ms(100);
    }
}
```

这里要注意：

- `ride_computer_update()` 只做业务计算。
- `ride_computer_publish_to_ui()` 只把计算结果推给 LVGL 数据接口。
- 不要在 RideTask 里直接操作 LVGL 控件。
- 不要在 RideTask 里长时间写 Flash，保存记录应交给存储服务或只在结束时短时间调用。

## 队列设计

当前已有队列：

```c
st_userqueuecfg_t st_userqueuecfg[Queue_IDX_MAX] =
{
    {"SensorDataQueue",        2, sizeof(uint32_t), NULL},
    {"DisplayQueue",           8, sizeof(uint32_t), NULL},
    {"YmodemRecQueue",         5, sizeof(uint16_t), NULL},
    {"AppDataBuffer",          2, sizeof(uint8_t *), NULL},
    {"ShutdownKeyQueue",       1, sizeof(uint8_t), NULL},
    {"LastPressCntQueue",      1, sizeof(uint32_t), NULL},
    {"DisplayBlackLightQueue", 6, sizeof(uint16_t), NULL},
};
```

码表改造可以新增两个队列：

```c
{"RideEventQueue", 8, sizeof(ride_event_t), NULL},
{"RideRecordQueue", 2, sizeof(ride_record_t), NULL},
```

### RideEventQueue

用于 UI 或中断间接通知 RideTask：

```c
typedef enum {
    RIDE_EVENT_START = 0,
    RIDE_EVENT_PAUSE,
    RIDE_EVENT_RESUME,
    RIDE_EVENT_STOP,
    RIDE_EVENT_WHEEL_PULSE,
} ride_event_type_t;

typedef struct {
    ride_event_type_t type;
    uint32_t tick_ms;
} ride_event_t;
```

轮速中断里不建议直接 `osal_queue_send()`，因为要确认 OSAL 是否提供 ISR 安全版本。如果没有，可以只在 BSP 中记录脉冲计数，由 RideTask 周期读取。

### RideRecordQueue

用于骑行结束后把记录交给存储任务：

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

第一阶段可以不加 `RideRecordQueue`，先由 RideTask 在结束时直接调用保存函数。后续如果发现 Flash 写入会卡 UI，再改成队列异步保存。

## 互斥锁设计

当前已有互斥锁：

```c
st_usermutexcfg_t st_usermutexcfg[USER_MUTEX_NUM] =
{
    {"FlashMutex",    NULL},
    {"SensorMutex",   NULL},
    {"I2CMutex",      NULL},
    {"ExtFlashState", NULL}
};
```

码表数据可以新增一个锁：

```c
{"RideDataMutex", NULL}
```

需要保护的数据：

- 当前速度
- 累计里程
- 骑行时间
- 最大速度
- 平均速度
- 当前状态

如果 RideTask 是唯一写入者，LVGL 只是通过 `lvgl_port` 接收数据，也可以不暴露共享结构，减少锁的复杂度。推荐第一阶段使用“单写多拷贝”方式：

```text
RideTask 写 ride_data
  -> 拷贝一份到 lvgl_port 的 g_lvgl_data
  -> LVGLTask 只读 g_lvgl_data
```

## 中断与任务边界

轮速输入来自 EXTI。中断回调里只做最少工作：

```c
void bsp_wheel_speed_on_exti_irq(uint32_t tick_ms)
{
    uint32_t delta = tick_ms - s_last_pulse_tick;

    if (delta < WHEEL_DEBOUNCE_MS) {
        return;
    }

    s_last_pulse_tick = tick_ms;
    s_pulse_count++;
}
```

不要在中断里做：

- 浮点速度计算。
- Flash 写入。
- LVGL 控件刷新。
- 大量日志打印。
- 复杂状态机。

RideTask 周期读取：

```c
uint32_t pulse_count = bsp_wheel_speed_get_pulse_count();
uint32_t last_tick = bsp_wheel_speed_get_last_pulse_tick();
```

这样中断层和业务层就解耦了。

## UI 与 RideTask 的边界

现有工程已经有 `lvgl_port.c` 作为 UI 和业务之间的接口层。这个思路要继续保留。

新增接口：

```c
typedef struct {
    uint16_t speed_x10_kmh;
    uint32_t distance_m;
    uint32_t ride_time_s;
    uint16_t heart_rate;
    uint8_t ride_state;
} lvgl_ride_data_t;

void lvgl_ride_data_write(const lvgl_ride_data_t *data);
void lvgl_ride_data_read(lvgl_ride_data_t *data);
```

RideTask 写：

```c
lvgl_ride_data_t ui_data = {
    .speed_x10_kmh = ride_data.current_speed_x10_kmh,
    .distance_m = ride_data.distance_m,
    .ride_time_s = ride_data.ride_time_s,
    .heart_rate = ride_data.heart_rate,
    .ride_state = ride_data.state,
};

lvgl_ride_data_write(&ui_data);
```

LVGLTask 读：

```c
lvgl_ride_data_t data;
lvgl_ride_data_read(&data);
update_bike_main_screen(&data);
```

这样 UI 页面不需要知道 RideTask 的内部结构。

## 看门狗接入

现有看门狗逻辑在：

```text
05_Service/Service_WatchdogMonitor/service_watchdog_monitor.c
```

它的核心思想是：

- 每个关键任务注册自己。
- 每个任务周期性喂软件看门狗。
- 看门狗任务检查所有任务是否超时。
- 所有任务健康才刷新硬件 IWDG。
- 如果任务卡死，触发复位。

RideTask 接入方式：

```c
void ride_computer_task(void *argument)
{
    watchdog_register(osal_task_get_current_handle(), 1000, "RideTask");

    for (;;) {
        watchdog_feed(osal_task_get_current_handle());
        ride_computer_update(osal_task_get_tick_count());
        osal_task_delay_ms(100);
    }
}
```

超时时间设置建议：

| 任务周期 | 看门狗超时 |
|---|---|
| 100ms | 1000ms |
| 200ms | 1500ms |
| 500ms | 3000ms |

不要把超时时间设得太小，否则偶发 Flash 操作或调试断点会导致误复位。

## 低功耗接入

现有工程有系统状态和低功耗逻辑：

```text
05_Service/Service_5ms_Cycle/Moudle_Task/SystemStateManage/
05_Service/Service_PowerManage/LowPowerMonitor/
```

码表改造时要加一条原则：

> 骑行中不能进入深度低功耗。

可以在系统状态判断中增加 RideTask 状态查询：

```c
if (ride_computer_is_riding()) {
    return; /* 骑行中保持显示和轮速采集 */
}
```

也可以让 RideTask 在进入 `RIDING` 时发一个系统活跃事件，避免被空闲计时误判：

```c
system_activity_notify();
```

如果处于 `PAUSED` 状态，可以只降低 UI 刷新频率，不要马上关轮速中断，因为骑行可能很快恢复。

## OTA 期间的处理

OTA 会占用串口、Flash 和 UI 状态，不应该和骑行记录保存同时发生。

建议策略：

- 如果正在骑行，不允许进入 OTA。
- 如果进入 OTA，RideTask 切到 `IDLE` 或 `PAUSED`。
- OTA 期间停止骑行记录写入。
- OTA 任务和 Flash 任务需要继续被看门狗正确监控。

示例判断：

```c
if (ride_computer_is_riding()) {
    lvgl_show_message("Stop ride before OTA");
    return;
}
```

## 建议的任务关系图

```text
                 +----------------+
                 | WatchDog Task  |
                 +-------+--------+
                         ^
                         | monitor
                         |
+------------+    +------+-------+    +-------------+
| EXTI Wheel | -> |  RideTask    | -> |  LVGL Port  |
+------------+    +------+-------+    +------+------+
                         |                   |
                         |                   v
                         |            +-------------+
                         |            |  LVGLTask   |
                         |            +-------------+
                         |
                         v
                 +---------------+
                 | ExtFlashTask  |
                 +---------------+

+-------------+      +------------+
| SensorTask  | ---> | LVGL Port  |
+-------------+      +------------+

+-------------+      +---------------+
| OTA Task    | ---> | ExtFlashTask  |
+-------------+      +---------------+
```

## 第一阶段改造清单

### 1. 增加任务枚举

在 `user_task_reso_config.h` 增加 `USER_IDX_ride_task`。

### 2. 增加任务函数声明

在 `user_task_reso_config.c` 增加：

```c
void ride_computer_task(void *argument);
```

### 3. 增加任务表项

```c
{"RideTask", ride_computer_task, 512, PRI_SOFT_REALTIME + 3, NULL, NULL},
```

### 4. 新建 RideService

```text
05_Service/Service_Ride/
  ride_computer.c
  ride_computer.h
```

### 5. 接入看门狗

RideTask 启动时注册，循环里喂狗。

### 6. 先用模拟数据验证

还没接轮速传感器前，可以先在 RideTask 中生成假数据：

```c
ride_data.current_speed_x10_kmh = 186; /* 18.6 km/h */
ride_data.distance_m += 1;
```

先确认任务能跑、UI 能刷新，再接真实轮速。

## 调试建议

### 打印任务启动日志

每个关键任务启动时打印一次：

```c
DEBUG_OUT("RideTask start");
DEBUG_OUT("LVGLTask start");
DEBUG_OUT("SensorTask start");
DEBUG_OUT("ExtFlashTask start");
```

### 打印 RideTask 周期日志

不要每 100ms 打一次完整日志，会影响实时性。建议 1s 打一次：

```c
if (now - last_log_tick >= 1000) {
    DEBUG_OUT("ride speed=%d.%d km/h dist=%dm state=%d",
              speed_x10 / 10,
              speed_x10 % 10,
              distance_m,
              state);
    last_log_tick = now;
}
```

### 检查任务栈水位

如果 FreeRTOS 配置支持：

```c
UBaseType_t remain = uxTaskGetStackHighWaterMark(NULL);
DEBUG_OUT("RideTask stack remain=%u", remain);
```

如果剩余栈长期很低，就要加大栈。

## 常见问题

### RideTask 放在哪个优先级？

先放在 `PRI_SOFT_REALTIME + 3`。它需要比较及时地更新速度，但不应该压过硬实时驱动任务。

### 速度计算能不能放中断里？

不建议。中断里只记录脉冲和时间。速度计算放 RideTask，便于调试、滤波、状态机处理。

### LVGL 能不能直接读 RideTask 的全局变量？

不建议。用 `lvgl_port.c` 做中间层，避免 UI 和业务强耦合。

### Flash 保存能不能在 RideTask 里直接做？

第一阶段可以临时直接做，方便跑通。后续建议交给 `ExtFlashTask`，避免 Flash 操作阻塞 RideTask。

### 低功耗时 RideTask 怎么办？

如果 `IDLE`，可以降低刷新频率或暂停。  
如果 `RIDING`，不要进入深睡眠。  
如果 `PAUSED`，可以息屏但保留轮速中断唤醒。

## 小结

这次改造的关键不是多建一个任务，而是把每个任务的边界划清楚：

- 轮速中断只记录脉冲。
- RideTask 计算骑行数据。
- SensorTask 管理心率、气压、温湿度。
- LVGLTask 只刷新 UI。
- ExtFlashTask 负责外部存储。
- WatchDogTask 监控任务健康。
- LowPowerTask 处理休眠，但要避开骑行中状态。

任务边界清楚后，后续加轮速、UI 和骑行记录都会容易很多。下一篇文章开始实现码表最核心的轮速采集、速度计算和里程累计。
