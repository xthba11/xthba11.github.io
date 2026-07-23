---
title: GuiGuider 代码生成与 LVGL 多页面 UI 设计
date: 2025-11-15
categories:
  - 技术笔记
  - 嵌入式
  - LVGL开发
tags:
  - LVGL
  - GuiGuider
  - NXP
  - UI设计
  - 页面切换
  - STM32
  - Bicycle_Watch
description: 使用 NXP GuiGuider 拖拽生成 LVGL UI 代码的实践：项目结构、setup_scr 模式、ui_load_scr_animation 页面切换动画、代码生成后的自定义修改策略、自定义字体与图片资源管理
cover: /img/covers/articles/lvgl-guiguider-multi-page.svg
top_img: /img/covers/articles/lvgl-guiguider-multi-page.svg
---

# GuiGuider 代码生成与 LVGL 多页面 UI 设计

## 1. 为什么选择 GuiGuider

Bicycle_Watch 有 20+ 个页面（表盘×3、心率、天气、气压、菜单×3、设置、OTA、电子围栏……），如果纯手写 LVGL 控件布局代码，工作量巨大且难以预览效果。

| 方案 | 优点 | 缺点 |
|------|------|------|
| 纯手写 C 代码 | 完全可控、可复用 | 布局调整耗时、无预览 |
| SquareLine Studio | 拖拽式设计、功能强 | 商业授权昂贵、SDK 绑定 |
| **GuiGuider** | **免费、生成标准 LVGL 代码、可自定义扩展** | NXP 系工具链绑定 |
| EEZ Studio | 开源 | 社区支持少 |

> Bicycle_Watch 选择 GuiGuider：免费 + 无运行时许可限制 + 生成的代码是标准的 LVGL C API，可以自由修改、裁剪、集成到任何工程。

## 2. GuiGuider 生成的代码结构

GuiGuider 将每个页面导出为一组 `setup_scr_xxx.c` 文件，每个文件包含三个部分：

```
01_APP/LVGL_ui/
│
├── gui_guider.c/h              ← UI 框架文件
│   ├── setup_ui()              ← 入口：初始化所有页面
│   ├── ui_load_scr_animation() ← 页面切换（带动画）
│   ├── ui_animation()          ← 通用动画封装
│   └── init_scr_del_flag()     ← 页面删除标志初始化
│
├── setup_scr_WatchGiral_1.c    ← 表盘主页面（240×280）
│   ├── 控件创建代码（lv_obj_create / lv_label_create...）
│   ├── 样式代码（lv_obj_set_style_*）
│   ├── 自定义逻辑（数据绑定、arc 不可点击清除）
│   └── events_init_WatchGiral_1() ← 事件注册
│
├── setup_scr_xxx.c             ← 其他页面（每个页面一个文件）
├── events_init.c               ← 所有页面的事件处理函数实现
├── widgets_init.c              ← 自定义控件（键盘、模拟时钟定时器）
│
├── UI_Resource.h               ← 全局 UI 对象结构体声明
│   └── typedef struct { lv_obj_t *WatchGiral_1; ... } lv_ui;
│
├── images/                     ← 图片资源（PNG → C 数组）
│   ├── _heart16x16_alpha_16x16.c
│   └── _BT32_alpha_32x32.c
│
└── guider_customer_fonts/      ← 字体资源（TTF → C 数组）
    ├── lv_customer_font_interttf_82.c  ← 大数字时间显示
    ├── lv_customer_font_interttf_24.c  ← 标题字体
    ├── lv_customer_font_alimama_16.c   ← 侧边栏文字
    └── ...
```

## 3. UI 框架：setup_ui 与页面结构体

### 3.1 全局 UI 对象

