---
title: LVGL 实现码表主界面：速度大数字、骑行时间、里程和心率刷新
date: 2026-07-16 11:00:00
categories:
  - 项目实战
  - RidePulse
  - LVGL
tags:
  - LVGL
  - STM32
  - 自行车码表
  - UI
  - 嵌入式显示
description: 在现有 STM32 智能手表工程中新增自行车码表 UI，设计 LVGL 数据接口、码表主界面、刷新周期和 UI 与业务层解耦方式。
top_img: /img/covers/ridepulse-cover.svg
---

前面已经设计了轮速采集和 RideTask。现在要把骑行数据显示到屏幕上。

这个项目原本已经有 LVGL 显示任务和 UI 页面，改造成码表时不要把 UI 和业务逻辑混在一起。比较稳妥的方式是继续使用 `lvgl_port.c` 作为中间层：RideTask 负责计算速度和里程，把数据写到 LVGL port；LVGLTask 周期读取数据，只负责更新控件。

## 当前显示架构

现有显示相关文件主要在：

```text
01_APP/User_Display/user_display.c
01_APP/User_Display/user_display.h
01_APP/User_Display/Port/lvgl_port.c
01_APP/User_Display/Port/lvgl_port.h
01_APP/LVGL_ui/
```

当前 `display_refresh_task()` 的典型职责：

- 初始化 LVGL。
- 初始化显示驱动。
- 初始化触摸输入。
- 创建 UI 页面。
- 循环调用 `lv_task_handler()`。
- 喂软件看门狗。

类似：

```c
void display_refresh_task(void *argument)
{
    lv_init();
    lv_port_disp_init();
    lv_port_indev_init();

    setup_ui(&guider_ui);

    watchdog_register(osal_task_get_current_handle(), 2000, "LVGLTask");

    for (;;) {
        watchdog_feed(osal_task_get_current_handle());
        lv_task_handler();
        osal_task_delay_ms(1);
    }
}
```

码表 UI 的改造应该尽量沿用这个框架。

## UI 设计目标

骑行时用户看屏幕的时间很短，所以码表页面要遵守一个原则：

> 最重要的数据最大，辅助数据少而清楚。

主页面建议显示：

- 当前速度：最大字号，居中。
- 单位 `km/h`：紧跟速度，字号小。
- 本次里程：底部一栏。
- 骑行时间：底部一栏。
- 心率或电量：底部一栏。
- 状态：开始、骑行中、暂停、保存中。

布局示意：

```text
┌────────────────────────┐
│          RIDING         │
│                        │
│          28.6           │
│          km/h           │
│                        │
│   12.4 km   00:38:21   │
│   HR 142    BAT 78%    │
└────────────────────────┘
```

如果屏幕较小，优先保留：

1. 速度
2. 里程
3. 时间

心率、电量、海拔可以放在第二页。

## 新增 UI 状态

当前工程已有 `ui_state_t`，用于 LVGL 页面进入时通知 `SensorTask`。后续可以增加：

```c
typedef enum {
    UI_STATE_Welcome = 0,
    UI_STATE_WatchGiral_1,
    UI_STATE_Weather,
    UI_STATE_Pmscreen,
    UI_STATE_Heart,
    UI_STATE_BikeMain,      /* 新增：码表主页面 */
    UI_STATE_BikeDetail,    /* 新增：骑行详情页 */
    UI_STATE_RideHistory,   /* 新增：骑行历史页 */
    UI_STATE_MAX
} ui_state_t;
```

如果不想一次改太多，可以第一阶段只加 `UI_STATE_BikeMain`。

进入码表页面时，通知传感器任务：

```c
void lvgl_BikeMain_enter(void)
{
    ui_state_t ui_event = UI_STATE_BikeMain;

    if (osal_queue_send(g_ui_event_queue, &ui_event, 0) != OSAL_SUCCESS) {
        DEBUG_OUT("LVGL: Failed to send BikeMain UI event");
    }
}
```

然后在 `service_sensor.c` 中增加：

