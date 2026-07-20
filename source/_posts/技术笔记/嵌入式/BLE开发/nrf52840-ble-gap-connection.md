---
title: nRF52840 BLE 广播、连接与安全管理（GAP 层深度解析）
date: 2025-07-30
categories:
  - 技术笔记
  - 嵌入式
  - BLE开发
tags:
  - nRF52840
  - BLE
  - GAP
  - 配对绑定
  - LES
  - 安全管理
  - Nordic
description: nRF52840 BLE GAP 层深度解析：广播类型与参数调优、连接建立与参数协商、多角色并发（同时做 Central 和 Peripheral）、配对绑定与 LES 安全配对
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# nRF52840 BLE 广播、连接与安全管理

## 1. GAP 层在 BLE 协议栈中的位置

GAP（Generic Access Profile，通用访问规范）是 BLE 协议栈最顶层的角色定义规范，负责设备发现、广播、连接和安全管理。GATT（Generic Attribute Profile）工作在 GAP 建立的连接之上，负责数据传输。

```
┌─────────────────────────────────────────────────┐
│                  Application                     │
├─────────────────────────────────────────────────┤
│       GAP（广播/扫描/连接/配对）  GATT（服务/特征/数据） │
├───────────┬─────────────────────────────────────┤
│   Host    │  L2CAP / ATT / SM (安全管理)         │
├───────────┼─────────────────────────────────────┤
│Controller │  Link Layer / PHY (物理层)            │
└───────────┴─────────────────────────────────────┘
```

### 1.1 GAP 四种角色

| 角色 | 描述 | Bicycle_Watch 应用场景 |
|------|------|----------------------|
| **Broadcaster** | 只广播，不连接 | Beacon 广播设备存在 |
| **Observer** | 只扫描，不连接 | 扫描附近队友的码表 |
| **Peripheral** | 广播 + 被连接（从机） | 等待手机 App 连接 |
| **Central** | 扫描 + 主动连接（主机） | 连接心率带、踏频器等外设 |

nRF52840 支持 **多角色并发**——同一设备可以同时做 Peripheral（手机连接）和 Central（连接心率带），这是 Nordic SoftDevice 的核心竞争力之一。

## 2. 广播深度解析

### 2.1 广播包结构

每个 BLE 广播包由多个 AD Structure（Advertising Data Structure）串联组成：

```
  Byte 0       Byte 1       Byte 2 ... Byte n
┌──────────┬─────────────┬──────────────────┐
│ Length(n)│ AD Type(1B) │ AD Data (n-1 B)  │
└──────────┴─────────────┴──────────────────┘

示例：包含设备名称 "RidePulse" 的广播包
┌──────┬──────────┬────┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ 0x02 │ 0x01(Flag)│0x06│0x0A│0x09│'R'│'i'│'d'│'e'│'P'│'u'│'l'│'s'│'e'│
└──────┴──────────┴────┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
  长度2   类型Flag    值6  长度10 类型名称     数据: "RidePulse"
```

### 2.2 广播类型详解

nRF52840 BLE 5.4 支持多种广播类型。传统广播（Legacy Advertising）使用 37/38/39 三个固定广播信道，扩展广播（Extended Advertising）可使用 40 个信道中的任意组合。

