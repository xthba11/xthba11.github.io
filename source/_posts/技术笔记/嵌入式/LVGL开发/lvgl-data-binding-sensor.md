---
title: LVGL 数据绑定与 Sensor 实时刷新机制
date: 2025-12-05
categories:
  - 技术笔记
  - 嵌入式
  - LVGL开发
tags:
  - LVGL
  - 数据绑定
  - 传感器
  - FreeRTOS
  - 线程安全
  - 队列
  - Bicycle_Watch
description: LVGL 与 Sensor 任务的数据交互架构：全局数据结构 lvgl_data_t、队列驱动的 UI 事件传递、页面切换时动态订阅传感器、lv_timer 定时刷新、线程安全设计原则
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# LVGL 数据绑定与 Sensor 实时刷新机制

## 1. 问题背景：两个任务的数据交互

Bicycle_Watch 中，**LVGL 显示任务**和 **Sensor 传感器采集任务**是两个独立的 FreeRTOS 任务。它们需要交换两类数据：

```
┌─────────────────────┐         ┌─────────────────────┐
│   LVGL 显示任务      │         │   Sensor 采集任务     │
│  (display_refresh)  │         │                     │
│                     │  队列   │                     │
│  UI 事件 ──────────►│────────►│  页面切换 → 调整      │
│  "进入心率页面"      │         │  传感器采样策略       │
│                     │         │                     │
│                      │ 全局   │                      │
│  读取传感器数据 ◄────│ 结构体  │──── 写入传感器数据    │
│  g_lvgl_data.hr     │         │  g_lvgl_data.hr = 72 │
│                     │         │                     │
└─────────────────────┘         └─────────────────────┘

数据流向：
  LVGL → Sensor: 单向，队列传递 UI 事件（用户当前在看哪个页面）
  Sensor → LVGL: 单向，全局结构体写入（传感器最新读数）
```

> **为什么不把 LVGL 和 Sensor 合并到同一个任务？**
> 传感器采集有严格的时序要求（I2C 读取、滤波算法），如果和 LVGL 的 `lv_task_handler()` 在同一个循环中，渲染耗时（>10ms）会打乱采样间隔，导致传感器数据抖动。分离开来，Sensor 任务可以独立控制采样频率，不受 UI 渲染影响。

## 2. 全局数据结构：lvgl_data_t

### 2.1 数据定义

```c
// lvgl_port.h — LVGL 与 Sensor 共享的数据结构

typedef struct {
    // 传感器数据
    uint8_t  temperature;    // 温度 (°C, 来自 AHT21)
    uint16_t pressure;       // 气压 (hPa, 来自 BMP280)
    uint16_t heart_rate;     // 心率 (bpm, 来自 EM7028)
    uint16_t step_count;     // 步数 (来自 MPU6050 计步算法)

    // RTC 时间
    uint16_t year;           // 年 (2026)
    uint8_t  month;          // 月 (1-12)
    uint8_t  day;            // 日 (1-31)
    uint8_t  hour;           // 时 (0-23)
    uint8_t  minute;         // 分 (0-59)
    uint8_t  second;         // 秒 (0-59)
} lvgl_data_t;

// 全局实例 — Sensor 任务写入，LVGL 任务读取
lvgl_data_t g_lvgl_data;

// 为什么用结构体而不是多个独立全局变量？
// 1. 结构化：一个 memcpy 就能快照所有数据
// 2. 可扩展：增加新传感器只需添加结构体成员
// 3. 可审计：grep "g_lvgl_data\." 就能找到所有读写点
```

### 2.2 Sensor 写入端

