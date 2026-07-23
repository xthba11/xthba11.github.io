---
title: LVGL 高级控件与动画效果实战（Bicycle_Watch 自行车码表 UI）
date: 2025-12-15
categories:
  - 技术笔记
  - 嵌入式
  - LVGL开发
tags:
  - LVGL
  - 动画
  - 模拟时钟
  - arc控件
  - 自定义字体
  - 滚动联动
  - Bicycle_Watch
description: LVGL 高级控件深度实践：模拟时钟（lv_analogclock）、弧形进度条面板、滚动联动菜单、lv_anim 动画系统（路径回弹、淡入淡出、属性过渡）、自定义字体与图片资源管理
cover: /img/covers/articles/lvgl-advanced-widgets-animation.svg
top_img: /img/covers/articles/lvgl-advanced-widgets-animation.svg
---

# LVGL 高级控件与动画效果实战

## 1. 模拟时钟控件：lv_analogclock

### 1.1 自定义控件开发

Bicycle_Watch 的 WatchGiral_3 页面使用了一个模拟时钟控件——这不是 LVGL 内置的，而是基于 `lv_obj` 继承开发的自定义控件：

```c
// analogclock/lv_analogclock.c — 模拟时钟自定义控件
//
// LVGL 自定义控件开发三步：
//   1. 定义控件类型（lv_obj 子类）
//   2. 实现构造函数 lv_analogclock_create(parent)
//   3. 实现属性设置函数 lv_analogclock_set_time(h, m, s)

// 控件数据结构
typedef struct {
    lv_obj_t obj;           // 父类对象
    int32_t hour;           // 小时
    int32_t min;            // 分钟
    int32_t sec;            // 秒
    lv_style_t *hand_style; // 指针样式
} lv_analogclock_t;

// 创建模拟时钟
lv_obj_t *lv_analogclock_create(lv_obj_t *parent)
{
    lv_obj_t *obj = lv_obj_class_create_obj(
        &lv_analogclock_class, parent);
    lv_obj_class_init_obj(obj);

    lv_analogclock_t *clock = (lv_analogclock_t *)obj;
    clock->hour = 0;
    clock->min  = 0;
    clock->sec  = 0;

    // 设置控件大小（Bicycle_Watch 的时钟占据屏幕中央 ~200×200）
    lv_obj_set_size(obj, 200, 200);

    return obj;
}

// 设置时间 — 触发重绘
void lv_analogclock_set_time(lv_obj_t *obj,
                              int32_t hour, int32_t min, int32_t sec)
{
    lv_analogclock_t *clock = (lv_analogclock_t *)obj;
    clock->hour = hour;
    clock->min  = min;
    clock->sec  = sec;
    lv_obj_invalidate(obj);  // 标记为脏 → 下一帧重绘
}

// draw_ctx — LVGL 渲染引擎调用此函数绘制时钟
static void analogclock_draw_ctx(lv_event_t *e)
{
    lv_obj_t *obj = lv_event_get_target(e);
    lv_analogclock_t *clock = (lv_analogclock_t *)obj;
    lv_draw_ctx_t *draw_ctx = lv_event_get_draw_ctx(e);

    // 获取控件中心坐标
    lv_coord_t cx = obj->coords.x1 + lv_obj_get_width(obj) / 2;
    lv_coord_t cy = obj->coords.y1 + lv_obj_get_height(obj) / 2;
    lv_coord_t r  = LV_MIN(lv_obj_get_width(obj),
                            lv_obj_get_height(obj)) / 2 - 5;

    // 绘制表盘（圆形 + 刻度）
    lv_draw_arc(draw_ctx, ..., cx, cy, r, 0, 3600);  // 外圈

    // 绘制时针（短粗）
    float hour_angle = (clock->hour % 12) * 300 +
                       clock->min * 5;  // 每小时 30°，每分钟偏 0.5°
    lv_draw_line(draw_ctx, ..., cx, cy,
        cx + sin(hour_angle) * r * 0.5,
        cy - cos(hour_angle) * r * 0.5);

    // 绘制分针（中长）
    float min_angle = clock->min * 60 + clock->sec;
    lv_draw_line(draw_ctx, ..., cx, cy,
        cx + sin(min_angle) * r * 0.7,
        cy - cos(min_angle) * r * 0.7);

    // 绘制秒针（细长，红色）
    float sec_angle = clock->sec * 60;
    lv_draw_line(draw_ctx, ..., cx, cy,
        cx + sin(sec_angle) * r * 0.85,
        cy - cos(sec_angle) * r * 0.85);
}
```

### 1.2 定时驱动

