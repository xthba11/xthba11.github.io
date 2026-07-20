---
title: LVGL 事件系统与手势交互设计（基于 Bicycle_Watch 实战）
date: 2025-11-25
categories:
  - 技术笔记
  - 嵌入式
  - LVGL开发
tags:
  - LVGL
  - 事件系统
  - 手势识别
  - 触摸交互
  - 定时器
  - Bicycle_Watch
description: LVGL 事件系统深度实践：事件处理器模式（switch 分发）、四方向手势交互、长按与短按、屏幕生命周期管理（LOADED/UNLOAD）、定时器驱动的数据刷新、滑动菜单与象限判断
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# LVGL 事件系统与手势交互设计

## 1. LVGL 事件模型概述

LVGL 的事件系统是 UI 交互的核心。每个控件都可以产生事件，事件沿对象树向上冒泡。Bicycle_Watch 中使用了一种清晰的模式来管理所有交互：

```
触摸硬件 (CST816T)
    │
    ▼
lv_port_indev (触摸驱动适配)
    │
    ▼
LVGL 事件引擎 (扫描、手势识别)
    │
    ▼
lv_obj_add_event_cb() 注册的回调函数
    │
    ▼
switch (event_code) 分发到具体处理逻辑
```

### 1.1 事件注册模式

Bicycle_Watch 中每个屏幕都有一组用 `events_init_xxx()` 函数注册的事件处理器：

```c
// events_init.c — 为每个控件注册事件回调
// 模式：lv_obj_add_event_cb(对象, 处理函数, LV_EVENT_ALL, 用户数据)

void events_init_WatchGiral_1(lv_ui *ui)
{
    // 屏幕级事件：处理手势、生命周期
    lv_obj_add_event_cb(ui->WatchGiral_1,
        WatchGiral_1_event_handler, LV_EVENT_ALL, ui);

    // 按钮 1 点击事件
    lv_obj_add_event_cb(ui->WatchGiral_1_btn_1,
        WatchGiral_1_btn_1_event_handler, LV_EVENT_ALL, ui);

    // 按钮 2 点击事件
    lv_obj_add_event_cb(ui->WatchGiral_1_btn_2,
        WatchGiral_1_btn_2_event_handler, LV_EVENT_ALL, ui);

    // 按钮 3 点击事件
    lv_obj_add_event_cb(ui->WatchGiral_1_btn_3,
        WatchGiral_1_btn_3_event_handler, LV_EVENT_ALL, ui);

    // 蓝牙图标点击事件
    lv_obj_add_event_cb(ui->WatchGiral_1_img_6,
        WatchGiral_1_img_6_event_handler, LV_EVENT_ALL, ui);

    // 覆盖层（右侧面板）手势事件
    lv_obj_add_event_cb(ui->WatchGiral_1_cont_2,
        WatchGiral_1_cont_2_event_handler, LV_EVENT_ALL, ui);

    // 总共注册 8 个控件的回调
}
```

> **为什么用 `LV_EVENT_ALL` 而不是指定特定事件？**
> 因为同一个控件可能响应多种事件（如屏幕对象同时处理 GESTURE、LOADED、UNLOAD、LONG_PRESSED），用 `LV_EVENT_ALL` 注册后在一个 switch 内统一分发，代码更集中、更易维护。

## 2. 屏幕级事件处理器

### 2.1 手势驱动的页面跳转

Bicycle_Watch 的核心交互是手势——用户通过滑动在不同页面间切换：

