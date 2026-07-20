---
title: LVGL 移植与 Bicycle_Watch 分层架构设计
date: 2025-11-05
categories:
  - 技术笔记
  - 嵌入式
  - LVGL开发
tags:
  - LVGL
  - STM32
  - FreeRTOS
  - 显示驱动
  - 触摸校准
  - LittleFS
  - Bicycle_Watch
description: LVGL 在 STM32F411 上的移植实践：分层架构设计、显示驱动适配（SPI+DMA）、触摸校准与 LittleFS 持久化、FreeRTOS 任务模型、看门狗集成
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# LVGL 移植与 Bicycle_Watch 分层架构设计

## 1. LVGL 在 Bicycle_Watch 中的位置

Bicycle_Watch 工程采用 **分层解耦架构**，LVGL 位于应用层——它不直接访问硬件，而是依赖下层提供的驱动抽象：

```
┌─────────────────────────────────────────────────┐
│              01_APP（应用层）                     │
│  ┌──────────────────┐  ┌─────────────────────┐  │
│  │  LVGL_ui/        │  │  User_Display/       │  │
│  │  GUI 页面 + 事件   │  │  display_refresh_task │  │
│  └────────┬─────────┘  └──────────┬──────────┘  │
│           │                       │              │
│  ┌────────┴───────────────────────┴──────────┐  │
│  │           lvgl_port（数据交互层）             │  │
│  │   UI 事件 → 队列 → Sensor任务               │  │
│  │   Sensor 数据 → 全局结构体 → LVGL 读取       │  │
│  └────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────┤
│        02_BSP_Platform（BSP 驱动封装层）          │
│  ┌────────────────┐  ┌──────────────────────┐   │
│  │ 显示驱动适配     │  │ 触摸驱动适配 (CST816T) │   │
│  │ SPI+DMA 刷新    │  │ I2C 中断 + 校准算法    │   │
│  └────────────────┘  └──────────────────────┘   │
├─────────────────────────────────────────────────┤
│        02_MCU_Platform（MCU 抽象层）              │
│  HAL_SPI / HAL_I2C / HAL_GPIO / HAL_DMA         │
└─────────────────────────────────────────────────┘
```

> **核心原则**：LVGL 代码不属于底层驱动，它是应用层的一个模块。LVGL 通过 `lv_port_disp_template` 和 `lv_port_indev_template` 调用 BSP 层提供的抽象接口，BSP 再调 HAL 操作寄存器。

## 2. LVGL 文件组织

在 Bicycle_Watch 工程中，LVGL 相关文件分散在几个目录：

```
01_APP/
├── LVGL_ui/                    ← GuiGuider 生成的 UI 代码
│   ├── gui_guider.c/h          ← UI 框架: setup_ui(), ui_load_scr_animation()
│   ├── events_init.c/h         ← 所有屏幕的事件注册
│   ├── widgets_init.c/h        ← 自定义控件初始化（键盘、模拟时钟）
│   ├── setup_scr_WatchGiral_1.c ← 表盘主屏幕
│   ├── setup_scr_WatchGiral_3.c ← 模拟时钟屏幕
│   ├── setup_scr_top_lap.c     ← 快捷控制面板
│   ├── setup_scr_menu_1.c      ← 菜单页 1
│   ├── setup_scr_Heart.c       ← 心率详情页
│   ├── setup_scr_Weather.c     ← 天气页
│   ├── ...                     ← 更多屏幕
│   ├── UI_Resource.h           ← ui 对象结构体声明
│   ├── images/                 ← 图片资源（.c 数组）
│   ├── guider_customer_fonts/  ← 自定义字体（.c 数组）
│   └── analogclock/            ← 模拟时钟自定义控件
│
├── User_Display/
│   ├── user_display.c/h        ← display_refresh_task（LVGL 主任务）
│   ├── Port/
│   │   └── lvgl_port.c/h       ← LVGL 与 Sensor 的数据交互层
│   └── Platform/
│       └── Display/
│           └── display_port.c/h ← 显示底层：初始化、背光、睡眠
│
02_BSP_Platform/
└── Platform_Interface/display/
    ├── bsp_adapter_port_display.c/h  ← 显示驱动适配（SPI 初始化、刷屏回调）
    └── bsp_wrapper_display.c/h       ← 显示功能封装（初始化、开/关）
```

## 3. 显示驱动移植

### 3.1 核心三要素

LVGL 在 MCU 上跑起来只需要三个条件：