```c
// UI_Resource.h — GuiGuider 自动生成的结构体
// 每个控件对应一个结构体成员，命名格式: 页面名_控件类型_序号

typedef struct {
    // 欢迎页
    lv_obj_t *weclome;
    lv_obj_t *weclome_cont_1;

    // 表盘主页 (WatchGiral_1)
    lv_obj_t *WatchGiral_1;
    lv_obj_t *WatchGiral_1_label_1;      // "ETERNLCHIP"
    lv_obj_t *WatchGiral_1_label_2;      // 温度值 "24"
    lv_obj_t *WatchGiral_1_label_3;      // 心率值 "72"
    lv_obj_t *WatchGiral_1_label_4;      // 气压值 "304"
    lv_obj_t *WatchGiral_1_label_5;      // 步数值 "9046"
    lv_obj_t *WatchGiral_1_label_6;      // 小时 "09"（82px 大字体）
    lv_obj_t *WatchGiral_1_label_7;      // 分钟 "28"（82px 大字体）
    lv_obj_t *WatchGiral_1_label_8;      // AM/PM
    lv_obj_t *WatchGiral_1_label_9;      // 日期 "03/18"
    lv_obj_t *WatchGiral_1_arc_1;        // 温度弧形进度条（蓝色）
    lv_obj_t *WatchGiral_1_arc_2;        // 心率弧形进度条（红色）
    lv_obj_t *WatchGiral_1_arc_3;        // 气压弧形进度条（橙色）
    lv_obj_t *WatchGiral_1_arc_4;        // 步数弧形进度条（绿色）
    lv_obj_t *WatchGiral_1_cont_1;       // 左侧滑出面板
    lv_obj_t *WatchGiral_1_cont_2;       // 右侧覆盖层
    lv_obj_t *WatchGiral_1_btn_1;        // 蓝牙开关按钮
    lv_obj_t *WatchGiral_1_btn_2;        // 免打扰按钮
    lv_obj_t *WatchGiral_1_btn_3;        // 振动按钮
    // ... 20+ 其他页面的控件

    // 删除标志位（每个页面一个 bool）
    bool WatchGiral_1_del;
    bool top_lap_del;
    bool Heart_del;
    // ...
} lv_ui;

// 全局实例
lv_ui guider_ui;
```

### 3.2 setup_ui 入口

```c
// gui_guider.c — 初始化所有页面

void init_scr_del_flag(lv_ui *ui)
{
    // 初始时所有页面都是"未创建"状态
    // del 标志 = true 表示此页面的控件树不存在，需要先调用 setup_scr 创建
    ui->weclome_del = true;
    ui->WatchGiral_1_del = true;
    ui->WatchGiral_3_del = true;
    ui->top_lap_del = true;
    ui->menu_1_del = true;
    ui->menu_2_del = true;
    ui->menu_3_del = true;
    ui->Heart_del = true;
    ui->Electronicfence_del = true;
    ui->NFCCard_del = true;
    ui->QrCode_del = true;
    ui->Systeamupdate_del = true;
    ui->Systeamupdate_cheak_del = true;
    ui->Set_del = true;
    ui->Message_del = true;
    ui->error_del = true;
    ui->Weather_del = true;
    ui->pmscreen_del = true;
    ui->ota_dowloand_del = true;
    ui->OTA_Update_del = true;
    ui->OTA_Update_Check_del = true;
}

void setup_ui(lv_ui *ui)
{
    init_scr_del_flag(ui);
    init_keyboard(ui);  // 初始化输入法（中文键盘）

    // 加载欢迎页作为初始页面
    setup_scr_weclome(ui);
    lv_scr_load(ui->weclome);
}

// 设计说明：
// GuiGuider 默认在 setup_ui() 中创建所有页面的控件树
// 但对于 20+ 个页面的项目，一次性全部创建会消耗大量 RAM
// Bicycle_Watch 改成了懒加载：只创建首屏，切换时再创建目标页
```

## 4. 页面切换：ui_load_scr_animation

### 4.1 核心函数

```c
// gui_guider.c — 带入场动画的页面切换
// Bicycle_Watch 中所有的页面跳转都经过这个函数

void ui_load_scr_animation(
    lv_ui *ui,                          // UI 结构体
    lv_obj_t **new_scr,                 // 目标屏幕指针的指针
    bool new_scr_del,                   // 目标屏幕是否未创建（true = 需要 setup）
    bool *old_scr_del,                  // 旧屏幕的删除标志（切换后设为 !auto_del）
    ui_setup_scr_t setup_scr,           // 目标屏幕的 setup 函数指针
    lv_scr_load_anim_t anim_type,       // 动画类型
    uint32_t time,                      // 动画时长 (ms)
    uint32_t delay,                     // 动画延迟 (ms)
    bool is_clean,                      // 切换前是否清除旧屏幕
    bool auto_del                       // 切换后是否自动删除旧屏幕
)
{
    lv_obj_t *act_scr = lv_scr_act();   // 当前活动屏幕

    // ① auto_del + is_clean：删除旧屏幕的所有子控件
    if (auto_del && is_clean) {
        lv_obj_clean(act_scr);
    }

    // ② new_scr_del = true → 调用 setup 函数创建目标页面控件树
    if (new_scr_del) {
        setup_scr(ui);
    }

    // ③ 执行页面切换动画
    lv_scr_load_anim(*new_scr, anim_type, time, delay, auto_del);

    // ④ 更新删除标志
    //    auto_del = true  → 切换后旧页面被销毁 → old_scr_del = true
    //    auto_del = false → 切换后旧页面保留   → old_scr_del = false
    *old_scr_del = auto_del;
}
```

