---
title: 自行车码表轮速采集：霍尔传感器、EXTI 中断与速度里程计算
date: 2026-07-16 10:50:00
categories:
  - 项目实战
  - RidePulse
  - 传感器
tags:
  - STM32
  - EXTI
  - 霍尔传感器
  - 自行车码表
  - 速度计算
description: 设计 RidePulse 自行车码表的轮速采集模块，使用霍尔传感器和 EXTI 中断统计车轮脉冲，计算当前速度、累计里程和骑行状态。
top_img: /img/covers/ridepulse-cover.svg
---

自行车码表最核心的功能是速度和里程。UI、OTA、Flash、低功耗都很重要，但如果没有稳定的速度输入，它就还不是一个真正的码表。

这一篇实现 RidePulse 的轮速采集最小闭环：用霍尔传感器或干簧管检测车轮磁铁，每转一圈产生一个脉冲，STM32 通过 EXTI 中断记录脉冲时间，再由 RideTask 计算当前速度和累计里程。

## 方案选择

码表常见速度来源有两种：

| 方案 | 输入 | 优点 | 缺点 |
|---|---|---|---|
| 轮速传感器 | 磁铁 + 霍尔/干簧管 | 实现简单、功耗低、适合 STM32 | 需要设置轮径 |
| GPS | UART 接收 NMEA | 可记录轨迹，不需要车轮传感器 | 功耗高，室内不稳定，解析复杂 |

第一阶段我选择轮速传感器，因为它更适合先把码表闭环做出来。

## 基本原理

在车轮辐条上安装一个磁铁，在前叉或车架上安装霍尔传感器。车轮每转一圈，磁铁经过传感器一次，传感器输出一个电平变化。

```text
车轮转动一圈
  -> 磁铁经过霍尔传感器
  -> GPIO 产生边沿
  -> EXTI 中断
  -> pulse_count++
  -> 记录当前 tick
```

有了两次脉冲之间的时间差，就能算速度：

```text
速度 = 车轮周长 / 两次脉冲间隔
```

每收到一个有效脉冲，就可以累计一次车轮周长：

```text
里程 += 车轮周长
```

## 轮径与周长

码表通常配置的是轮径或轮周长。建议内部直接使用轮周长，单位为毫米。

常见轮径参考：

| 轮胎规格 | 近似周长 |
|---|---|
| 700x23C | 2096 mm |
| 700x25C | 2105 mm |
| 700x28C | 2136 mm |
| 26x1.95 | 2050 mm |
| 29x2.1 | 2288 mm |

为了方便调试，可以先固定：

```c
#define RIDE_DEFAULT_WHEEL_CIRCUMFERENCE_MM 2105U
```

后续在设置页面中允许用户修改。

## 速度公式

如果轮周长单位是 `mm`，两次脉冲间隔是 `ms`：

```text
speed_m_per_s = circumference_mm / delta_ms
```

因为：

```text
mm / ms = m / s
```

换算成 `km/h`：

```text
speed_kmh = circumference_mm / delta_ms * 3.6
```

为了避免浮点计算，可以使用定点数，保存为 `km/h * 10`：

```text
speed_x10_kmh = circumference_mm * 36 / delta_ms
```

例如：

```text
轮周长 2105 mm
脉冲间隔 300 ms
speed_x10_kmh = 2105 * 36 / 300 = 252
速度 = 25.2 km/h
```

这个公式适合 STM32，整数运算快，也方便 UI 显示一位小数。

## 模块划分

建议新增两个模块：

```text
02_BSP_Platform/Bsp_Drivers/WheelSpeed/
  bsp_wheel_speed.c
  bsp_wheel_speed.h

05_Service/Service_Ride/
  ride_computer.c
  ride_computer.h
```

职责分工：

| 模块 | 职责 |
|---|---|
| `bsp_wheel_speed` | GPIO/EXTI 输入、消抖、脉冲计数、最后脉冲时间 |
| `ride_computer` | 速度、里程、骑行时间、状态机、UI 推送 |

不要把速度计算写进 EXTI 中断里。中断只做“记录事件”，业务计算放到任务里。