```c
// WatchGiral_1 的屏幕级事件处理器
// 处理 4 方向手势 + 长按 + 生命周期

static void WatchGiral_1_event_handler(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);

    switch (code) {

    // ======== 生命周期事件 ========

    case LV_EVENT_SCREEN_LOADED: {
        // 屏幕加载完成 → 初始化状态
        screen_index = 0;  // 记录当前在第几个表盘（用于快捷面板返回）

        // 启动定时器：每 100ms 刷新一次传感器数据显示
        if (Watch_Giral_timer_t == NULL) {
            Watch_Giral_timer_t = lv_timer_create(
                Watch_Giral_timer_exe_cb, 100, NULL);
        }
        break;
    }

    case LV_EVENT_SCREEN_UNLOAD_START: {
        // 屏幕即将被卸载 → 清理资源
        // 删除定时器，避免定时器回调访问已销毁的控件
        if (Watch_Giral_timer_t != NULL) {
            lv_timer_del(Watch_Giral_timer_t);
            Watch_Giral_timer_t = NULL;
        }
        if (lv_ota_scan_timer != NULL) {
            lv_timer_del(lv_ota_scan_timer);
            lv_ota_scan_timer = NULL;
        }
        break;
    }

    // ======== 手势事件 ========

    case LV_EVENT_GESTURE: {
        lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_get_act());

        switch (dir) {
        case LV_DIR_BOTTOM:
            // 上滑 → 打开快捷控制面板
            lv_indev_wait_release(lv_indev_get_act());
            ui_load_scr_animation(&guider_ui,
                &guider_ui.top_lap,
                guider_ui.top_lap_del,
                &guider_ui.WatchGiral_1_del,
                setup_scr_top_lap,
                LV_SCR_LOAD_ANIM_OVER_BOTTOM,
                200, 0, true, true);
            break;

        case LV_DIR_RIGHT:
            // 右滑 → 滑出左侧快捷面板（不跳转页面）
            // 用动画移动 cont_2 的位置
            ui_animation(guider_ui.WatchGiral_1_cont_2,
                200, 0,
                lv_obj_get_x(guider_ui.WatchGiral_1_cont_2),
                120,  // 目标 x 坐标
                &lv_anim_path_overshoot,
                1, 0, 0, 0,
                (lv_anim_exec_xcb_t)lv_obj_set_x,
                NULL, NULL, NULL);
            // 显示覆盖层
            lv_obj_clear_flag(guider_ui.WatchGiral_1_cont_2,
                LV_OBJ_FLAG_HIDDEN);
            // 同时向左移动 cont_1
            ui_animation(guider_ui.WatchGiral_1_cont_1,
                200, 0,
                lv_obj_get_x(guider_ui.WatchGiral_1_cont_1),
                0,
                &lv_anim_path_overshoot,
                1, 0, 0, 0,
                (lv_anim_exec_xcb_t)lv_obj_set_x,
                NULL, NULL, NULL);
            break;

        case LV_DIR_LEFT:
            // 左滑 → 切换到模拟时钟表盘
            lv_indev_wait_release(lv_indev_get_act());
            ui_load_scr_animation(&guider_ui,
                &guider_ui.WatchGiral_3,
                guider_ui.WatchGiral_3_del,
                &guider_ui.WatchGiral_1_del,
                setup_scr_WatchGiral_3,
                LV_SCR_LOAD_ANIM_OVER_LEFT,
                200, 200, true, true);
            break;

        case LV_DIR_TOP:
            // 下滑 → 打开菜单页（根据 mode 变量选不同菜单）
            lv_indev_wait_release(lv_indev_get_act());
            switch (mode) {
            case 0:
                ui_load_scr_animation(&guider_ui,
                    &guider_ui.menu_1, guider_ui.menu_1_del,
                    &guider_ui.WatchGiral_1_del,
                    setup_scr_menu_1,
                    LV_SCR_LOAD_ANIM_OVER_TOP,
                    200, 200, true, true);
                break;
            case 1:
                ui_load_scr_animation(&guider_ui,
                    &guider_ui.menu_2, guider_ui.menu_2_del,
                    &guider_ui.WatchGiral_1_del,
                    setup_scr_menu_2,
                    LV_SCR_LOAD_ANIM_OVER_TOP,
                    200, 200, true, true);
                break;
            case 2:
                ui_load_scr_animation(&guider_ui,
                    &guider_ui.menu_3, guider_ui.menu_3_del,
                    &guider_ui.WatchGiral_1_del,
                    setup_scr_menu_3,
                    LV_SCR_LOAD_ANIM_OVER_TOP,
                    200, 200, true, true);
                break;
            }
            break;
        }
        break;
    }

    // ======== 长按事件 ========
    case LV_EVENT_LONG_PRESSED:
        lv_indev_wait_release(lv_indev_get_act());
        // 长按 → 进入 OTA 下载页面（快捷入口）
        ui_load_scr_animation(&guider_ui,
            &guider_ui.ota_dowloand,
            guider_ui.ota_dowloand_del,
            &guider_ui.WatchGiral_1_del,
            setup_scr_ota_dowloand,
            LV_SCR_LOAD_ANIM_OVER_RIGHT,
            200, 0, true, true);
        break;

    default:
        break;
    }
}
```