### 4.2 Bicycle_Watch 的实际调用

项目中使用 `auto_del = true` 的策略——每次切换页面时销毁旧页面，节约 RAM：

```c
// 实际调用示例（events_init.c 中随处可见）：
// 从表盘主页 → 菜单页（上滑手势触发）
ui_load_scr_animation(
    &guider_ui,
    &guider_ui.menu_1,              // 目标页面
    guider_ui.menu_1_del,           // 菜单页是否已销毁
    &guider_ui.WatchGiral_1_del,    // 旧页面（表盘）的删除标志
    setup_scr_menu_1,               // 创建菜单页的函数
    LV_SCR_LOAD_ANIM_OVER_TOP,      // 从上方滑入
    200,                            // 200ms 动画时长
    200,                            // 200ms 延迟
    true,                           // 先清理旧页面
    true                            // 自动删除旧页面
);

// 可用动画类型：
//   LV_SCR_LOAD_ANIM_NONE          — 无动画（瞬间切换）
//   LV_SCR_LOAD_ANIM_OVER_LEFT     — 从左侧滑入（←）
//   LV_SCR_LOAD_ANIM_OVER_RIGHT    — 从右侧滑入（→）
//   LV_SCR_LOAD_ANIM_OVER_TOP      — 从上方滑入（↓）
//   LV_SCR_LOAD_ANIM_OVER_BOTTOM   — 从下方滑入（↑）
//   LV_SCR_LOAD_ANIM_MOVE_LEFT     — 整体左移
//   LV_SCR_LOAD_ANIM_MOVE_RIGHT    — 整体右移
//   LV_SCR_LOAD_ANIM_MOVE_TOP      — 整体上移
//   LV_SCR_LOAD_ANIM_MOVE_BOTTOM   — 整体下移
//   LV_SCR_LOAD_ANIM_FADE_ON       — 淡入
```

### 4.3 页面切换关系图

```
Bicycle_Watch 的页面导航结构：

                      setup_scr_weclome
                            │ (动画 1s 后自动跳转)
                            ▼
                   setup_scr_WatchGiral_1  ←── 表盘主页（默认页）
                      ╱    │    ╲
         左滑        上滑    下滑      长按
          ╱           │      ╲         ╲
    WatchGiral_3   menu_1   top_lap   ota_dowloand
    (模拟时钟)    (功能菜单) (快捷面板)  (OTA下载)
        │             │
    ┌───┴─────┐   ┌───┴─────┬──────┬──────┬──────┬──────┐
    │top_lap  │   │Heart     │Elec  │NFC   │QR    │Update│
    │快捷面板  │   │心率详情   │围栏  │NFC卡  │二维码 │系统更新│
    └─────────┘   └─────────┴──────┴──────┴──────┴──────┘
                      │
                   ┌──┴──┐
                   │Set  │ Message │ Weather │ pmscreen │
                   │设置  │ 消息    │ 天气    │ 气压详情  │
                   └─────┘
```

## 5. setup_scr 模式：以表盘主页为例

每个 `setup_scr_xxx.c` 文件的结构完全一致：