```c
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gap.h>

// ==================== 传统广播（Legacy Advertising）===================

// 类型 1：可连接的非定向广播
// 最常用——手机可扫描到并发起连接
// Bicycle_Watch 的默认广播模式
static struct bt_le_adv_param adv_connectable =
    BT_LE_ADV_PARAM_INIT(
        BT_LE_ADV_OPT_CONNECTABLE,  // 可连接
        160, 200, NULL              // 间隔 100-125ms
    );

// 类型 2：不可连接的非定向广播
// 纯 Beacon——只广播数据，不接收连接
// 用于设备发现和简单的状态广播（如"骑行中"标记）
static struct bt_le_adv_param adv_non_conn =
    BT_LE_ADV_PARAM_INIT(
        0,              // option = 0：不可连接、不可扫描
        320, 400, NULL  // 更长的广播间隔，省电
    );

// 类型 3：可扫描的非定向广播
// 手机不能连接，但可以发起 Scan Request 获取扫描响应数据
// 适合广播大量静态信息（设备信息、固件版本等）
static struct bt_le_adv_param adv_scannable =
    BT_LE_ADV_PARAM_INIT(
        BT_LE_ADV_OPT_SCANNABLE,  // 允许扫描响应
        320, 400, NULL
    );

// ==================== 扩展广播（Extended Advertising, BLE 5.0+）===========

// 扩展广播的优势：
// 1. 广播数据量从 31 字节扩展到 1650 字节（不需要扫描响应）
// 2. 可使用 RF 数据信道（0-36 共 37 个信道），大幅降低 3 信道拥塞
// 3. 支持周期性广播（Periodic Advertising）：主设备按固定间隔发送同步数据
//    适用于一主多从的数据分发场景，如骑行领队广播位置到队员

#if CONFIG_BT_EXT_ADV
static struct bt_le_ext_adv *ext_adv;

// 扩展广播参数
static int start_extended_adv(void)
{
    int err;

    // 创建扩展广播实例
    err = bt_le_ext_adv_create(
        BT_LE_EXT_ADV_CONN,     // 可连接的扩展广播
        NULL,                    // 使用默认选项
        &ext_adv
    );
    if (err) return err;

    // 设置广播参数：使用 1M PHY + Coded PHY（Long Range）
    struct bt_le_ext_adv_start_param start_param = {
        .timeout = 0,   // 无限广播
        .advertiser.max_interval = 160,  // 100ms
        .advertiser.min_interval = 160,
    };
    // 设置广告集：1M PHY
    bt_le_ext_adv_set_data(ext_adv, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));

    err = bt_le_ext_adv_start(ext_adv, &start_param);
    if (err) return err;

    printk("Extended advertising started\n");
    return 0;
}
#endif
```

### 2.3 广播数据与扫描响应策略

在 Bicycle_Watch 项目中，我们对广播包内容做了精心设计：

```c
// 广播包（31 字节）—— 手机扫描列表就能看到的关键信息
// 策略：放最关键的识别信息和少量状态数据，减少扫描响应交互
static const struct bt_data ad_bicycle[] = {
    // FLAGS（3 字节）：通用发现 + 纯 BLE
    BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),

    // TX Power @ 0dBm（3 字节）—— 手机测距用
    BT_DATA_BYTES(BT_DATA_TX_POWER, 0x00),

    // 16-bit Service UUID 列表 —— 告诉手机支持哪些 GATT 服务
    // 手机可以根据这个过滤设备，只显示支持特定服务的设备
    BT_DATA_BYTES(BT_DATA_UUID16_ALL,
                  0x16, 0x18,  // Cycling Speed and Cadence (0x1816)
                  0x0d, 0x18,  // Heart Rate (0x180D)
                  0x0a, 0x18), // Device Information (0x180A)

    // Manufacture Specific Data —— 自定义厂商数据
    // 用于在广播包中直接嵌入少量实时状态，手机无需连接即可读取
    // Bytes: [电池% | 骑行状态 | 版本]
    BT_DATA(BT_DATA_MANUFACTURER_DATA,
            ((uint8_t[]){0xFF, 0xFF,    // Company ID: 0xFFFF (测试用)
                         85,            // 电池 85%
                         0x01,          // 状态: 1=骑行中
                         0x01}),        // 固件版本
            5),
};

// 扫描响应（31 字节）—— 手机主动扫描时才请求的额外信息
// 策略：放设备名称和完整服务列表（31 字节放不下所有服务 UUID）
static const struct bt_data sd_bicycle[] = {
    // 完整设备名称（最多放 ~28 字节给名称）
    BT_DATA(BT_DATA_NAME_COMPLETE,
            'R','i','d','e','P','u','l','s','e','_',
            '0','0','0','1'),
    // TX Power 已在上面的广播包中声明，此处不重复
};
```

## 3. 连接管理

### 3.1 连接建立流程

```
Peripheral (nRF52840)                    Central (手机App)
      │                                        │
      │  ◄══════ ADV_IND (广播包) ═══════════  │  ① 广播
      │                                        │
      │  ════════ CONNECT_IND ──────────────►  │  ② 连接请求
      │                                        │
      │  ◄══════ LL_DATA (从机确认) ════════   │  ③ ACL连接建立
      │                                        │
      │  ◄══════ Pairing Request ═══════════   │  ④ 可选: 配对
      │  ════════ Pairing Response ────────►   │
      │                                        │
      │  ◄══════ GATT Discovery ════════════   │  ⑤ 服务发现
      │                                        │
      │  ◄══════ GATT Read/Write/Notify ════   │  ⑥ 数据交互
```