```c
// widgets_init.c — 模拟时钟的定时器驱动
lv_timer_t *WatchGiral_3_analog_clock_1_timer_hd = NULL;
bool WatchGiral_3_analog_clock_1_timer_enabled = false;

void WatchGiral_3_analog_clock_1_timer(lv_timer_t *timer)
{
    // 安全性检查：确保控件没有被销毁
    if (lv_obj_is_valid(guider_ui.WatchGiral_3_analog_clock_1)) {
        // 从全局数据结构读取当前时间
        lv_analogclock_set_time(
            guider_ui.WatchGiral_3_analog_clock_1,
            g_lvgl_data.hour,
            g_lvgl_data.minute,
            g_lvgl_data.second);
    }
}

// 在 SCREEN_LOADED 中创建定时器
// WatchGiral_3_analog_clock_1_timer_enabled = true;
// WatchGiral_3_analog_clock_1_timer_hd = lv_timer_create(
//     WatchGiral_3_analog_clock_1_timer, 1000, NULL);  // 1s 刷新

// 在 SCREEN_UNLOAD_START 中销毁
// lv_timer_del(WatchGiral_3_analog_clock_1_timer_hd);
// WatchGiral_3_analog_clock_1_timer_enabled = false;

// 时钟只需要 1 秒刷新一次——秒针精度足够
// 对比数字时间的 100ms 刷新——数字变化快，需要更高刷新率
```

## 2. 弧形进度条面板

Bicycle_Watch 主表盘左侧的 4 个弧形进度条是视觉上最亮眼的设计元素：

```c
// setup_scr_WatchGiral_1.c — 4 个弧形进度条

// arc_1: 温度（蓝色 #2195f6）
ui->WatchGiral_1_arc_1 = lv_arc_create(ui->WatchGiral_1);
lv_arc_set_range(ui->WatchGiral_1_arc_1, 0, 100);
lv_arc_set_bg_angles(ui->WatchGiral_1_arc_1, 135, 45);
    // 开口角度：起始 135° → 结束 45°
    // 即从左下开始，逆时针旋转 270° 到右下
    // 视觉效果：一个开口在顶部的环形进度条
lv_arc_set_rotation(ui->WatchGiral_1_arc_1, 240);
    // 旋转 240° 以便开口正对上方
lv_obj_set_pos(ui->WatchGiral_1_arc_1, 24, 66);
lv_obj_set_size(ui->WatchGiral_1_arc_1, 36, 36);
    // 4 个 arc 垂直排列：(24,66), (24,119), (24,177), (24,233)

// arc_2: 心率（红色 #ff003b）
// arc_3: 气压（橙色 #ff7300）
// arc_4: 步数（绿色 #44ff00）

// 清除可点击标志（arc 只做指示器，不响应点击）
lv_obj_clear_flag(guider_ui.WatchGiral_1_arc_1, LV_OBJ_FLAG_CLICKABLE);
lv_obj_clear_flag(guider_ui.WatchGiral_1_arc_2, LV_OBJ_FLAG_CLICKABLE);
lv_obj_clear_flag(guider_ui.WatchGiral_1_arc_3, LV_OBJ_FLAG_CLICKABLE);
lv_obj_clear_flag(guider_ui.WatchGiral_1_arc_4, LV_OBJ_FLAG_CLICKABLE);

// 更新弧形进度条的值（在 lv_timer 回调中）
void update_arcs(void)
{
    // 温度范围 -10~50°C → 映射到 0-100
    int temp_pct = (g_lvgl_data.temperature + 10) * 100 / 60;
    lv_arc_set_value(guider_ui.WatchGiral_1_arc_1,
        LV_CLAMP(0, temp_pct, 100));

    // 心率范围 40~200 → 映射到 0-100
    int hr_pct = (g_lvgl_data.heart_rate - 40) * 100 / 160;
    lv_arc_set_value(guider_ui.WatchGiral_1_arc_2,
        LV_CLAMP(0, hr_pct, 100));

    // 气压范围 300~1100hPa → 映射到 0-100
    int press_pct = (g_lvgl_data.pressure - 300) * 100 / 800;
    lv_arc_set_value(guider_ui.WatchGiral_1_arc_3,
        LV_CLAMP(0, press_pct, 100));

    // 步数目标 10000 → 映射到 0-100
    int steps_pct = g_lvgl_data.step_count * 100 / 10000;
    lv_arc_set_value(guider_ui.WatchGiral_1_arc_4,
        LV_CLAMP(0, steps_pct, 100));
}
```

## 3. lv_anim 动画系统

Bicycle_Watch 大量使用 `lv_anim` 实现 UI 动画，项目封装了一个统一接口：