### 2.2 手势完整映射

| 手势 | 表盘主页 | 模拟时钟页 | 快捷面板 | 菜单页 |
|------|---------|-----------|---------|--------|
| **↑ 上滑** | 快捷面板(top_lap) | 快捷面板 | 返回表盘 | — |
| **↓ 下滑** | 菜单页(menu_1/2/3) | 菜单页 | — | 返回表盘 |
| **← 左滑** | 模拟时钟(WatchGiral_3) | 滑出右侧面板 | — | 返回表盘 |
| **→ 右滑** | 滑出左侧面板 | 返回表盘 | — | — |
| **长按** | OTA 下载页 | OTA 下载页 | 返回表盘 | 进入对应功能页 |
| **短按** | — | — | 点击功能入口 | 点击功能入口 |

### 2.3 lv_indev_wait_release 的作用

```c
// 每个手势处理中都调用了 lv_indev_wait_release()
// 作用：等待用户手指完全离开屏幕后才执行页面切换

// 为什么需要？
// 如果不等待释放，页面切换动画会和手指还在屏幕上的触摸事件冲突
// → 新页面加载后立刻收到 RELEASE 事件 → 可能导致误触

lv_indev_wait_release(lv_indev_get_act());
// 阻塞当前代码执行，直到用户手指离开触摸屏
// 然后再执行页面切换
```

## 3. 按钮状态切换

### 3.1 点击切换模式

```c
// 蓝牙按钮 — 点击切换开启/关闭状态
// 模式：全局标志位 + 颜色切换

bool WatchGiral_1_btn_1_is_click = 0;  // 当前状态

static void WatchGiral_1_btn_1_event_handler(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    switch (code) {
    case LV_EVENT_CLICKED: {
        if (WatchGiral_1_btn_1_is_click) {
            // 从"开"切换到"关"
            WatchGiral_1_btn_1_is_click = 0;
            // 图标恢复默认颜色（不重新着色）
            lv_obj_set_style_img_recolor_opa(
                guider_ui.WatchGiral_1_img_6, 0,
                LV_PART_MAIN | LV_STATE_DEFAULT);
            // 按钮背景恢复灰色
            lv_obj_set_style_bg_color(
                guider_ui.WatchGiral_1_btn_1,
                lv_color_hex(0x5a5a5a),
                LV_PART_MAIN | LV_STATE_DEFAULT);
        } else {
            // 从"关"切换到"开"
            WatchGiral_1_btn_1_is_click = 1;
            // 图标着色为高亮色（橙色）
            lv_obj_set_style_img_recolor_opa(
                guider_ui.WatchGiral_1_img_6, 255,
                LV_PART_MAIN | LV_STATE_DEFAULT);
            lv_obj_set_style_img_recolor(
                guider_ui.WatchGiral_1_img_6,
                lv_color_hex(0x313131),
                LV_PART_MAIN | LV_STATE_DEFAULT);
            // 按钮背景变为橙色
            lv_obj_set_style_bg_color(
                guider_ui.WatchGiral_1_btn_1,
                lv_color_hex(0xff6500),
                LV_PART_MAIN | LV_STATE_DEFAULT);
        }
        break;
    }
    default: break;
    }
}

// 设计要点：
// 1. 图片和按钮都需要绑定同一个事件处理逻辑（点击图片 = 点击按钮）
// 2. 使用 img_recolor 而非替换图片——内存开销小，颜色切换快
// 3. 按钮文字使用 lv_obj_set_style_text_color 同步切换
```

### 3.2 快捷面板中的蓝牙开关