| 条件 | 实现位置 | 说明 |
|------|---------|------|
| ① 心跳 | `lv_tick_inc()` | 每 1ms 调用一次，给 LVGL 提供时钟基准 |
| ② 刷新回调 | `lv_port_disp_init()` 中的 `flush_cb` | LVGL 画好一块区域后，通知驱动刷新到屏幕 |
| ③ 输入回调 | `lv_port_indev_init()` 中的 `read_cb` | 触摸/按键事件上报给 LVGL |

### 3.2 FreeRTOS 中的心跳

```c
// Bicycle_Watch 使用 FreeRTOS 的系统节拍作为 LVGL 的心跳
// 放在 FreeRTOS 的 vApplicationTickHook 或独立的定时器中断中

#include "lvgl.h"

// 方式一：在 SysTick 中断中直接调用（推荐，精度最高）
void SysTick_Handler(void)
{
    HAL_IncTick();              // HAL 库的 ms 计数器
    lv_tick_inc(1);             // LVGL 心跳 (+1ms)
}

// 方式二：如果 SysTick 被 RTOS 占用，用硬件定时器
void TIM7_IRQHandler(void)
{
    if (TIM7->SR & TIM_SR_UIF) {
        TIM7->SR = ~TIM_SR_UIF;
        lv_tick_inc(1);
    }
}
```

### 3.3 显示刷新回调

```c
// lv_port_disp_template.c — LVGL 显示刷新回调
// LVGL 渲染完一块像素数据后调用此函数，把数据推送到屏幕

// Bicycle_Watch 使用 SPI + DMA 驱动 ST7789 240×280 LCD
// LVGL 分配了两个屏幕大小的缓冲区（双缓冲），通过 DMA 异步传输

static lv_disp_draw_buf_t draw_buf_dsc;
static lv_color_t buf_1[240 * 10];  // 行缓冲 1（10 行，减少 RAM 占用）
static lv_color_t buf_2[240 * 10];  // 行缓冲 2

void lv_port_disp_init(void)
{
    // ① 分配绘制缓冲区
    lv_disp_draw_buf_init(&draw_buf_dsc, buf_1, buf_2,
                          240 * 10);  // 单缓冲 240×10 像素 ≈ 4.7KB

    // ② 创建默认显示器
    static lv_disp_drv_t disp_drv;
    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res = 240;
    disp_drv.ver_res = 280;
    disp_drv.draw_buf = &draw_buf_dsc;
    disp_drv.flush_cb = disp_flush_cb;  // 刷新回调
    lv_disp_drv_register(&disp_drv);
}

// 刷新回调 — LVGL 每画完一个区域就调用一次
static void disp_flush_cb(lv_disp_drv_t *disp_drv,
                          const lv_area_t *area,
                          lv_color_t *color_p)
{
    // Bicycle_Watch 的实际实现：
    // ① 设置 LCD 写入窗口 (area->x1, area->y1) ~ (area->x2, area->y2)
    lcd_set_window(area->x1, area->y1, area->x2, area->y2);

    // ② 启动 SPI DMA 传输（异步，不阻塞 LVGL 渲染）
    uint32_t pixel_cnt = (area->x2 - area->x1 + 1) *
                         (area->y2 - area->y1 + 1);
    lcd_spi_dma_send((uint8_t *)color_p, pixel_cnt * 2);

    // ③ DMA 传输完成中断中调用 lv_disp_flush_ready()
    // lv_disp_flush_ready() 告诉 LVGL 缓冲区可以继续用于渲染
    // 这一步在 DMA 完成回调中执行：
    //   void SPI2_DMA_TX_Complete_Callback(void) {
    //       lv_disp_flush_ready(disp_drv);
    //   }
}
```

### 3.4 关键优化：为什么用双缓冲

```c
// 单缓冲 vs 双缓冲的对比：
//
// 单缓冲（1 个 buf）：
//   LVGL 渲染 → 刷新到 LCD(DMA) → 等待 DMA 完成 → LVGL 继续渲染
//   渲染和刷新串行，DMA 发送期间 LVGL 空闲等待
//
// 双缓冲（2 个 buf，Bicycle_Watch 采用的方案）：
//   LVGL 渲染到 buf_1
//   → 通知 DMA 发送 buf_1
//   → LVGL 立即用 buf_2 继续渲染下一块（不等待 DMA 完成）
//   → DMA 完成后通知 LVGL 释放 buf_1
//   → 渲染和刷新部分并行，整体刷新率提升 20-30%
//
// 代价：多消耗一个缓冲区的 RAM（240×10×2 ≈ 4.7KB）
```

## 4. 触摸输入移植