### 3.1 通用动画函数

```c
// gui_guider.c — Bicycle_Watch 的通用动画封装

void ui_animation(
    void *var,                     // 动画目标对象的属性指针
    int32_t duration,              // 动画时长 (ms)
    int32_t delay,                 // 延迟开始 (ms)
    int32_t start_value,           // 起始值
    int32_t end_value,             // 结束值
    lv_anim_path_cb_t path_cb,     // 缓动路径
    uint16_t repeat_cnt,           // 重复次数 (0=不重复)
    uint32_t repeat_delay,         // 重复间隔 (ms)
    uint32_t playback_time,        // 回放时长 (ms)
    uint32_t playback_delay,       // 回放延迟 (ms)
    lv_anim_exec_xcb_t exec_cb,    // 执行回调（每帧更新属性值）
    lv_anim_start_cb_t start_cb,   // 动画开始回调
    lv_anim_ready_cb_t ready_cb,   // 动画完成回调 ★
    lv_anim_deleted_cb_t deleted_cb)
{
    lv_anim_t anim;
    lv_anim_init(&anim);
    lv_anim_set_var(&anim, var);
    lv_anim_set_exec_cb(&anim, exec_cb);
    lv_anim_set_values(&anim, start_value, end_value);
    lv_anim_set_time(&anim, duration);
    lv_anim_set_delay(&anim, delay);
    lv_anim_set_path_cb(&anim, path_cb);
    lv_anim_set_repeat_count(&anim, repeat_cnt);
    lv_anim_set_repeat_delay(&anim, repeat_delay);
    lv_anim_set_playback_time(&anim, playback_time);
    lv_anim_set_playback_delay(&anim, playback_delay);

    if (start_cb)   lv_anim_set_start_cb(&anim, start_cb);
    if (ready_cb)   lv_anim_set_ready_cb(&anim, ready_cb);
    // ready_cb ★: 动画完成后的回调，常用于连锁动画（A 结束 → 触发 B）

    if (deleted_cb) lv_anim_set_deleted_cb(&anim, deleted_cb);
    lv_anim_start(&anim);
}
```

### 3.2 实际动画案例

```c
// ====== 案例 1：侧边栏滑出动画 ======
// 用户右滑 → 左侧面板从 x=-140 滑出到 x=0
// 使用 lv_anim_path_overshoot（回弹效果）

// cont_2 从隐藏状态滑出到 x=120
ui_animation(
    guider_ui.WatchGiral_1_cont_2,      // 目标对象
    200,                                 // 200ms
    0,                                   // 无延迟
    lv_obj_get_x(guider_ui.WatchGiral_1_cont_2),  // 起始值（当前 x）
    120,                                 // 目标值 x=120
    &lv_anim_path_overshoot,            // 回弹路径 ★
    1,                                   // 播放 1 次（不做往返）
    0, 0, 0,
    (lv_anim_exec_xcb_t)lv_obj_set_x,   // 每帧调用 lv_obj_set_x
    NULL,                                // start_cb: 不需要
    NULL,                                // ready_cb: 不需要
    NULL
);
// 回弹效果：值先到达 120，再微微超越到 ~130，最后稳定在 120
// → 视觉上产生"弹性滑动"的感觉

// ====== 案例 2：欢迎页动画链 ======
// cont_1 水平滑入（x → 30），1 秒后 cont_2 宽度展开
ui_animation(guider_ui.weclome_cont_1,
    1000, 0,
    lv_obj_get_x(guider_ui.weclome_cont_1), 30,
    &lv_anim_path_overshoot,
    0, 0, 0, 0,
    (lv_anim_exec_xcb_t)lv_obj_set_x,
    NULL, NULL, NULL);

// cont_2 延迟 1000ms 后执行，完成后回调 weclome_load()
ui_animation(guider_ui.weclome_cont_2,
    1000, 1000,                         // ★ 延迟 1s = 等 cont_1 动画结束
    lv_obj_get_width(guider_ui.weclome_cont_2), 0,
    &lv_anim_path_overshoot,
    0, 0, 0, 0,
    (lv_anim_exec_xcb_t)lv_obj_set_width,
    NULL,
    weclome_load,                       // ★ ready_cb: 动画完成后跳转
    NULL);

// ====== 案例 3：天气页面旋转动画 ======
// 天气图标持续旋转 + 上下浮动

lv_anim_t weather_anim;
uint8_t diff_y = 100;
static uint16_t scroll_angle = 0;

void Weather_anim_exe_cb()
{
    // 旋转角度：每次 +36°，累计 3600°（10 圈）后归零
    scroll_angle += 36;
    if (scroll_angle >= 3600) {
        scroll_angle = 0;
    }
    lv_obj_set_style_transform_angle(
        guider_ui.Weather_cont_2, scroll_angle,
        LV_PART_MAIN | LV_STATE_DEFAULT);

    // 上下浮动：Y 坐标从 100 慢慢降到 0，然后重置
    diff_y -= 1;
    if (diff_y <= 0) {
        diff_y = 100;
    }
    lv_obj_set_y(guider_ui.Weather_cont_2, diff_y);

    // 显示加载进度
    lv_label_set_text_fmt(guider_ui.Weather_label_3,
        "%d%%", (100 - diff_y));
}
```