```c
// lvgl_port.c — Sensor 任务通过回调函数写入数据
// 这些函数在 Sensor 任务的上下文中调用

void lvgl_temperature_get_data(uint8_t temperature)
{
    g_lvgl_data.temperature = temperature;
    // 原子写入 — uint8_t 在 Cortex-M4 上是单指令 store，不需要锁
}

void lvgl_pressure_get_data(uint16_t pressure)
{
    g_lvgl_data.pressure = pressure;
}

void lvgl_heart_rate_get_data(uint16_t heart_rate)
{
    g_lvgl_data.heart_rate = heart_rate;
}

void lvgl_step_count_get_data(uint16_t step_count)
{
    g_lvgl_data.step_count = step_count;
}

void lvgl_time_get_data(uint16_t year, uint8_t month, uint8_t day,
                         uint8_t hour, uint8_t minute, uint8_t second)
{
    g_lvgl_data.year   = year;
    g_lvgl_data.month  = month;
    g_lvgl_data.day    = day;
    g_lvgl_data.hour   = hour;
    g_lvgl_data.minute = minute;
    g_lvgl_data.second = second;
    // 注：这里 6 个字段的写入不是原子的
    // 可能出现 LVGL 读到"月=3 日=18 时=14 分=59 秒=00"（跨秒边界）
    // 对于显示场景，这个误差可接受（下一帧就会修正）
}
```

### 2.3 LVGL 读取端

```c
// LVGL 定时器回调中读取（每 100ms 执行一次）
void Watch_Giral_timer_exe_cb(lv_timer_t *timer)
{
    // 直接读取全局结构体 — 不经过队列，零拷贝，零延迟
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_2,
        "%d", g_lvgl_data.temperature);
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_3,
        "%d", g_lvgl_data.heart_rate);
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_4,
        "%d", g_lvgl_data.pressure);
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_5,
        "%d", g_lvgl_data.step_count);
    // ...
}
```

### 2.4 数据时效性检测

```c
// lvgl_port.c — 数据超时检测
// 如果 Sensor 任务卡死，LVGL 应该知道数据已经过期

uint32_t last_data_timestamp = 0;
#define DATA_TIMEOUT_MS  30000  // 30 秒无新数据 → 判定传感器异常

// Sensor 任务每次写入数据后更新时间戳
void lvgl_temperature_get_data(uint8_t temperature)
{
    g_lvgl_data.temperature = temperature;
    last_data_timestamp = osal_task_get_tick_count();
}

// LVGL 定时器中检查
void check_data_freshness(void)
{
    uint32_t now = osal_task_get_tick_count();
    if ((now - last_data_timestamp) > DATA_TIMEOUT_MS) {
        // 数据过期 → 显示 "--" 或闪烁指示
        lv_label_set_text(guider_ui.WatchGiral_1_label_2, "--");
    }
}
```

## 3. UI 事件：队列驱动的页面切换通知

### 3.1 问题：为什么 LVGL 需要通知 Sensor？

Bicycle_Watch 的 Sensor 任务根据用户当前查看的页面动态调整传感器采样频率：

| 当前页面 | 需要的数据 | Sensor 采样策略 |
|---------|-----------|---------------|
| 表盘主页 | 全部数据 | 全速采样（温度 1Hz、心率 10Hz） |
| 心率详情页 | 心率（高精度）| 心率加速到 25Hz |
| 天气页 | 温度、气压 | 只采样环境传感器 |
| 菜单/设置 | 无 | 暂停采样，省电 |

### 3.2 事件队列

```c
// lvgl_port.c — UI 事件队列
// LVGL 进入某个页面时 → 将 UI 事件放入队列 → Sensor 任务读取后调整策略

// 队列句柄（在初始化时创建）
os_queue_handle_t g_ui_event_queue;

// UI 状态枚举
typedef enum {
    UI_STATE_Welcome,        // 欢迎页
    UI_STATE_WatchGiral_1,   // 表盘主页
    UI_STATE_WatchGiral_3,   // 模拟时钟
    UI_STATE_Weather,        // 天气页
    UI_STATE_Pmscreen,       // 气压详情页
    UI_STATE_Heart,          // 心率详情页
    // ... 其他页面
} ui_state_t;

// LVGL 进入页面时调用（在 setup_scr 函数中触发）
void lvgl_WatchGiral_1_enter(void)
{
    ui_state_t ui_event = UI_STATE_WatchGiral_1;

    // 将 UI 事件放入队列（非阻塞，队列满则丢弃）
    if (osal_queue_send(g_ui_event_queue, &ui_event, 0) != OSAL_SUCCESS) {
        // 队列满 → 记录日志（正常情况极少发生）
        DEBUG_OUT("LVGL: Failed to send WatchGiral_1 UI event\n");
    }
}

void lvgl_Heart_enter(void)
{
    ui_state_t ui_event = UI_STATE_Heart;
    osal_queue_send(g_ui_event_queue, &ui_event, 0);
}

void lvgl_Weather_enter(void)
{
    ui_state_t ui_event = UI_STATE_Weather;
    osal_queue_send(g_ui_event_queue, &ui_event, 0);
}

// ... 每个页面都有对应的 enter 函数
```