```c
case UI_STATE_BikeMain:
    sensor_start_sampling(SENSOR_HEARTRATE, 1000);
    sensor_start_sampling(SENSOR_PRESSURE, 2000);
    break;
```

这样进入码表页时，心率和气压采样才会开启，离开页面后可以降低采样频率。

## LVGL 数据结构

在 `lvgl_port.h` 中新增码表数据：

```c
typedef enum {
    LVGL_RIDE_STATE_IDLE = 0,   /* 空闲，未进入码表页面 */
    LVGL_RIDE_STATE_READY,      /* 就绪，已进入页面但未开始骑行 */
    LVGL_RIDE_STATE_RIDING,     /* 骑行中 */
    LVGL_RIDE_STATE_PAUSED,     /* 已暂停 */
    LVGL_RIDE_STATE_SAVING,     /* 骑行结束，正在保存记录 */
} lvgl_ride_state_t;

typedef struct {
    uint16_t speed_x10_kmh;       /* 当前速度，km/h * 10 */
    uint32_t distance_m;          /* 累计里程，单位米 */
    uint32_t ride_time_s;         /* 骑行时长，单位秒 */
    uint16_t heart_rate;          /* 当前心率，0 表示无数据 */
    uint8_t battery_percent;      /* 电池电量百分比 */
    lvgl_ride_state_t state;      /* 骑行状态 */
    uint32_t update_tick;         /* 数据写入时的系统 tick，用于超时检测 */
} lvgl_ride_data_t;
```

为什么用 `speed_x10_kmh`？

- 避免浮点。
- UI 可以显示一位小数。
- 与 RideTask 中的速度计算一致。

例如：

```text
286 -> 28.6 km/h
```

## LVGL 数据接口

在 `lvgl_port.h` 中声明：

```c
void lvgl_ride_data_write(const lvgl_ride_data_t *data);
void lvgl_ride_data_read(lvgl_ride_data_t *data);
void lvgl_BikeMain_enter(void);
```

在 `lvgl_port.c` 中实现：

```c
static lvgl_ride_data_t g_ride_data;  /* 全局骑行数据快照，由 RideTask 写、LVGLTask 读 */

void lvgl_ride_data_write(const lvgl_ride_data_t *data)
{
    if (data == NULL) {
        return;
    }

    /*
     * 这里是 RideTask -> LVGLTask 的数据快照。
     * 如果后续出现并发问题，可以加 mutex 或临界区。
     * 结构体较小，直接整体拷贝即可，无需逐字段赋值。
     */
    g_ride_data = *data;
}

void lvgl_ride_data_read(lvgl_ride_data_t *data)
{
    if (data == NULL) {
        return;
    }

    *data = g_ride_data;  /* LVGLTask 读走数据快照用于 UI 刷新 */
}
```

第一阶段可以直接拷贝结构体。这个结构体不大，拷贝成本很低。

如果后续数据变多或出现撕裂，可以加锁：

```c
osal_mutex_take(g_lvgl_data_mutex, 10);
g_ride_data = *data;
osal_mutex_give(g_lvgl_data_mutex);
```

## RideTask 写 UI 数据

在 `ride_computer.c` 中：

```c
#include "lvgl_port.h"

void ride_computer_publish_to_ui(void)
{
    lvgl_ride_data_t ui_data;

    /* 从 RideService 内部结构体组装 LVGL 数据接口，解耦业务与 UI 层 */
    ui_data.speed_x10_kmh = s_ride.current_speed_x10_kmh;
    ui_data.distance_m = s_ride.distance_m;
    ui_data.ride_time_s = s_ride.ride_time_s;
    ui_data.heart_rate = sensor_heart_rate_read();       /* 从传感器服务读取心率 */
    ui_data.battery_percent = battery_get_percent();     /* 从电源管理读取电量 */
    ui_data.state = (lvgl_ride_state_t)s_ride.state;
    ui_data.update_tick = osal_task_get_tick_count();    /* 记录数据产生时间，用于 UI 超时检测 */

    lvgl_ride_data_write(&ui_data);
}
```