## BSP 头文件设计

新增：

```text
02_BSP_Platform/Bsp_Drivers/WheelSpeed/bsp_wheel_speed.h
```

示例：

```c
#ifndef BSP_WHEEL_SPEED_H
#define BSP_WHEEL_SPEED_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WHEEL_SPEED_DEBOUNCE_MS 20U

void bsp_wheel_speed_init(void);
void bsp_wheel_speed_on_exti_irq(uint32_t tick_ms);

uint32_t bsp_wheel_speed_get_pulse_count(void);
uint32_t bsp_wheel_speed_get_last_pulse_tick(void);
uint32_t bsp_wheel_speed_get_last_delta_ms(void);

void bsp_wheel_speed_reset(void);

#ifdef __cplusplus
}
#endif

#endif
```

`WHEEL_SPEED_DEBOUNCE_MS` 用于过滤抖动。干簧管机械抖动更明显，霍尔传感器通常好一些，但仍然建议保留消抖。

## BSP 源文件设计

新增：

```text
02_BSP_Platform/Bsp_Drivers/WheelSpeed/bsp_wheel_speed.c
```

示例：

```c
#include "bsp_wheel_speed.h"

static volatile uint32_t s_pulse_count = 0;      /* 累计脉冲计数，中断递增，任务读取 */
static volatile uint32_t s_last_pulse_tick = 0;   /* 上一次有效脉冲时的系统 tick */
static volatile uint32_t s_last_delta_ms = 0;     /* 最近两次有效脉冲之间的时间间隔 (ms) */

void bsp_wheel_speed_init(void)
{
    s_pulse_count = 0;
    s_last_pulse_tick = 0;
    s_last_delta_ms = 0;

    /*
     * GPIO 和 EXTI 可以先在 STM32CubeMX 中配置。
     * 这里保留接口，后续如果不用 CubeMX，也可以在这里手动初始化 GPIO。
     */
}

void bsp_wheel_speed_on_exti_irq(uint32_t tick_ms)
{
    uint32_t delta;

    if (s_last_pulse_tick == 0) {
        s_last_pulse_tick = tick_ms;
        s_pulse_count++;
        return;
    }

    delta = tick_ms - s_last_pulse_tick;

    /*
     * 轮速输入可能有抖动。
     * 小于消抖阈值的边沿不认为是一次真实车轮转动。
     */
    if (delta < WHEEL_SPEED_DEBOUNCE_MS) {
        return;
    }

    s_last_delta_ms = delta;
    s_last_pulse_tick = tick_ms;
    s_pulse_count++;
}

uint32_t bsp_wheel_speed_get_pulse_count(void)
{
    return s_pulse_count;
}

uint32_t bsp_wheel_speed_get_last_pulse_tick(void)
{
    return s_last_pulse_tick;
}

uint32_t bsp_wheel_speed_get_last_delta_ms(void)
{
    return s_last_delta_ms;
}

void bsp_wheel_speed_reset(void)
{
    s_pulse_count = 0;
    s_last_pulse_tick = 0;
    s_last_delta_ms = 0;
}
```

这里的变量用了 `volatile`，因为它们会在中断和任务之间共享。

如果后续发现 32 位读取在目标平台上仍有并发风险，可以在读取时短暂关中断或进入临界区。

## EXTI 回调接入

STM32 HAL 通常会在 GPIO 外部中断里调用：

```c
void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
```

可以在 `01_APP/User_Isr_handlers/user_isr_handlers.c` 或现有中断处理封装里加入：

```c
#include "bsp_wheel_speed.h"
#include "osal.h"

void user_gpio_exti_callback(uint16_t GPIO_Pin)
{
    if (GPIO_Pin == WHEEL_SPEED_Pin) {
        bsp_wheel_speed_on_exti_irq(osal_task_get_tick_count());
    }
}
```

如果工程目前直接使用 HAL 回调：

```c
void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
    if (GPIO_Pin == WHEEL_SPEED_Pin) {
        bsp_wheel_speed_on_exti_irq(osal_task_get_tick_count());
    }
}
```

注意：