### 3.2 连接参数协商

连接参数由 Central 决定，但 Peripheral 可以发起 **Connection Parameter Update Request**：

```c
// 连接参数决定了功耗与延迟的平衡
// 三个核心参数：
//   Interval:  连接间隔（两个连接事件之间的间隔），单位 1.25ms
//   Latency:   从机延迟（允许跳过多少个连接事件不响应）
//   Timeout:   连接监督超时（多少 ms 无响应则判断开），单位 10ms

// Bicycle_Watch 不同场景的连接参数策略
static void conn_param_update_by_scene(struct bt_conn *conn,
                                       enum bike_scene scene)
{
    struct bt_conn_le_param param;

    switch (scene) {
    case SCENE_RIDING:    // 骑行中：需要实时数据传输
        // 短间隔 + 低延迟 → 心率/速度数据实时推送到手机
        param.interval_min = 20;   // 20 × 1.25ms = 25ms
        param.interval_max = 40;   // 40 × 1.25ms = 50ms
        param.latency      = 0;    // 不跳过任何连接事件
        param.timeout      = 400;  // 4 秒超时
        break;

    case SCENE_PAUSED:    // 暂停休息：维持连接但可降低速率
        // 中等间隔 + 一定延迟 → 省电同时保持连接
        param.interval_min = 80;   // 100ms
        param.interval_max = 120;  // 150ms
        param.latency      = 4;    // 最多跳过 4 个连接事件
        param.timeout      = 600;  // 6 秒超时
        break;

    case SCENE_IDLE:      // 待机（码表在桌面）：只需维持连接状态
        param.interval_min = 400;  // 500ms
        param.interval_max = 800;  // 1000ms
        param.latency      = 8;
        param.timeout      = 1000; // 10 秒超时
        break;
    }

    int err = bt_conn_le_param_update(conn, &param);
    if (err) {
        printk("Conn param update failed (err %d)\n", err);
    }
}
```

### 3.3 多角色并发：同时连接手机和心率带

这是 Bicycle_Watch 中最核心的 BLE 能力——nRF52840 同时担任两个角色：

```c
// 多角色并发架构：
//  Peripheral 角色 ── 等待手机 App 连接（码表 → 手机）
//  Central   角色 ── 扫描并连接心率带/踏频器（外设 → 码表）
//
//  nRF52840 Flash/RAM 足够同时跑 2-3 条连接
//  SoftDevice 的调度器在底层交替处理两个角色的射频事件

#define MAX_PAIRED_DEVICES  4   // 最多保存 4 个外设配对信息
#define MAX_CONCURRENT_CONN 3   // 同时维持 3 条连接

// Central 扫描参数：低功耗扫描，不持续扫描
static struct bt_le_scan_param scan_param = {
    .type       = BT_LE_SCAN_TYPE_PASSIVE,  // 被动扫描（只收不发，省电）
    .options    = BT_LE_SCAN_OPT_FILTER_DUPLICATE, // 过滤重复包
    .interval   = 0x0100,  // 扫描间隔 160 × 0.625ms = 100ms
    .window     = 0x0050,  // 扫描窗口 80 × 0.625ms = 50ms
                           // Duty Cycle = 50/100 = 50%
};

// 扫描过滤器：只关注心率服务和骑行速度服务设备
static bool scan_filter(struct bt_data *data, void *user_data)
{
    // 按 16-bit UUID 过滤，降低 CPU 处理开销
    if (data->type == BT_DATA_UUID16_ALL ||
        data->type == BT_DATA_UUID16_SOME) {
        for (int i = 0; i < data->data_len; i += 2) {
            uint16_t uuid = sys_get_le16(&data->data[i]);
            if (uuid == BT_UUID_HRS_VAL ||       // 心率服务
                uuid == BT_UUID_CSC_VAL) {       // 骑行速度踏频服务
                return true;  // 匹配——通知上层应用
            }
        }
    }
    return false;
}

// 扫描回调：发现心率带/踏频器时自动连接
static void scan_cb(const bt_addr_le_t *addr, int8_t rssi,
                    uint8_t adv_type, struct net_buf_simple *buf)
{
    // 检查是否已配对过（白名单命中直接连接）
    if (bt_addr_le_is_bonded(BT_ID_DEFAULT, addr)) {
        // 已配对设备 → 直接发起连接，省略扫描确认流程
        int err = bt_conn_le_create(addr,
                                    BT_CONN_LE_CREATE_CONN,
                                    BT_LE_CONN_PARAM_DEFAULT,
                                    &central_conn);
        if (!err) {
            printk("Auto-connecting bonded device\n");
            bt_le_scan_stop();  // 连接建立后停止扫描以省电
        }
    }
}

// 初始化 Central 角色
void central_init(void)
{
    // 初始化时自动扫描已配对外设 10 秒
    bt_le_scan_start(&scan_param, scan_cb);

    // 10 秒后停止扫描，改为按 STM32 指令触发扫描
    k_sleep(K_SECONDS(10));
    bt_le_scan_stop();
    printk("Central scan timeout, waiting for trigger\n");
}
```