```c
void setup_scr_WatchGiral_1(lv_ui *ui)
{
    // ====== 第 1 步：通知 Sensor 任务当前进入了此页面 ======
    lvgl_WatchGiral_1_enter();
    // → 通过队列发送 UI_STATE_WatchGiral_1 事件
    // → Sensor 任务收到后开始推送此页面需要的数据

    // ====== 第 2 步：创建屏幕对象 ======
    ui->WatchGiral_1 = lv_obj_create(NULL);          // NULL = 创建独立屏幕
    lv_obj_set_size(ui->WatchGiral_1, 240, 280);
    lv_obj_set_scrollbar_mode(ui->WatchGiral_1, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(ui->WatchGiral_1,
        lv_color_hex(0x000000), LV_PART_MAIN | LV_STATE_DEFAULT);

    // ====== 第 3 步：逐个创建控件 ======
    // 3.1 创建标签
    ui->WatchGiral_1_label_1 = lv_label_create(ui->WatchGiral_1);
    lv_label_set_text(ui->WatchGiral_1_label_1, "ETERNLCHIP");
    lv_obj_set_pos(ui->WatchGiral_1_label_1, 37, 19);
    lv_obj_set_size(ui->WatchGiral_1_label_1, 170, 23);
    lv_obj_set_style_text_font(ui->WatchGiral_1_label_1,
        &lv_customer_font_interttf_24, LV_PART_MAIN | LV_STATE_DEFAULT);

    // 3.2 创建弧形进度条（温度指示）
    ui->WatchGiral_1_arc_1 = lv_arc_create(ui->WatchGiral_1);
    lv_arc_set_range(ui->WatchGiral_1_arc_1, 0, 100);
    lv_arc_set_bg_angles(ui->WatchGiral_1_arc_1, 135, 45);  // 开口在顶部中间
    lv_arc_set_value(ui->WatchGiral_1_arc_1, 100);
    lv_obj_set_pos(ui->WatchGiral_1_arc_1, 24, 66);
    lv_obj_set_size(ui->WatchGiral_1_arc_1, 36, 36);
    lv_obj_set_style_arc_color(ui->WatchGiral_1_arc_1,
        lv_color_hex(0x2195f6), LV_PART_INDICATOR | LV_STATE_DEFAULT);

    // 3.3 创建图片控件（蓝牙图标）
    ui->WatchGiral_1_img_6 = lv_img_create(ui->WatchGiral_1_cont_1);
    lv_obj_add_flag(ui->WatchGiral_1_img_6, LV_OBJ_FLAG_CLICKABLE);
    lv_img_set_src(ui->WatchGiral_1_img_6, &_BT32_alpha_32x32);  // 图片 C 数组
    lv_obj_set_pos(ui->WatchGiral_1_img_6, 42, 166);
    lv_obj_set_size(ui->WatchGiral_1_img_6, 32, 32);

    // 3.4 创建按钮
    ui->WatchGiral_1_btn_1 = lv_btn_create(ui->WatchGiral_1_cont_1);
    ui->WatchGiral_1_btn_1_label = lv_label_create(ui->WatchGiral_1_btn_1);
    lv_obj_set_pos(ui->WatchGiral_1_btn_1, 5, 158);
    lv_obj_set_size(ui->WatchGiral_1_btn_1, 110, 50);
    lv_obj_set_style_radius(ui->WatchGiral_1_btn_1, 10,
        LV_PART_MAIN | LV_STATE_DEFAULT);

    // ...（共 ~30 个控件，此处省略）

    // ====== 第 4 步：自定义逻辑（在生成的代码尾部添加） ======
    // 清除 arc 的可点击标志——arc 只做指示，不做交互
    lv_obj_clear_flag(guider_ui.WatchGiral_1_arc_1, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_clear_flag(guider_ui.WatchGiral_1_arc_2, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_clear_flag(guider_ui.WatchGiral_1_arc_3, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_clear_flag(guider_ui.WatchGiral_1_arc_4, LV_OBJ_FLAG_CLICKABLE);

    // 初始化显示数据（从全局数据结构读取）
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_2,
        "%d", g_lvgl_data.temperature);
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_3,
        "%d", g_lvgl_data.heart_rate);
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_6,
        "%02d", g_lvgl_data.hour > 12 ?
                g_lvgl_data.hour - 12 : g_lvgl_data.hour);
    lv_label_set_text_fmt(guider_ui.WatchGiral_1_label_7,
        "%02d", g_lvgl_data.minute);

    // ====== 第 5 步：强制刷新布局 ======
    lv_obj_update_layout(ui->WatchGiral_1);

    // ====== 第 6 步：注册事件回调 ======
    events_init_WatchGiral_1(ui);
}
```

## 6. 自定义字体与图片资源

### 6.1 字体生成

```c
// Bicycle_Watch 使用了 4 种自定义字体：

// ① InterTTF 82px — 表盘时间大数字
//    lv_customer_font_interttf_82
//    用于小时(09)和分钟(28)的大号显示
//    颜色：小时红 (#ff0050)、分钟绿 (#c2ff00)

// ② InterTTF 24px — 标题（"ETERNLCHIP"）
//    lv_customer_font_interttf_24

// ③ Alimama 16px — 侧边栏菜单文字
//    lv_customer_font_alimama_16

// ④ DigitalDreamFatNarrow 36px — 数字专用（等宽数字）
//    lv_customer_font_digitaldreamfatnarrow_36

// 生成方式：GuiGuider 内置字体转换器
//   TTF → 指定字号 + 指定字符集 → .c 数组
//   字体数据直接链接进固件，不依赖文件系统
```