### 3.3 缓动路径选择

Bicycle_Watch 主要使用了两种路径：

| 路径 | 效果 | 适用场景 |
|------|------|---------|
| `lv_anim_path_overshoot` | 先超过目标值再回弹 | 页面切换、面板滑出 |
| `lv_anim_path_ease_out` | 从快到慢减速停止 | 进度条、淡入淡出 |
| `lv_anim_path_linear` | 匀速 | 旋转动画 |

## 4. 滑块控件与背光调节

Bicycle_Watch 的快捷面板中使用滑块调节屏幕亮度：

```c
// top_lap 中的亮度滑块
int32_t i32_source_pwm = 0;
uint16_t u16_output_pwm = 0;

static void top_lap_slider_1_event_handler(lv_event_t *e)
{
    static uint16_t u16_old_output_pwm = 0;
    lv_event_code_t code = lv_event_get_code(e);

    switch (code) {
    case LV_EVENT_VALUE_CHANGED: {
        // 读取滑块值 (0-100)
        i32_source_pwm = lv_slider_get_value(
            guider_ui.top_lap_slider_1);
        // 映射到 PWM 占空比 (0-1000)
        u16_output_pwm = (uint16_t)(i32_source_pwm) * 10;

        // 只在值变化时才更新（减少不必要的硬件操作）
        if (u16_old_output_pwm != u16_output_pwm) {
            u16_old_output_pwm = u16_output_pwm;

            // 通过队列发送给背光控制任务
            osal_queue_send(
                st_userqueuecfg[DisplayBlackLightQueue].queue_handle,
                &u16_output_pwm, 10);
        }
        break;
    }
    }
}

// 设计要点：
// 1. 使用队列发送而不是直接调 PWM 函数 → 解耦 UI 和硬件
// 2. 去抖动：只在值变化时发送 → 减少队列压力
// 3. LV_EVENT_VALUE_CHANGED 在每次拖动时触发 → 实时反馈
```

## 5. 自定义字体渲染效果

### 5.1 表盘时间的大字体

```c
// 小时和分钟使用 82px InterTTF 字体
// 这是 Bicycle_Watch 最醒目的视觉元素

lv_obj_set_style_text_font(ui->WatchGiral_1_label_6,
    &lv_customer_font_interttf_82, LV_PART_MAIN | LV_STATE_DEFAULT);
lv_obj_set_style_text_color(ui->WatchGiral_1_label_6,
    lv_color_hex(0xff0050), ...);  // 小时 = 红色

lv_obj_set_style_text_font(ui->WatchGiral_1_label_7,
    &lv_customer_font_interttf_82, LV_PART_MAIN | LV_STATE_DEFAULT);
lv_obj_set_style_text_color(ui->WatchGiral_1_label_7,
    lv_color_hex(0xc2ff00), ...);  // 分钟 = 绿色

// 字间距设置为 5 像素 → "0 9 : 2 8" 有呼吸感
lv_obj_set_style_text_letter_space(ui->WatchGiral_1_label_6,
    5, LV_PART_MAIN | LV_STATE_DEFAULT);

// 82px 字体在 240×280 屏幕上：
// 小时标签: x=94, y=66, w=116, h=79  (屏幕上半部分)
// 分钟标签: x=94, y=149, w=116, h=79 (屏幕下半部分)
// → 两个数字填满屏幕高度，视觉冲击力强
```

### 5.2 多字体混排

```c
// 同一个页面使用 4 种不同字号的字体，层次分明：

// 82px InterTTF:   "09"  "28"    (时间主数字)
// 24px InterTTF:   "ETERNLCHIP"  (品牌标题)
// 24px Montserrat: "PM"  "03/18" (上午下午、日期)
// 10px InterTTF:   "24" "72" "304" "9046" (传感器读数)
// 16px Alimama:    "蓝牙" "免打扰" ... (侧边栏菜单项)
```

## 6. 动画性能优化

### 6.1 动画帧率控制