### 3.3 Sensor 任务消费事件

```c
// Sensor 任务主循环中消费 UI 事件
void sensor_task(void *argument)
{
    ui_state_t current_page = UI_STATE_Welcome;

    while (1) {
        // ① 非阻塞检查 UI 事件队列
        ui_state_t ui_event;
        while (osal_queue_recv(g_ui_event_queue, &ui_event, 0)
               == OSAL_SUCCESS) {
            current_page = ui_event;  // 更新当前页面
        }

        // ② 根据当前页面决定采样策略
        switch (current_page) {
        case UI_STATE_WatchGiral_1:
            // 全量采样：1Hz
            read_all_sensors_once_per_second();
            break;
        case UI_STATE_Heart:
            // 心率高频率采样：25Hz
            read_heart_rate_high_freq();
            break;
        case UI_STATE_Weather:
        case UI_STATE_Pmscreen:
            // 环境传感器
            read_environment_sensors();
            break;
        default:
            // 菜单/设置 → 最小采样（只读 RTC 时间）
            break;
        }

        // ③ 将最新数据写入全局结构体
        lvgl_temperature_get_data(temp);
        lvgl_heart_rate_get_data(hr);
        // ...

        osal_task_delay_ms(40);  // 25Hz 基础循环
    }
}
```

## 4. OTA 状态：双向读写接口

OTA 升级场景中，LVGL 需要知道升级状态（是否有新固件、下载进度），同时也需要通知 Sensor 任务用户的选择（同意/拒绝升级）。这种双向通信使用简单的轮询读写接口：

### 4.1 OTA 屏幕状态

```c
// LVGL 页面读取 OTA 状态 → 决定是否弹窗
typedef enum {
    UI_STATE_OTA_NONE = 0,        // 无 OTA 事件
    UI_STATE_OTA_UPGRADE_REQ = 1, // 有新固件可用
    UI_STATE_OTA_COMPLETED = 2,   // 升级完成
} ui_state_ota_t;

static ui_state_ota_t en_ota_screen_state = UI_STATE_OTA_NONE;

// Sensor 任务写入（发现新固件时）
void lvgl_ota_screen_write(ui_state_ota_t t_en_state)
{
    en_ota_screen_state = t_en_state;
}

// LVGL 定时器轮询读取
void lvgl_ota_screen_read(ui_state_ota_t *t_p_en_state)
{
    *t_p_en_state = en_ota_screen_state;
}

// LVGL 定时器中的检查逻辑：
ui_state_ota_t ota_scan_state;
lvgl_ota_screen_read(&ota_scan_state);
if (ota_scan_state == UI_STATE_OTA_UPGRADE_REQ) {
    // 弹窗提示用户升级
    ui_load_scr_animation(&guider_ui, &guider_ui.Systeamupdate, ...);
}
```

### 4.2 用户选择回传

```c
// LVGL 写入用户选择（同意/拒绝下载）
static uint8_t u8_user_switch_state = 0;  // 0=未确认, 1=同意, 2=拒绝

void lvgl_ota_download_requirest_state_write(uint8_t state)
{
    u8_user_switch_state = state;
    // 在 OTA 页面的按钮事件中调用：
    // "立即更新"按钮 → state=1
    // "稍后提醒"按钮 → state=2
}

// Sensor 任务轮询读取
uint8_t lvgl_ota_download_requirest_state_read(void)
{
    return u8_user_switch_state;
}

// OTA 下载进度（0-100）
static uint8_t u8_ota_download_percentage = 0;

// Sensor 任务写入进度
uint8_t lvgl_ota_download_percentage_write(uint8_t percentage)
{
    u8_ota_download_percentage = percentage;
}

// LVGL 进度条读取
uint8_t lvgl_ota_download_percentage_read(void)
{
    return u8_ota_download_percentage;
}
```