- `WHEEL_SPEED_Pin` 需要在 `main.h` 或 CubeMX 中生成。
- 如果 `osal_task_get_tick_count()` 不能在中断中调用，就改用 `HAL_GetTick()`。
- 中断中不要打印日志，尤其不要每个脉冲都打印。

## Ride 数据结构

新增：

```text
05_Service/Service_Ride/ride_computer.h
```

定义：

```c
#ifndef RIDE_COMPUTER_H
#define RIDE_COMPUTER_H

#include <stdint.h>
#include <stdbool.h>

typedef enum {
    RIDE_STATE_IDLE = 0,
    RIDE_STATE_READY,
    RIDE_STATE_RIDING,
    RIDE_STATE_PAUSED,
    RIDE_STATE_SAVING,
} ride_state_t;

typedef struct {
    uint32_t wheel_circumference_mm;   /* 轮周长，单位毫米 */
    uint32_t last_pulse_count;         /* 上一次更新时的脉冲计数，用于计算增量 */
    uint32_t current_speed_x10_kmh;    /* 当前速度，单位 km/h * 10（定点数，避免浮点） */
    uint32_t distance_m;               /* 累计里程，单位米 */
    uint32_t ride_time_s;              /* 本次骑行时长，单位秒 */
    uint32_t max_speed_x10_kmh;        /* 本次骑行的最高速度 */
    uint32_t avg_speed_x10_kmh;        /* 本次骑行的平均速度 */
    uint32_t start_tick_ms;            /* 骑行开始时的系统 tick */
    uint32_t last_update_tick_ms;      /* 上一次调用 ride_computer_update 的 tick */
    uint32_t last_motion_tick_ms;      /* 最后一次检测到车轮转动时的 tick */
    ride_state_t state;                /* 当前骑行状态机状态 */
} ride_data_t;

void ride_computer_init(void);
void ride_computer_task(void *argument);
void ride_computer_update(uint32_t now_ms);
void ride_computer_get_data(ride_data_t *out);

void ride_start(void);
void ride_pause(void);
void ride_resume(void);
void ride_stop(void);
bool ride_computer_is_riding(void);

#endif
```

## RideService 初始化

```c
#include "ride_computer.h"
#include "bsp_wheel_speed.h"

#define RIDE_DEFAULT_WHEEL_CIRCUMFERENCE_MM 2105U
#define RIDE_STOP_TIMEOUT_MS               3000U

static ride_data_t s_ride;

void ride_computer_init(void)
{
    /* 骑行数据结构体清零，设置默认轮周长，初始状态为 IDLE */
    memset(&s_ride, 0, sizeof(s_ride));
    s_ride.wheel_circumference_mm = RIDE_DEFAULT_WHEEL_CIRCUMFERENCE_MM;
    s_ride.state = RIDE_STATE_IDLE;

    bsp_wheel_speed_init();
}
```

`RIDE_STOP_TIMEOUT_MS` 表示超过 3 秒没有轮速脉冲，就把当前速度归零。如果处于骑行中，也可以切到 `PAUSED`。

## 启动与停止

```c
void ride_start(void)
{
    uint32_t now = osal_task_get_tick_count();

    bsp_wheel_speed_reset();          /* 清零轮速 BSP 层的脉冲计数 */

    /* 重置所有骑行数据：速度、里程、时间、极值、时间戳均清零 */
    s_ride.last_pulse_count = 0;
    s_ride.current_speed_x10_kmh = 0;
    s_ride.distance_m = 0;
    s_ride.ride_time_s = 0;
    s_ride.max_speed_x10_kmh = 0;
    s_ride.avg_speed_x10_kmh = 0;
    s_ride.start_tick_ms = now;
    s_ride.last_update_tick_ms = now;
    s_ride.last_motion_tick_ms = now;
    s_ride.state = RIDE_STATE_RIDING;  /* 进入骑行状态 */
}

void ride_pause(void)
{
    /* 仅当正在骑行时才允许暂停，速度归零 */
    if (s_ride.state == RIDE_STATE_RIDING) {
        s_ride.state = RIDE_STATE_PAUSED;
        s_ride.current_speed_x10_kmh = 0;
    }
}

void ride_resume(void)
{
    /* 从暂停状态恢复到骑行状态，刷新更新时间戳 */
    if (s_ride.state == RIDE_STATE_PAUSED) {
        s_ride.state = RIDE_STATE_RIDING;
        s_ride.last_update_tick_ms = osal_task_get_tick_count();
    }
}

void ride_stop(void)
{
    /* 速度归零并进入保存状态，后续由 ride_stop_and_save() 写入 Flash */
    s_ride.current_speed_x10_kmh = 0;
    s_ride.state = RIDE_STATE_SAVING;
}
```