## 4. 安全管理：配对与绑定

### 4.1 配对等级

| 安全级别 | 名称 | 保护能力 | nRF52840 支持 |
|---------|------|---------|:---:|
| LE Security Mode 1 Level 1 | No Security | 无加密，明文通信 | ✓ |
| LE Security Mode 1 Level 2 | Unauthenticated Pairing | 加密但无 MITM 保护 | ✓ |
| LE Security Mode 1 Level 3 | Authenticated Pairing | 加密 + MITM 保护 | ✓ |
| LE Security Mode 1 Level 4 | Authenticated LE SC Pairing | 使用 ECDH + AES-128，最高安全等级 | ✓ |

### 4.2 LES 安全配对实现

```c
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gap.h>

// ＝＝＝＝ 配对参数配置 ＝＝＝＝

// IO 能力决定配对方式的选择
// Bicycle_Watch 有显示屏和按键 → IO_CAPS_DISPLAY_YESNO
// 配对时码表屏幕显示 6 位 PIN 码，用户在手机上输入，提供 MITM 保护
static const struct bt_conn_auth_cb auth_cb = {
    .passkey_display = passkey_display_cb,   // 显示 PIN 码到屏幕
    .passkey_confirm = passkey_confirm_cb,   // 用户按键确认配对
    .cancel          = auth_cancel_cb,       // 用户取消配对
};

// 需求：显示 6 位随机 PIN 码
// 在 Bicycle_Watch 中通过 UART 发送给 STM32，由 STM32 驱动 LVGL 显示
static void passkey_display_cb(struct bt_conn *conn, unsigned int passkey)
{
    char addr_str[BT_ADDR_LE_STR_LEN];
    bt_addr_le_to_str(bt_conn_get_dst(conn), addr_str, sizeof(addr_str));

    printk("Pairing PIN: %06u for %s\n", passkey, addr_str);

    // 通过 UART 发送 PIN 到 STM32，显示在码表屏幕上
    // 格式: "PAIR:PIN:123456:E4:5F:01:A2:B3:C4"
    uart_send_pairing_pin(passkey, addr_str);
}

// 配对完成回调
static void pairing_complete_cb(struct bt_conn *conn, bool bonded)
{
    printk("Pairing %s, bonded: %d\n",
           bonded ? "completed" : "failed", bonded);

    if (bonded) {
        // 保存绑定信息 —— SoftDevice 自动写入 Flash
        // 下次连接时直接用 LTK（Long Term Key）加密，无需再次配对
    }
}

// 绑定信息管理
static void bonding_init(void)
{
    // 设置 IO 能力：有显示屏 + Yes/No 按键
    bt_conn_auth_cb_register(&auth_cb);
    bt_conn_auth_info_cb_register(&pairing_complete_cb);

    // IO 能力在编译时通过 Kconfig 配置
    // CONFIG_BT_IO_CAPABILITY_DISPLAY_YESNO=y
}

// 白名单过滤：只有已绑定设备才能连接
// 在 Bicycle_Watch 中，码表只需要与主人的手机和外设通信，
// 白名单模式可防止陌生人扫描并尝试连接
void whitelist_enable(void)
{
    int err = bt_le_filter_accept_list_add(
        BT_ADDR_LE_ANY,           // 允许任何地址类型（Public/Random）
        BT_LE_FILTER_ACCEPT_LIST  // 添加到白名单过滤器
    );
    // 后续只有白名单设备可以连接
}
```

### 4.3 配对信息持久化