## 5. 线程安全设计原则

Bicycle_Watch 的数据交互没有使用互斥锁（mutex），而是靠以下原则保证安全：

### 5.1 原则一：基本类型原子访问

```c
// Cortex-M4 的单次对齐访问是原子的（ARMv7-M 架构保证）
// uint8_t、uint16_t、uint32_t 的读写不需要锁
g_lvgl_data.temperature = 25;  // 原子写入
uint8_t t = g_lvgl_data.temperature;  // 原子读取

// 但如果读写的变量 >32bit（如 struct 赋值）则不原子
// → 不直接 struct 整体赋值，改为逐字段写入
```

### 5.2 原则二：单向写入

```c
// 每个字段只有一个写入者：
//   g_lvgl_data.temperature → 只有 Sensor 任务写入
//   g_lvgl_data.temperature → LVGL 任务只读

// 单向写入 + 原子类型 = 无竞争条件，无需锁
```

### 5.3 原则三：队列解耦异步通知

```c
// UI 事件使用队列 → Sensor 不会错过页面切换事件
// LVGL 非阻塞发送 → 不会因为 Sensor 任务忙而阻塞 UI
osal_queue_send(g_ui_event_queue, &ui_event, 0);  // timeout=0 非阻塞

// Sensor 非阻塞接收 → 取到最新事件就处理，队列空就跳过
osal_queue_recv(g_ui_event_queue, &ui_event, 0);
```

### 5.4 原则四：避免 LVGL API 跨任务调用

```c
// ⚠️ 绝对不要在 Sensor 任务中直接调用 LVGL API！
// lv_label_set_text() 等函数不是线程安全的
// → Sensor 任务只操作 g_lvgl_data
// → LVGL 任务在 lv_timer 回调中读取 g_lvgl_data 并更新控件

// 如果需要 Sensor 任务立即触发 LVGL 更新（如紧急告警）：
// → 设置标志位 + LVGL 轮询检查
// → 不直接调用 LVGL API
```

## 6. 完整数据流：从传感器到屏幕的一次刷新

```
时间线：一次心率数据的完整旅程

t=0ms    MAX30102 心率传感器通过 I2C 采集原始 PPG 数据
         ↓
t=5ms    Sensor 任务读取 FIFO，运行滤波算法
         ↓
t=6ms    lvgl_heart_rate_get_data(72)
         → g_lvgl_data.heart_rate = 72
         → last_data_timestamp = now
         ↓
t=100ms  LVGL 定时器触发 Watch_Giral_timer_exe_cb()
         → lv_label_set_text_fmt(label_3, "%d", g_lvgl_data.heart_rate)
         → 控件标记为脏（dirty）
         ↓
t=101ms  lv_task_handler() 检测到脏控件
         → 重绘 label_3 区域
         → flush_cb → SPI DMA → ST7789
         ↓
t=120ms  屏幕显示 "72"（用户可见）

总延迟：~120ms（用户体感不到延迟）
```

## 7. 数据交互接口设计总结

| 数据类型 | 传递方向 | 传递方式 | 频率 | 延迟 |
|---------|---------|---------|------|------|
| 传感器读数 | Sensor → LVGL | 全局结构体（轮询） | LVGL 100ms 刷新 | <200ms |
| UI 页面事件 | LVGL → Sensor | FreeRTOS 队列（推送） | 页面切换时 | <40ms |
| OTA 升级状态 | Sensor → LVGL | 全局标志位（轮询） | LVGL 1s 检查 | <1s |
| 用户操作反馈 | LVGL → Sensor | 全局标志位（轮询） | Sensor 任务检查 | <40ms |
| 紧急告警 | Sensor → LVGL | 全局标志位 | 实时 | <100ms |

## 下一步

最后一篇将介绍 **LVGL 高级控件实战与动画效果**：模拟时钟控件（`lv_analogclock`）、弧形进度条面板、滚动联动菜单、自定义字体与图片、`lv_anim` 动画系统（路径动画、回弹效果、淡入淡出、缩放），以及在 Bicycle_Watch 中的实际应用案例。