如果暂时没有 `sensor_heart_rate_read()` 或 `battery_get_percent()`，可以先填 0 或模拟值：

```c
ui_data.heart_rate = 0;
ui_data.battery_percent = 100;
```

不要为了等心率数据而阻塞 RideTask。

## 新增码表页面文件

如果使用 GUI Guider 生成页面，可以在 GUI 工具里新建页面。  
如果手写 LVGL 页面，可以新增：

```text
01_APP/LVGL_ui/setup_scr_BikeMain.c
01_APP/LVGL_ui/setup_scr_BikeMain.h
```

或者先放到已有 UI 文件里验证。

建议第一阶段手写一个简单页面，等功能稳定再用 GUI 工具美化。

## 控件结构

码表主页面需要这些控件：

```c
typedef struct {
    lv_obj_t *screen;          /* 码表主页面容器 */
    lv_obj_t *label_state;     /* 状态标签：READY / RIDING / PAUSED / SAVING */
    lv_obj_t *label_speed;     /* 速度大数字，最大字号居中显示 */
    lv_obj_t *label_unit;      /* 单位标签 "km/h" */
    lv_obj_t *label_distance;  /* 里程标签，底部左侧 */
    lv_obj_t *label_time;      /* 骑行时间标签，底部右侧 */
    lv_obj_t *label_heart;     /* 心率标签 */
    lv_obj_t *label_battery;   /* 电量标签 */
} bike_main_ui_t;
```

如果工程已有 `lv_ui guider_ui`，也可以把这些控件加到 `lv_ui` 结构体中。

## 创建页面

示例：

```c
static bike_main_ui_t s_bike_ui;

void setup_scr_BikeMain(lv_ui *ui)
{
    s_bike_ui.screen = lv_obj_create(NULL);
    lv_obj_clear_flag(s_bike_ui.screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(s_bike_ui.screen, lv_color_hex(0x101820), 0);

    s_bike_ui.label_state = lv_label_create(s_bike_ui.screen);
    lv_label_set_text(s_bike_ui.label_state, "READY");
    lv_obj_set_style_text_color(s_bike_ui.label_state, lv_color_hex(0x9adbcf), 0);
    lv_obj_align(s_bike_ui.label_state, LV_ALIGN_TOP_MID, 0, 12);

    s_bike_ui.label_speed = lv_label_create(s_bike_ui.screen);
    lv_label_set_text(s_bike_ui.label_speed, "0.0");
    lv_obj_set_style_text_color(s_bike_ui.label_speed, lv_color_hex(0xffffff), 0);
    lv_obj_set_style_text_font(s_bike_ui.label_speed, &lv_font_montserrat_48, 0);
    lv_obj_align(s_bike_ui.label_speed, LV_ALIGN_CENTER, 0, -28);

    s_bike_ui.label_unit = lv_label_create(s_bike_ui.screen);
    lv_label_set_text(s_bike_ui.label_unit, "km/h");
    lv_obj_set_style_text_color(s_bike_ui.label_unit, lv_color_hex(0xaeb8c2), 0);
    lv_obj_align_to(s_bike_ui.label_unit, s_bike_ui.label_speed, LV_ALIGN_OUT_BOTTOM_MID, 0, 4);

    s_bike_ui.label_distance = lv_label_create(s_bike_ui.screen);
    lv_label_set_text(s_bike_ui.label_distance, "0.00 km");
    lv_obj_set_style_text_color(s_bike_ui.label_distance, lv_color_hex(0xffffff), 0);
    lv_obj_align(s_bike_ui.label_distance, LV_ALIGN_BOTTOM_LEFT, 16, -42);

    s_bike_ui.label_time = lv_label_create(s_bike_ui.screen);
    lv_label_set_text(s_bike_ui.label_time, "00:00:00");
    lv_obj_set_style_text_color(s_bike_ui.label_time, lv_color_hex(0xffffff), 0);
    lv_obj_align(s_bike_ui.label_time, LV_ALIGN_BOTTOM_RIGHT, -16, -42);

    s_bike_ui.label_heart = lv_label_create(s_bike_ui.screen);
    lv_label_set_text(s_bike_ui.label_heart, "HR --");
    lv_obj_set_style_text_color(s_bike_ui.label_heart, lv_color_hex(0xff6b6b), 0);
    lv_obj_align(s_bike_ui.label_heart, LV_ALIGN_BOTTOM_LEFT, 16, -14);

    s_bike_ui.label_battery = lv_label_create(s_bike_ui.screen);
    lv_label_set_text(s_bike_ui.label_battery, "BAT --%");
    lv_obj_set_style_text_color(s_bike_ui.label_battery, lv_color_hex(0x9adbcf), 0);
    lv_obj_align(s_bike_ui.label_battery, LV_ALIGN_BOTTOM_RIGHT, -16, -14);
}
```