### 6.2 图片资源

```c
// GuiGuider 将 PNG 图片转换为 LVGL 兼容的 C 数组
// 格式：alpha 通道灰度图（节省 Flash）

// _BT32_alpha_32x32    — 蓝牙图标 32×32
// _heart16x16_alpha_16x16 — 心形图标 16×16
// _foot16x16_alpha_16x16  — 足部图标
// _KLL16x16_alpha_16x16   — 卡路里图标
// _sheshidu_alpha_10x10   — 摄氏度图标 10×10
// _wather16x16_alpha_16x16 — 天气图标

// 使用：lv_img_set_src(ui->xxx_img, &_BT32_alpha_32x32);
// LVGL 会根据图片格式自动调用对应的渲染函数
```

## 7. GuiGuider 工作流与自定义策略

### 7.1 推荐的开发流程

```
① GuiGuider 可视化设计
   ├── 拖拽控件 → 调整位置/大小
   ├── 设置样式（颜色、字体、圆角）
   └── 预览效果
        │
② 导出 C 代码
   ├── setup_scr_xxx.c  ← 控件创建 + 样式
   ├── events_init.c    ← 预设事件框架
   └── UI_Resource.h    ← 结构体声明
        │
③ 集成到 Bicycle_Watch 工程
   ├── 在 setup_scr 尾部添加自定义逻辑
   ├── 在 events_init 尾部添加自定义事件处理
   └── 在 gui_guider.c 的 setup_ui() 中选择初始页面
        │
④ 迭代：修改 GuiGuider 项目 → 重新导出 → diff 合并
```

### 7.2 自定义策略：在生成代码上叠加

**关键原则：永远不要在 setup_scr 函数中间插入代码——只在尾部追加。**

```c
// ✓ 正确做法：在 setup_scr 函数末尾追加自定义逻辑
void setup_scr_WatchGiral_1(lv_ui *ui)
{
    // ... GuiGuider 生成的代码 ...

    // ＝＝＝＝ 以下为自定义追加 ＝＝＝＝
    // 数据初始化
    lv_label_set_text_fmt(ui->WatchGiral_1_label_2,
        "%d", g_lvgl_data.temperature);
    // 自定义样式覆盖
    lv_obj_set_style_text_color(ui->WatchGiral_1_label_6,
        lv_color_hex(0xFF5500), LV_PART_MAIN | LV_STATE_DEFAULT);

    lv_obj_update_layout(ui->WatchGiral_1);
    events_init_WatchGiral_1(ui);
}

// ✗ 错误做法：在生成代码中间插入——下次 GuiGuider 重新导出时会被覆盖
```

## 8. RAM 优化策略

Bicycle_Watch 的 RAM 预算紧张（STM32F411 只有 128KB SRAM），LVGL 的优化策略：

```c
// 策略 1：延迟创建页面（懒加载）
// setup_ui() 中只创建首页 → 其他页面在切换时才 setup_scr
// 20 个页面如果全部预创建，每个页面 ~2-4KB，总共浪费 40-80KB RAM

// 策略 2：切换时销毁旧页面（auto_del = true）
// ui_load_scr_animation(..., true, true)
// → 离开页面 A 时销毁 A 的控件树
// → 进入页面 B 时创建 B 的控件树
// → 同一时间 RAM 中只有 1 个页面的控件

// 策略 3：减小绘制缓冲
// lv_disp_draw_buf_init(..., 240*10)  // 10 行缓冲
// 对比 240×280 全屏缓冲：10×240×2 = 4.8KB vs 280×240×2 = 131KB
// 代价：LVGL 需要多次 flush 才能完成一帧，帧率从 ~60fps 降到 ~30fps

// 策略 4：lv_conf.h 调参
// #define LV_MEM_SIZE    (32 * 1024)   // LVGL 内存池 32KB
// #define LV_USE_GPU     0             // 无硬件加速，纯软件渲染
// #define LV_USE_LOG     0             // 关闭 LVGL 内部日志
```

## 下一步

下一篇将深入 **LVGL 事件系统与手势交互设计**：事件处理器模式（`LV_EVENT_ALL` 分发 + switch 分发）、手势识别（4 方向滑动、长按）在 Bicycle_Watch 中的完整实现、按钮状态切换、屏幕加载/卸载生命周期管理、定时器驱动的数据刷新。