```c
// top_lap 快捷面板的蓝牙开关实现略有不同——直接在 CLICKED 事件中切换

bool is_open_bt = 0;  // 蓝牙开关状态

static void top_lap_cont_1_event_handler(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    switch (code) {
    case LV_EVENT_CLICKED: {
        if (is_open_bt) {
            is_open_bt = 0;
            lv_obj_set_style_bg_color(guider_ui.top_lap_cont_1,
                lv_color_hex(0x525252), LV_PART_MAIN);
        } else {
            lv_obj_set_style_bg_color(guider_ui.top_lap_cont_1,
                lv_color_hex(0x2f92da), LV_PART_MAIN);
            is_open_bt = 1;
        }
        break;
    }
    default: break;
    }
}
```

## 4. 覆盖层（Overlay）手势处理

右侧滑出的覆盖层需要在长按拖拽时能够隐藏：

```c
// WatchGiral_1_cont_2 是一个覆盖在主界面上的半透明容器
// 用户长按并向左拖拽 → 覆盖层隐藏

static void WatchGiral_1_cont_2_event_handler(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    switch (code) {
    case LV_EVENT_PRESSED: {
        // 记录按下时的起始坐标
        lv_indev_t *indev = lv_indev_get_act();
        if (indev == NULL) return;
        lv_indev_get_point(indev, &first_point);  // first_point 是 static 变量
        break;
    }

    case LV_EVENT_LONG_PRESSED: {
        // 获取当前坐标并计算位移
        lv_point_t current_point;
        lv_indev_get_point(lv_indev_get_act(), &current_point);
        lv_coord_t dx = current_point.x - first_point.x;
        lv_coord_t dy = current_point.y - first_point.y;

        // 如果水平左滑（dx < 0 且水平位移大于垂直位移）
        if (dx < 0 && abs(dx) > abs(dy)) {
            // 隐藏覆盖层
            lv_obj_add_flag(guider_ui.WatchGiral_1_cont_2,
                LV_OBJ_FLAG_HIDDEN);
            lv_obj_set_x(guider_ui.WatchGiral_1_cont_2, 0);
            // 恢复主界面位置
            ui_animation(guider_ui.WatchGiral_1_cont_1,
                200, 0,
                lv_obj_get_x(guider_ui.WatchGiral_1_cont_1),
                -140,  // 移回原位
                &lv_anim_path_overshoot,
                1, 0, 0, 0,
                (lv_anim_exec_xcb_t)lv_obj_set_x,
                NULL, NULL, NULL);
        }
        break;
    }
    default: break;
    }
}
```

## 5. 定时器驱动的数据刷新

LVGL 定时器（`lv_timer`）是周期性刷新 UI 数据的最佳方式，Bicycle_Watch 在主表盘页面用它每 100ms 刷新一次传感器数据：

```c
lv_timer_t *Watch_Giral_timer_t = NULL;

void Watch_Giral_timer_exe_cb(lv_timer_t *timer)
{
    // 从全局数据结构读取传感器最新数据
    uint8_t hour = g_lvgl_data.hour;

    // 温度
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_2,
        "%d", g_lvgl_data.temperature);
    // 心率
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_3,
        "%d", g_lvgl_data.heart_rate);
    // 气压
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_4,
        "%d", g_lvgl_data.pressure);
    // 步数
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_5,
        "%d", g_lvgl_data.step_count);

    // AM/PM 处理
    if (g_lvgl_data.hour > 12) {
        hour = g_lvgl_data.hour - 12;
        lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_8, "PM");
    } else {
        lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_8, "AM");
        hour = g_lvgl_data.hour;
    }

    // 时间显示（大字体）
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_6,
        "%02d", hour);
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_7,
        "%02d", g_lvgl_data.minute);
    // 日期显示
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_9,
        "%02d/%02d", g_lvgl_data.month, g_lvgl_data.day);

    // OTA 状态检查——如果有 OTA 事件，弹窗提示升级
    ui_state_ota_t ota_scan_state;
    lvgl_ota_screen_read(&ota_scan_state);
    if (ota_scan_state == 1) {
        // OTA 可用 → 自动切换到系统更新页面
        if (lv_scr_act() == guider_ui.WatchGiral_1) {
            ui_load_scr_animation(&guider_ui,
                &guider_ui.Systeamupdate, guider_ui.Systeamupdate_del,
                &guider_ui.WatchGiral_1_del,
                setup_scr_Systeamupdate,
                LV_SCR_LOAD_ANIM_OVER_TOP, 200, 200, true, true);
        }
    }
}

// 定时器的创建与销毁（在 SCREEN_LOADED / SCREEN_UNLOAD_START 中管理）
// 创建：lv_timer_create(Watch_Giral_timer_exe_cb, 100, NULL);
//      → 每 100ms 触发一次回调
// 销毁：lv_timer_del(Watch_Giral_timer_t);
//      → 离开页面时必须删除，否则定时器会访问已销毁的控件导致 crash

// 为什么用 lv_timer 而不是 FreeRTOS 的 osTimer？
// lv_timer 的回调在 lv_task_handler() 的上下文中执行（LVGL 任务内）
// → 可以直接访问 LVGL 控件，无需加锁或信号量
// FreeRTOS 定时器回调在其他上下文 → 不能安全调用 LVGL API
```