第一阶段可以让进入码表页面时自动 `ride_start()`，后续再加 UI 按钮。

## 速度和里程更新

RideTask 周期调用：

```c
void ride_computer_update(uint32_t now_ms)
{
    uint32_t pulse_count;
    uint32_t pulse_diff;
    uint32_t delta_ms;
    uint32_t elapsed_ms;

    if (s_ride.state != RIDE_STATE_RIDING) {
        return;
    }

    pulse_count = bsp_wheel_speed_get_pulse_count();
    pulse_diff = pulse_count - s_ride.last_pulse_count;

    if (pulse_diff > 0) {
        delta_ms = bsp_wheel_speed_get_last_delta_ms();

        if (delta_ms > 0) {
            /*
             * speed_x10_kmh = circumference_mm * 36 / delta_ms
             * 结果单位是 km/h * 10。
             */
            s_ride.current_speed_x10_kmh =
                (s_ride.wheel_circumference_mm * 36U) / delta_ms;

            if (s_ride.current_speed_x10_kmh > s_ride.max_speed_x10_kmh) {
                s_ride.max_speed_x10_kmh = s_ride.current_speed_x10_kmh;
            }
        }

        /*
         * 每个有效脉冲代表车轮转过一圈。
         * 如果一次周期内读到多个脉冲，需要把 pulse_diff 都累计进去。
         */
        s_ride.distance_m +=
            (pulse_diff * s_ride.wheel_circumference_mm) / 1000U;

        s_ride.last_pulse_count = pulse_count;
        s_ride.last_motion_tick_ms = now_ms;
    }

    /*
     * 超过一段时间没有脉冲，认为车辆已停止。
     * 速度归零，但是否切换 PAUSED 可以根据产品体验决定。
     */
    if ((now_ms - s_ride.last_motion_tick_ms) > RIDE_STOP_TIMEOUT_MS) {
        s_ride.current_speed_x10_kmh = 0;
        s_ride.state = RIDE_STATE_PAUSED;
    }

    elapsed_ms = now_ms - s_ride.start_tick_ms;
    s_ride.ride_time_s = elapsed_ms / 1000U;

    if (s_ride.ride_time_s > 0) {
        /*
         * avg_speed_x10_kmh:
         * distance_m / time_s = m/s
         * m/s -> km/h 乘 3.6
         * 再乘 10 保存一位小数，所以乘 36。
         */
        s_ride.avg_speed_x10_kmh =
            (s_ride.distance_m * 36U) / s_ride.ride_time_s;
    }
}
```

这段代码有一个小问题：`distance_m` 用整数米累计，会丢失小数。对于第一阶段可以接受，但后续建议内部使用毫米累计：

```c
uint32_t distance_mm;
```

然后 UI 显示时再换算成米或公里。

## 更推荐的里程累计方式

为了避免每圈 2105mm 转成 2m 后丢失 105mm，建议这样设计：

```c
typedef struct {
    uint32_t distance_mm;
    uint32_t distance_m;
} ride_distance_t;
```

每次脉冲：

```c
s_ride.distance_mm += pulse_diff * s_ride.wheel_circumference_mm;
s_ride.distance_m = s_ride.distance_mm / 1000U;
```

UI 显示公里：

```c
uint32_t km_int = s_ride.distance_mm / 1000000U;
uint32_t km_frac = (s_ride.distance_mm % 1000000U) / 10000U;
```

显示为：

```text
12.34 km
```

## RideTask 示例