```c
// LVGL 动画的帧率由 lv_task_handler() 的调用频率决定
// Bicycle_Watch 以 1ms 间隔调用 → 理论最大 1000fps
// 实际受限于：
//   1. SPI 刷新速度（ST7789 @ 40MHz SPI ≈ 30fps 全屏）
//   2. MCU 渲染速度（Cortex-M4 @ 100MHz 软件渲染）

// 优化一：避免动画期间的大量样式变更
//   ✗ 每帧修改 border_width、shadow_width、pad_all
//   ✓ 只用 lv_obj_set_x/set_y/set_width/set_height 做位置/大小动画

// 优化二：限制同时运行的动画数量
//   Bicycle_Watch 同时最多 2-3 个动画（滑入 + 滑出 + 天气旋转）

// 优化三：动画完成后清理
//   使用 ready_cb 确保动画对象在结束后被正确处理
//   未清理的动画会持续占用 CPU 时间
```

### 6.2 透明度和绘制优化

```c
// 覆盖层使用半透明背景（bg_opa = 140）
// → LVGL 需要对下层内容做 alpha 混合
// → 比完全不透明（bg_opa = 255）多 2-3 倍的渲染时间

// Bicycle_Watch 的策略：
//   1. 覆盖层只在需要时显示（默认 HIDDEN）
//   2. 覆盖层出现时，下层没有动画（减少混合开销）
//   3. auto_del = true → 不用的页面直接销毁，不保留在内存中

lv_obj_set_style_bg_opa(ui->WatchGiral_1_cont_2,
    140,   // 半透明，能看到下层内容
    LV_PART_MAIN | LV_STATE_DEFAULT);
```

## 7. Bicycle_Watch LVGL UI 设计总结

### 7.1 屏幕规格

| 参数 | 值 |
|------|-----|
| 分辨率 | 240×280 像素 |
| 色深 | RGB565 (16bit) |
| 驱动 IC | ST7789 |
| 接口 | SPI @ 40MHz |
| 触摸 IC | CST816T (I2C) |
| 帧率 | ~30fps（双缓冲 DMA） |
| 控件总数 | 20+ 页面，每页 10-30 个控件 |

### 7.2 技术栈总览

| 技术点 | Bicycle_Watch 的实践 |
|--------|---------------------|
| UI 设计工具 | NXP GuiGuider（拖拽 + 生成 C 代码） |
| 页面切换 | `ui_load_scr_animation`（8 种动画方向） |
| 页面管理 | 懒加载 + auto_del（省 RAM） |
| 交互方式 | 4 方向手势 + 长按 + 短按 + 滚动联动 |
| 数据刷新 | `lv_timer` @ 100ms（数字）/ 1s（时钟） |
| 动画系统 | `lv_anim` + `lv_anim_path_overshoot` |
| 数据交互 | 全局结构体（Sensor→LVGL）+ 队列（LVGL→Sensor） |
| 资源管理 | 自定义字体（TTF→C）+ 图片（PNG→C 数组） |
| 低功耗 | 屏幕休眠（背光+SPI+LCD SLEEP_IN） |
| 看门狗 | `watchdog_pause()` 在校准期间暂停 |

### 7.3 踩坑记录

| 问题 | 现象 | 根因 | 解法 |
|------|------|------|------|
| 手势不灵敏 | 滑动没反应 | 双缓冲 DMA 后性能提升，需要更小的手势阈值 | `LV_INDEV_DEF_GESTURE_LIMIT` 从 50 降到 10 |
| 定时器 crash | 页面切换后 crash | 定时器还在访问已 `lv_obj_clean` 的控件 | 在 `SCREEN_UNLOAD_START` 中 `lv_timer_del` |
| 字体溢出 | 82px 数字超出屏幕 | 字体太大，label 尺寸不够 | 设置足够大的 label size (116×79) |
| arc 误触 | 点击 arc 跳转页面 | arc 默认 `CLICKABLE`，会触发点击事件 | `lv_obj_clear_flag(arc, LV_OBJ_FLAG_CLICKABLE)` |
| 覆盖层穿透 | 点击覆盖层触发了下层控件 | 覆盖层 `bg_opa` 半透明但没阻止事件传递 | 覆盖层设置 `LV_OBJ_FLAG_CLICKABLE` 拦截事件 |

---

> **系列文章完结**。五篇文章覆盖了 LVGL 在 Bicycle_Watch 自行车码表项目中的完整实践——从底层移植到上层 UI 设计，从事件系统到数据绑定，从基础控件到高级动画。所有代码均基于 `C:\Users\XTHBA\Desktop\找工作\项目\Bicycle_Watch` 工程中的真实源码。