## 6. 滑动菜单（menu_2 的滚动联动）

menu_2 页面实现了一个有趣的滚动联动效果——随着滚动偏移量变化，各菜单项的宽度动态调整：

```c
// menu_2 的滚动事件 —— 滚动驱动宽度动画
static void menu_2_event_handler(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    switch (code) {
    case LV_EVENT_SCROLL: {
        lv_obj_t *scroll_container = lv_event_get_target(e);
        int32_t scroll_y = lv_obj_get_scroll_y(scroll_container);

        if (scroll_y > 40) {
            uint16_t get_y = (scroll_y - 40);
            level = (get_y / 70);           // 根据滚动位置计算当前选中的菜单层级
            uint16_t over_len = (get_y % 70);
            uint16_t chage_width = (over_len * 240) / 70;  // 渐变宽度

            switch (level) {
            case 0:
                // level 0 → cont_8 宽度缩小，cont_5 宽度增大
                lv_obj_set_width(guider_ui.menu_2_cont_8, 300 - chage_width);
                lv_obj_set_width(guider_ui.menu_2_cont_5, chage_width);
                // 其余保持默认 240
                break;
            case 1:
                lv_obj_set_width(guider_ui.menu_2_cont_7, 320 - chage_width);
                lv_obj_set_width(guider_ui.menu_2_cont_4, chage_width);
                break;
            // ... level 2-7 类似逻辑 ...
            }
        }
        break;
    }

    case LV_EVENT_SCROLL_END: {
        // 滚动结束 → 吸附到最近的菜单项
        switch (level) {
        case 0: lv_obj_scroll_to_y(guider_ui.menu_2, 0, LV_ANIM_ON); break;
        case 1: lv_obj_scroll_to_y(guider_ui.menu_2, 120, LV_ANIM_ON); break;
        case 2: lv_obj_scroll_to_y(guider_ui.menu_2, 200, LV_ANIM_ON); break;
        case 3: lv_obj_scroll_to_y(guider_ui.menu_2, 280, LV_ANIM_ON); break;
        case 4: lv_obj_scroll_to_y(guider_ui.menu_2, 380, LV_ANIM_ON); break;
        case 5: lv_obj_scroll_to_y(guider_ui.menu_2, 474, LV_ANIM_ON); break;
        case 6: lv_obj_scroll_to_y(guider_ui.menu_2, 474, LV_ANIM_ON); break;
        case 7: lv_obj_scroll_to_y(guider_ui.menu_2, 560, LV_ANIM_ON); break;
        }
        break;
    }
    }
}

// 效果：滚动菜单时，当前选中的项宽度逐渐变大，上一个选中的项宽度逐渐缩小
// → 产生"焦点跟随滚动"的视觉反馈
// SCROLL_END 时吸附到最近的整屏位置（提高操作准确性）
```

## 7. 欢迎页动画回调

Bicycle_Watch 的欢迎页使用了动画完成回调来自动跳转：