### 4.1 触摸驱动架构

Bicycle_Watch 使用 CST816T 电容触摸芯片，通过 I2C 与 STM32 通信。

```c
// lv_port_indev_template.c — 触摸输入适配

static lv_indev_drv_t indev_drv;
static lv_indev_t *indev_touchpad;

void lv_port_indev_init(void)
{
    lv_indev_drv_init(&indev_drv);
    indev_drv.type = LV_INDEV_TYPE_POINTER;    // 指针型输入设备
    indev_drv.read_cb = touchpad_read_cb;       // 读取回调
    indev_touchpad = lv_indev_drv_register(&indev_drv);
}

// LVGL 在每个 lv_task_handler() 周期中调用此函数读取触摸状态
static void touchpad_read_cb(lv_indev_drv_t *indev_drv,
                             lv_indev_data_t *data)
{
    static lv_coord_t last_x = 0;
    static lv_coord_t last_y = 0;

    // 从 CST816T 读取触摸状态（I2C）
    touch_state_t touch;
    cst816t_read_touch(&touch);

    if (touch.pressed) {
        // 应用校准矩阵，将原始触摸坐标转换为屏幕坐标
        touch_calibration_apply(&touch.x, &touch.y);
        last_x = touch.x;
        last_y = touch.y;
        data->state = LV_INDEV_STATE_PR;  // 按下
    } else {
        data->state = LV_INDEV_STATE_REL; // 释放
    }

    data->point.x = last_x;
    data->point.y = last_y;
}
```

### 4.2 触摸校准持久化

Bicycle_Watch 的校准数据保存在外部 Flash（LittleFS）中，每次开机自动加载，无需重复校准：

```c
// touch_calibration_ui.c — 触摸校准流程
//
// 校准流程：
//   1. 开机 → check_and_calibrate_touchscreen()
//   2. 尝试从 Flash 加载校准数据
//   3. 如果有效 → 直接使用
//   4. 如果无效/首次开机 → 显示校准 UI（3 个十字准星）
//   5. 用户点击完 3 个点 → 计算仿射变换矩阵
//   6. 保存到 Flash → 下次开机自动加载

typedef struct {
    float a;  // scale_x
    float b;  // skew_x
    float c;  // offset_x
    float d;  // skew_y
    float e;  // scale_y
    float f;  // offset_y
    bool is_calibrated;
} touch_calibration_t;

// 校准存储在 LittleFS 文件 /calib/touch_calib.bin
// 加载流程：
calibration_status_t touch_calibration_load_from_flash(
    touch_calibration_t *calib)
{
    // 使用 LittleFS API 读取校准文件
    lfs_file_t file;
    int err = lfs_file_open(&lfs, &file,
                            "/calib/touch_calib.bin",
                            LFS_O_RDONLY);
    if (err < 0) return CALIBRATION_NO_DATA;

    lfs_file_read(&lfs, &file, calib, sizeof(*calib));
    lfs_file_close(&lfs, &file);

    // 校验数据合理性
    if (calib->a < 0.5f || calib->a > 2.0f) {
        return CALIBRATION_INVALID;  // 数据损坏，重新校准
    }
    return CALIBRATION_SUCCESS;
}

// 校准算法简化示意（三点校准的最小二乘法）
void calculate_calibration_matrix(lv_point_t *screen_pts,  // 理论坐标
                                  lv_point_t *touch_pts,    // 实际触摸坐标
                                  touch_calibration_t *out)
{
    // 使用 3 个参考点拟合 6 参数仿射变换
    // X_screen = a * X_touch + b * Y_touch + c
    // Y_screen = d * X_touch + e * Y_touch + f
    // 具体计算使用最小二乘法（代码中的 calibration_algorithm.c）
}
```

## 5. FreeRTOS 任务模型

### 5.1 display_refresh_task

LVGL 在 Bicycle_Watch 中独占一个 FreeRTOS 任务：