字体要根据工程实际启用情况调整。如果 `lv_font_montserrat_48` 没有编译进来，就换成已有字体。

## 更新时间格式

骑行时间是秒数，UI 要显示成 `HH:MM:SS`。

```c
static void format_ride_time(uint32_t total_s, char *buf, uint32_t buf_size)
{
    /* 将秒数转换为 HH:MM:SS 格式字符串 */
    uint32_t h = total_s / 3600U;
    uint32_t m = (total_s % 3600U) / 60U;
    uint32_t s = total_s % 60U;

    snprintf(buf, buf_size, "%02lu:%02lu:%02lu", h, m, s);
}
```

速度格式：

```c
static void format_speed(uint16_t speed_x10, char *buf, uint32_t buf_size)
{
    /* 将 km/h*10 的定点数转换为 X.X 格式字符串，例如 286 -> "28.6" */
    snprintf(buf, buf_size, "%lu.%lu",
             speed_x10 / 10U,
             speed_x10 % 10U);
}
```

里程格式：

```c
static void format_distance(uint32_t distance_m, char *buf, uint32_t buf_size)
{
    /* 将米转换为 X.XX km 格式，例如 12340m -> "12.34 km" */
    uint32_t km_int = distance_m / 1000U;
    uint32_t km_frac = (distance_m % 1000U) / 10U;

    snprintf(buf, buf_size, "%lu.%02lu km", km_int, km_frac);
}
```

## 页面刷新函数

不要每次 `lv_task_handler()` 都更新所有 label。建议 200ms 刷新一次码表数据。

```c
void bike_main_screen_update(void)
{
    /* 由 LVGLTask 周期性调用，从 lvgl_port 读取骑行数据并更新所有 label 控件 */
    static uint32_t s_last_update_tick = 0;
    uint32_t now = osal_task_get_tick_count();
    lvgl_ride_data_t data;

    char speed_buf[16];
    char distance_buf[24];
    char time_buf[16];
    char heart_buf[16];
    char battery_buf[16];

    if ((now - s_last_update_tick) < 200U) {
        return;
    }
    s_last_update_tick = now;

    lvgl_ride_data_read(&data);

    format_speed(data.speed_x10_kmh, speed_buf, sizeof(speed_buf));
    format_distance(data.distance_m, distance_buf, sizeof(distance_buf));
    format_ride_time(data.ride_time_s, time_buf, sizeof(time_buf));

    snprintf(heart_buf, sizeof(heart_buf), "HR %u", data.heart_rate);
    snprintf(battery_buf, sizeof(battery_buf), "BAT %u%%", data.battery_percent);

    lv_label_set_text(s_bike_ui.label_speed, speed_buf);
    lv_label_set_text(s_bike_ui.label_distance, distance_buf);
    lv_label_set_text(s_bike_ui.label_time, time_buf);
    lv_label_set_text(s_bike_ui.label_heart, heart_buf);
    lv_label_set_text(s_bike_ui.label_battery, battery_buf);

    switch (data.state) {
    case LVGL_RIDE_STATE_RIDING:
        lv_label_set_text(s_bike_ui.label_state, "RIDING");
        break;
    case LVGL_RIDE_STATE_PAUSED:
        lv_label_set_text(s_bike_ui.label_state, "PAUSED");
        break;
    case LVGL_RIDE_STATE_SAVING:
        lv_label_set_text(s_bike_ui.label_state, "SAVING");
        break;
    default:
        lv_label_set_text(s_bike_ui.label_state, "READY");
        break;
    }
}
```