```c
// 欢迎页——1 秒入场动画后自动跳转到表盘主页
static void weclome_event_handler(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    switch (code) {
    case LV_EVENT_SCREEN_LOADED: {
        // cont_1 水平滑入（左侧 → 30px）
        ui_animation(guider_ui.weclome_cont_1,
            1000, 0,                            // 1 秒动画
            lv_obj_get_x(guider_ui.weclome_cont_1),
            30,                                  // 目标 x=30
            &lv_anim_path_overshoot,             // 路径：先超过再回弹
            0, 0, 0, 0,
            (lv_anim_exec_xcb_t)lv_obj_set_x,
            NULL, NULL, NULL);

        // cont_2 宽度展开 + ready_cb 自动跳转
        ui_animation(guider_ui.weclome_cont_2,
            1000, 1000,                          // 1 秒延迟 + 1 秒动画
            lv_obj_get_width(guider_ui.weclome_cont_2),
            0,                                   // 宽度从全宽缩小到 0
            &lv_anim_path_overshoot,
            0, 0, 0, 0,
            (lv_anim_exec_xcb_t)lv_obj_set_width,
            NULL,
            weclome_load,  // ← 动画完成后回调：跳转到主表盘
            NULL);
        break;
    }
    }
}

void weclome_load()
{
    ui_load_scr_animation(&guider_ui,
        &guider_ui.WatchGiral_1,
        guider_ui.WatchGiral_1_del,
        &guider_ui.weclome_del,
        setup_scr_WatchGiral_1,
        LV_SCR_LOAD_ANIM_OVER_TOP,
        500, 0, true, true);
}
```

## 8. 屏幕切换时触摸象限判断

`get_touch_quadrant()` 是 Bicycle_Watch 中一个有趣的辅助函数——用于判断用户点击位置处于屏幕哪个象限：

```c
// 模拟时钟表盘上的触摸判断——用户点击不同象限触发不同响应
int get_touch_quadrant()
{
    lv_coord_t screen_width = lv_disp_get_hor_res(NULL);   // 240
    lv_coord_t screen_height = lv_disp_get_ver_res(NULL);  // 280

    lv_point_t center = {
        .x = screen_width / 2,   // 120
        .y = screen_height / 2   // 140
    };

    lv_indev_t *indev = lv_indev_get_act();
    lv_point_t point;
    lv_indev_get_point(indev, &point);

    // 相对坐标（注意 y 轴方向反转）
    int32_t rel_x = point.x - center.x;
    int32_t rel_y = -(point.y - center.y);

    if (rel_x > 0 && rel_y > 0)  return 1;  // 第一象限
    if (rel_x < 0 && rel_y > 0)  return 2;  // 第二象限
    if (rel_x < 0 && rel_y < 0)  return 3;  // 第三象限
    if (rel_x > 0 && rel_y < 0)  return 4;  // 第四象限
    return 0;  // 坐标轴上
}
```

## 9. 事件系统调试技巧

```c
// 技巧 1：打印事件码辅助排查
case LV_EVENT_GESTURE: {
    lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_get_act());
    printk("Gesture: %s\n",
        dir == LV_DIR_TOP    ? "UP" :
        dir == LV_DIR_BOTTOM ? "DOWN" :
        dir == LV_DIR_LEFT   ? "LEFT" :
        dir == LV_DIR_RIGHT  ? "RIGHT" : "NONE");
    break;
}

// 技巧 2：检查控件有效性（防止定时器访问已销毁的对象）
if (lv_obj_is_valid(guider_ui.WatchGiral_3_analog_clock_1)) {
    lv_analogclock_set_time(guider_ui.WatchGiral_3_analog_clock_1,
        g_lvgl_data.hour, g_lvgl_data.minute, g_lvgl_data.second);
}
// 如果控件已被 lv_obj_clean() 销毁，lv_obj_is_valid() 返回 false → 跳过

// 技巧 3：手势阈值配置（lv_conf.h）
#define LV_INDEV_DEF_GESTURE_LIMIT    50  // 最少滑动 50 像素才算手势
#define LV_INDEV_DEF_GESTURE_MIN_VELOCITY  10  // 最小速度
// 注意：Bicycle_Watch V02 版本加了双缓冲 DMA 后性能提升，
// 导致手势阈值需要从 50 降到 10 才能正常识别——性能提升反而降低了触摸灵敏度
```

## 下一步

下一篇将深入 **LVGL 数据绑定与 Sensor 实时刷新**：`lvgl_data_t` 全局数据结构设计、队列驱动的 UI 事件传递、Sensor 任务与 LVGL 任务的线程安全数据交换模式、以及按页面切换动态订阅/退订传感器数据的策略。