```c
// user_display.c — display_refresh_task（LVGL 显示刷新任务）
//
// 任务职责：
//   1. lv_init() → LVGL 内部数据结构初始化
//   2. lv_port_disp_init() → 显示器驱动注册
//   3. lv_port_indev_init() → 触摸输入注册
//   4. 触摸校准（如果需要）
//   5. setup_ui() → 创建所有屏幕
//   6. 主循环: lv_task_handler() + osal_task_delay_ms(1)

void display_refresh_task(void *argument)
{
    // ① LVGL 初始化
    lv_init();
    lv_port_disp_init();
    lv_port_indev_init();

    // ② 触摸校准（来自 Flash 或交互式校准）
    watchdog_pause();  // 暂停看门狗——校准过程可能耗时 60s
    if (!check_and_calibrate_touchscreen()) {
        // 校准失败，使用默认值继续
        log_d("Touch calibration failed\n");
    }
    watchdog_resume();

    // ③ 加载 UI（创建所有屏幕对象树）
    setup_ui(&guider_ui);

    // ④ 注册看门狗——2 秒不喂狗则复位
    watchdog_register(osal_task_get_current_handle(),
                      2000, "LVGLTask");

    // ⑤ 主循环
    for (;;) {
        watchdog_feed(osal_task_get_current_handle());
        lv_task_handler();          // LVGL 心跳：处理事件、刷新显示
        osal_task_delay_ms(1);      // 释放 CPU 1ms（最快刷新率 ≈ 1000fps）
    }
}

// 优先级设计考量：
//   LVGL 任务优先级 = 中高（仅次于传感器采集）
//   延迟 = 1ms：保证触摸响应 ≤ 100ms，动画流畅
//   如果 CPU 负载紧张，可增加到 5ms，触摸延迟仍可接受
```

### 5.2 看门狗集成

```c
// Bicycle_Watch 使用软件看门狗监控每个任务的心跳
// watchdog_register() 注册任务 → 任务在循环中 watchdog_feed()
// → 看门狗监控任务定期检查各任务是否超时 → 超时则复位

// 设计要点：
// 1. 触摸校准期间要暂停看门狗——校准可能需要 60s 用户交互
//    如果看门狗超时 < 60s，校准还没完成系统就复位了
// 2. 正常运行时 LVGL 每 1ms 喂狗，远超 2s 超时阈值
//    ——只有 LVGL 任务死锁/卡死才会触发复位
```

## 6. 屏幕休眠与唤醒

```c
// Bicycle_Watch 的低功耗策略中，LVGL 显示是主要功耗来源之一
// ST7789 屏幕全亮 ≈ 40mA，熄灭 ≈ 0.1mA
// 待机时必须关闭屏幕背光和 SPI 通信

void user_display_sleep(void)
{
    drv_adapter_display_sleep();
    // 底层操作：
    //   1. 关闭背光 PWM → 屏幕不亮
    //   2. 发送 ST7789 SLEEP_IN 命令 → LCD 进入休眠
    //   3. 关闭 SPI 时钟 → 省电
    //   4. 触摸芯片进入低功耗模式
}

void user_display_wakeup(void)
{
    drv_adapter_display_wakeup();
    // 底层操作：
    //   1. 恢复 SPI 时钟
    //   2. 发送 ST7789 SLEEP_OUT 命令 → LCD 退出休眠
    //   3. 等待 120ms（LCD 上电稳定时间）
    //   4. 恢复背光 PWM
    //   5. 触摸芯片退出低功耗模式
    //   6. LVGL 需要调用 lv_obj_invalidate() 触发全屏重绘
}
```

## 7. 常见移植问题

| 问题 | 症状 | 根因 | Bicycle_Watch 的解法 |
|------|------|------|---------------------|
| SPI DMA 冲突 | 屏幕花屏、闪烁 | DMA 还没发完，LVGL 又画了新数据 | 使用双缓冲 + DMA 完成标志位（`spi2_tx_dma_done`） |
| 触摸延迟大 | 滑动不跟手 | `lv_task_handler()` 调用间隔太长 | 1ms 间隔 + FreeRTOS 优先级调高 |
| 触摸不准 | 点击位置偏移 | 未校准或校准数据损坏 | LittleFS 持久化 + 合理性校验 |
| 动画卡顿 | 过渡动画跳帧 | LVGL 绘制缓冲不够大 | 增大行缓冲到 20-30 行增加渲染吞吐 |
| 内存不足 | `lv_obj_create` 返回 NULL | LVGL 内存池太小 | `LV_MEM_SIZE` 在 `lv_conf.h` 中配置 ≥ 32KB |
| 看门狗复位 | 校准过程中系统重启 | 校准耗时 > 看门狗超时 | `watchdog_pause()` 暂停看门狗 |

## 下一步

本文介绍了 LVGL 在 STM32F411 上的移植架构。下一篇将介绍 **GuiGuider 代码生成与多页面 UI 设计**：如何用 NXP GuiGuider 拖拽生成页面、代码生成后的组织方式、`setup_scr` 模式、`ui_load_scr_animation` 页面切换，以及如何在生成代码的基础上添加自定义逻辑。