```c
void ride_computer_task(void *argument)
{
    uint32_t last_log_tick = 0;

    ride_computer_init();             /* 初始化骑行数据结构 */
    ride_start();                     /* 调试阶段自动开始，后续改为用户按键触发 */

    /* 向软件看门狗注册本任务，超时时间 1000ms */
    watchdog_register(osal_task_get_current_handle(), 1000, "RideTask");

    for (;;) {
        uint32_t now = osal_task_get_tick_count();

        watchdog_feed(osal_task_get_current_handle());  /* 周期喂狗 */

        ride_computer_update(now);       /* 读取轮速脉冲，计算速度/里程/时间 */
        ride_computer_publish_to_ui();   /* 将计算结果推送给 LVGL 显示 */

        /* 每秒输出一次调试日志，避免高频打印影响实时性 */
        if ((now - last_log_tick) >= 1000U) {
            DEBUG_OUT("ride speed=%lu.%lu km/h distance=%lu m time=%lu s state=%d",
                      s_ride.current_speed_x10_kmh / 10U,
                      s_ride.current_speed_x10_kmh % 10U,
                      s_ride.distance_m,
                      s_ride.ride_time_s,
                      s_ride.state);
            last_log_tick = now;
        }

        osal_task_delay_ms(100);        /* 100ms 周期，平衡实时性与 CPU 负载 */
    }
}
```

调试阶段可以自动 `ride_start()`。等 UI 做好后，再改成用户点击开始。

## 推送到 LVGL

可以在 `ride_computer.c` 中写：

```c
void ride_computer_publish_to_ui(void)
{
    lvgl_ride_data_t ui_data;

    /* 从 RideService 内部结构体拷贝到 LVGL 数据接口，解耦 UI 与业务层 */
    ui_data.speed_x10_kmh = s_ride.current_speed_x10_kmh;
    ui_data.distance_m = s_ride.distance_m;
    ui_data.ride_time_s = s_ride.ride_time_s;
    ui_data.ride_state = (uint8_t)s_ride.state;

    lvgl_ride_data_write(&ui_data);   /* 写入 lvgl_port 的数据快照 */
}
```

`lvgl_ride_data_write()` 的实现放在 `lvgl_port.c`，下一篇 UI 文章会展开。

## 停车和暂停逻辑

停车判断不要只看速度等于 0，因为速度归零本身就是根据脉冲超时判断出来的。

建议：

```c
if ((now_ms - s_ride.last_motion_tick_ms) > RIDE_STOP_TIMEOUT_MS) {
    s_ride.current_speed_x10_kmh = 0;

    if (s_ride.state == RIDE_STATE_RIDING) {
        s_ride.state = RIDE_STATE_PAUSED;
    }
}
```

如果再次检测到脉冲：

```c
if (pulse_diff > 0 && s_ride.state == RIDE_STATE_PAUSED) {
    s_ride.state = RIDE_STATE_RIDING;
    s_ride.last_update_tick_ms = now_ms;
}
```

是否自动恢复骑行取决于产品定义。自行车码表通常可以自动暂停/恢复。

## 消抖阈值怎么选

假设轮周长 2105mm，速度 80km/h：

```text
80 km/h = 22.22 m/s
每圈时间 = 2.105 / 22.22 = 0.0947s = 94.7ms
```

正常骑行时，两次真实脉冲间隔通常大于 90ms。设置 20ms 消抖比较安全。

如果使用干簧管，机械抖动可能连续触发几次，20ms 到 50ms 都可以尝试。

建议从：

```c
#define WHEEL_SPEED_DEBOUNCE_MS 30U
```

开始调试。

## 低速显示问题

低速时脉冲间隔很长，速度刷新会变慢。例如：

```text
5 km/h = 1.39 m/s
每圈时间 = 2.105 / 1.39 = 1.51s
```

也就是说，5km/h 时大约 1.5 秒才来一次脉冲。码表显示会有延迟，这是轮速方案的正常现象。

可以优化：

- 有新脉冲时更新速度。
- 无新脉冲时保持上一次速度一段时间。
- 超过 3 秒无脉冲再归零。