如果页面不在当前显示状态，就不要更新控件，避免访问未创建或已切换页面的对象。

可以加一个页面状态：

```c
static bool s_bike_main_active = false;
```

进入页面时设为 `true`，离开页面时设为 `false`。

## 接入 LVGLTask

在 `display_refresh_task()` 的循环中：

```c
for (;;) {
    watchdog_feed(osal_task_get_current_handle());

    if (s_bike_main_active) {
        bike_main_screen_update();
    }

    lv_task_handler();
    osal_task_delay_ms(1);
}
```

也可以用 LVGL timer：

```c
static void bike_main_timer_cb(lv_timer_t *timer)
{
    bike_main_screen_update();
}

lv_timer_create(bike_main_timer_cb, 200, NULL);
```

如果项目里 LVGL 版本较老，用的是 `lv_task_create()`，就按当前版本 API 调整。

## 页面进入事件

进入码表页面时要做三件事：

1. 通知 SensorTask 开启心率等采样。
2. 通知 RideTask 进入 ready/riding 状态。
3. 标记当前页面为 BikeMain。

示例：

```c
void bike_main_on_load(void)
{
    s_bike_main_active = true;       /* 标记页面已激活，LVGLTask 将开始刷新本页 */
    lvgl_BikeMain_enter();           /* 通知 SensorTask 进入码表页面，开启心率/气压采样 */
    ride_start();                    /* 调试阶段自动开始骑行，后续改为用户按键触发 */
}
```

如果不想进入页面就自动开始骑行，可以改成：

```c
ride_set_ready();
```

然后用按钮或触摸事件触发 `ride_start()`。

## 按钮与触摸事件

如果屏幕支持触摸，可以加一个开始/暂停按钮：

```c
static void bike_start_btn_event_cb(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);

    /* 点击按钮时切换骑行/暂停状态：骑行中点击 -> 暂停，暂停中点击 -> 恢复 */
    if (code == LV_EVENT_CLICKED) {
        if (ride_computer_is_riding()) {
            ride_pause();
        } else {
            ride_resume();
        }
    }
}
```

不过骑行时触摸操作不一定方便。第一阶段可以不做按钮，先自动开始，后续再完善。

## UI 数据超时

如果 RideTask 卡住，UI 不应该一直显示旧速度。可以使用 `update_tick` 判断数据是否过期。

```c
#define RIDE_UI_DATA_TIMEOUT_MS 2000U

if ((now - data.update_tick) > RIDE_UI_DATA_TIMEOUT_MS) {
    lv_label_set_text(s_bike_ui.label_speed, "--");
    lv_label_set_text(s_bike_ui.label_state, "NO DATA");
    return;
}
```

这个逻辑可以帮助调试：如果 UI 显示 `NO DATA`，说明 RideTask 没有正常推送。

## 避免 UI 阻塞

LVGLTask 里不要做这些事：

- 读取 I2C 传感器。
- 写 Flash。
- 等 OTA 数据。
- 等队列很久。
- 做复杂速度计算。

这些都应该放到对应任务里。LVGLTask 的职责是：

- 读取已经准备好的数据快照。
- 更新控件。
- 调用 `lv_task_handler()`。

这样 UI 才不会卡。

## 与 SensorTask 的关系

现有 `service_sensor.c` 里已经按 UI 页面控制采样：

```c
case UI_STATE_Heart:
    sensor_start_sampling(SENSOR_HEARTRATE, 100);
    break;
```