```c
// nRF Connect SDK 默认使用 Settings 子系统存储配对信息到 Flash
// prj.conf:
//   CONFIG_SETTINGS=y
//   CONFIG_SETTINGS_FCB=y          # Flash Circular Buffer
//   CONFIG_BT_SETTINGS=y           # 持久化蓝牙配对数据

#include <zephyr/settings/settings.h>

// 系统启动时从 Flash 加载已保存的配对信息
void bonding_restore(void)
{
    // settings_load() 从 Flash 读取配对信息并重建 RAM 中的 bond 表
    // 需要确保在 bt_enable() 之前调用（或在 bt_ready 中调用）
    int err = settings_load();
    if (err) {
        printk("Failed to load settings (err %d)\n", err);
    } else {
        printk("Bonding info restored from Flash\n");
    }
}

// 清除所有配对信息（恢复出厂设置时调用）
void bonding_clear_all(void)
{
    // 方法1：删除所有 bond
    bt_unpair(BT_ID_DEFAULT, NULL);  // NULL = 清除所有设备

    // 方法2：通过 settings 子系统和 bt 模块交互清空 Flash 记录
    // 在对 STM32 串口指令的响应中调用
}
```

## 5. Bicycle_Watch 连接状态机

```c
// 状态机驱动 BLE 的整个生命周期
// STM32 通过串口指令触发状态切换

enum ble_state {
    BLE_OFF,          // BLE 关闭（完全断电或深度休眠）
    BLE_INIT,         // 协议栈初始化中
    BLE_IDLE,         // 初始化完成，等待指令
    BLE_ADVERTISING,  // 广播中
    BLE_CONNECTED,    // 手机已连接
    BLE_SCANNING,     // Central 扫描外设中
    BLE_CONNECTING,   // Central 正在连接外设
    BLE_FULL_LINK,    // 双角色：手机 + 外设均已连接
};

static enum ble_state g_ble_state = BLE_OFF;

void ble_fsm_process(uint8_t cmd_from_stm32)
{
    switch (cmd_from_stm32) {

    case 0x10:  // 开机广播
        if (g_ble_state == BLE_IDLE || g_ble_state == BLE_ADVERTISING)
            start_advertising();
        g_ble_state = BLE_ADVERTISING;
        break;

    case 0x11:  // 停止广播进入低功耗
        bt_le_adv_stop();
        g_ble_state = BLE_IDLE;
        break;

    case 0x20:  // 扫描心率带/踏频器
        if (g_ble_state == BLE_CONNECTED)
            bt_le_scan_start(&scan_param, scan_cb);
        g_ble_state = BLE_SCANNING;
        break;

    case 0x30:  // 断开所有连接（用户停止骑行）
        // 断开所有连接句柄
        bt_conn_disconnect(default_conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
        g_ble_state = BLE_IDLE;
        // 重新开始广播等待下次连接
        start_advertising();
        break;

    case 0xF0:  // 恢复出厂设置
        bonding_clear_all();
        bt_le_adv_stop();
        g_ble_state = BLE_IDLE;
        break;
    }
}
```

## 6. 功耗数据实测

使用 Nordic Power Profiler Kit II 实测 nRF52840 在 Bicycle_Watch 各场景下的功耗：

| 场景 | 平均电流 | 说明 |
|------|---------|------|
| 系统休眠（System OFF） | 0.4μA | RAM 不保持，GPIO 唤醒 |
| 系统休眠（System ON, idle） | 1.5μA | RTC 保持，连接维持 |
| BLE 广播（100ms 间隔） | 190μA | 使用 DC/DC 供电 |
| BLE 广播（1000ms 间隔） | 35μA | 待机模式 |
| BLE 连接（100ms CI, idle） | 40μA | 空闲连接事件 |
| BLE 连接 + GATT 传输 | 2.8mA | 每连接事件发送 20 字节 |
| 多角色（1 Peripheral + 1 Central） | 210μA | 维护 2 条连接，空闲 |

> **结论**：在 Bicycle_Watch 的典型骑行场景（多角色 + 实时数据推送），nRF52840 的平均功耗约 2-3mA。搭配 500mAh 电池，仅 BLE 通信可续航约 150 小时。主要的功耗瓶颈在 STM32F411 + LVGL 显示侧，BLE 侧功耗占比很低。

## 下一步

本文详细介绍了 GAP 层的广播、连接和安全配对。下一篇文章将深入 **GATT 服务设计**：自定义 HRS 心率服务和 CSC 骑行速度踏频服务，数据格式（Flag Fields 的位定义），Notification 机制，以及在 Bicycle_Watch 中如何将传感器数据封装为 BLE GATT 标准服务供手机读取。