不要强行每 100ms 推算速度，否则低速时会抖动。

## 测试方法

### 1. 串口模拟

先不接传感器，直接在测试命令里调用：

```c
bsp_wheel_speed_on_exti_irq(HAL_GetTick());
```

每隔 500ms 调一次，期望速度：

```text
speed_x10 = 2105 * 36 / 500 = 151
speed = 15.1 km/h
```

### 2. 按键模拟

把一个按键配置成 EXTI，按键按下模拟轮速脉冲。

注意按键抖动更明显，消抖阈值可以调大。

### 3. 信号发生器模拟

如果有信号发生器，可以输出方波到 GPIO。

比如 2Hz：

```text
每秒 2 圈
速度 = 2.105m * 2 * 3.6 = 15.156 km/h
```

期望 UI 显示：

```text
15.1 km/h
```

### 4. 实车测试

最后再接霍尔传感器上车：

- 磁铁和传感器距离不要太远。
- 线缆固定好，避免抖动误触发。
- 先低速推车观察脉冲。
- 再短距离骑行验证里程。

## 建议调试日志

不要每次中断都打印。建议 RideTask 每秒打印：

```text
RideTask start
wheel pulse=12 delta=428ms speed=17.7km/h distance=25m state=RIDING
wheel pulse=13 delta=421ms speed=18.0km/h distance=27m state=RIDING
wheel timeout, speed=0 state=PAUSED
```

日志中至少包含：

- 脉冲计数
- 最近脉冲间隔
- 当前速度
- 累计里程
- 当前状态

## 常见问题

### 速度忽高忽低

可能原因：

- 霍尔传感器信号抖动。
- 磁铁距离不稳定。
- 中断触发边沿选错。
- 消抖阈值太小。

解决：

- 先用示波器或逻辑分析仪看 GPIO 波形。
- 调整磁铁和传感器距离。
- 只用上升沿或下降沿，不要双边沿。
- 增大 `WHEEL_SPEED_DEBOUNCE_MS`。

### 里程偏大

可能原因：

- 一圈触发多次。
- 消抖太小。
- 轮周长设置过大。

解决：

- 检查脉冲计数是否和车轮圈数一致。
- 手动转 10 圈，看是否正好增加 10 个 pulse。
- 用卷尺测实际轮周长。

### 速度归零太慢

原因是 `RIDE_STOP_TIMEOUT_MS` 太大。可以从 3000ms 改成 2000ms。

### 速度归零太快

低速骑行时脉冲间隔本来就长。超时时间太短会误判停车。可以改回 3000ms 或 5000ms。

## 后续优化

第一阶段只做最小闭环。后续可以继续优化：

- 多脉冲平均速度，减少抖动。
- 保存最近 3 次脉冲间隔，做滑动平均。
- 支持轮周长设置页面。
- 支持自动暂停/恢复。
- 支持骑行记录断电恢复。
- 支持 GPS 速度作为备选数据源。

滑动平均示例：

```c
#define SPEED_FILTER_SIZE 4

static uint32_t s_delta_buf[SPEED_FILTER_SIZE];
static uint8_t s_delta_idx;

static uint32_t ride_filter_delta(uint32_t delta_ms)
{
    uint32_t sum = 0;
    uint8_t count = 0;

    s_delta_buf[s_delta_idx++ % SPEED_FILTER_SIZE] = delta_ms;

    for (uint8_t i = 0; i < SPEED_FILTER_SIZE; i++) {
        if (s_delta_buf[i] > 0) {
            sum += s_delta_buf[i];
            count++;
        }
    }

    return count ? (sum / count) : delta_ms;
}
```

## 小结

这一篇完成了自行车码表最核心的设计：

- 用 EXTI 采集轮速脉冲。
- 中断里只记录脉冲和时间。
- RideTask 中计算速度、里程和状态。
- 使用定点数保存 `km/h * 10`。
- 超时无脉冲后速度归零并进入暂停状态。

完成这个模块后，RidePulse 就有了真正的码表核心。下一篇会把这些骑行数据接到 LVGL 页面上，做出一个能看的码表主界面。