码表页面可以新增：

```c
case UI_STATE_BikeMain:
    sensor_start_sampling(SENSOR_HEARTRATE, 1000);
    sensor_start_sampling(SENSOR_PRESSURE, 2000);
    break;
```

为什么心率用 1000ms？

- 码表主页面只需要趋势，不需要每 100ms 刷新。
- 心率算法本身也需要一定时间窗口。
- 低频采样更省电。

如果用户进入单独的心率页，再提高采样频率。

## 与背光控制的关系

骑行时屏幕可读性很重要。建议：

- 骑行中保持较高亮度。
- 暂停一段时间后降低亮度。
- 长时间暂停后息屏，但保留轮速中断唤醒。

可以让 RideTask 通知系统状态：

```c
if (s_ride.state == RIDE_STATE_RIDING) {
    display_backlight_request(DISPLAY_BRIGHTNESS_HIGH);
}
```

如果已有 `DisplayBlackLightQueue`，可以通过队列发送亮度请求。

## 页面切换建议

第一阶段只做一个主页面：

```text
BikeMain
```

第二阶段再加：

```text
BikeDetail
  平均速度
  最大速度
  海拔
  温度

RideHistory
  最近骑行记录
```

页面切换可以用左右滑动，或者菜单入口。骑行主页面不要放太多入口，避免误触。

## 调试步骤

### 1. 先用假数据验证 UI

在 RideTask 中写死：

```c
ui_data.speed_x10_kmh = 286;
ui_data.distance_m = 12340;
ui_data.ride_time_s = 2301;
ui_data.heart_rate = 142;
ui_data.battery_percent = 78;
ui_data.state = LVGL_RIDE_STATE_RIDING;
```

期望显示：

```text
28.6 km/h
12.34 km
00:38:21
HR 142
BAT 78%
```

### 2. 再接 RideTask 实际数据

确认速度和里程跟串口日志一致。

### 3. 最后接轮速中断

用按键或信号发生器模拟脉冲，观察 UI 是否刷新。

## 建议日志

LVGLTask 不要高频打印。可以在页面加载时打印：

```text
BikeMain loaded
BikeMain active
BikeMain data timeout
```

RideTask 每秒打印：

```text
ride speed=28.6 distance=12340 time=2301 state=RIDING
```

如果 UI 和日志数据不一致，优先检查：

- `lvgl_ride_data_write()` 是否被调用。
- `bike_main_screen_update()` 是否被调用。
- 页面 active 标志是否正确。
- 格式化函数是否有整数除法问题。

## 常见问题

### 页面速度显示不刷新

检查：

- RideTask 是否启动。
- `lvgl_ride_data_write()` 是否被调用。
- `bike_main_screen_update()` 是否在 LVGLTask 中执行。
- 页面控件指针是否有效。

### 显示乱码

可能是字体不支持中文或符号。码表主页面尽量用数字和英文单位，减少字体问题。

### UI 卡顿

检查 LVGLTask 中是否做了阻塞操作。码表页面更新只应该设置 label 文本，不应该读传感器或写 Flash。

### 数字抖动太厉害

速度数据本身可能抖动。应该在 RideTask 中滤波，而不是 UI 层处理。

### 屏幕太小放不下

优先保留速度、里程、时间。心率和电量可以缩小或放到第二页。

## 小结

码表 UI 的重点不是控件多，而是数据清楚、刷新稳定、任务边界明确。

这一篇的核心改造是：

- 新增 `UI_STATE_BikeMain`。
- 在 `lvgl_port.c` 增加 `lvgl_ride_data_t` 数据接口。
- RideTask 写数据，LVGLTask 读数据。
- 新增 BikeMain 页面，显示速度、里程、骑行时间、心率和电量。
- 控制刷新周期，避免 UI 线程阻塞。

完成这一篇后，RidePulse 就能把轮速计算结果显示出来。下一篇会把一次骑行保存到外部 Flash，让码表从实时显示变成有历史记录的设备。
