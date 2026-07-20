---
title: nRF52840 GATT 服务设计与骑行数据协议（HRS / CSC / 自定义服务）
date: 2025-08-10
categories:
  - 技术笔记
  - 嵌入式
  - BLE开发
tags:
  - nRF52840
  - BLE
  - GATT
  - HRS
  - CSC
  - 自定义服务
  - Nordic
description: 深入 GATT 服务设计：基于 nRF52840 实现心率服务 HRS、骑行速度踏频服务 CSC、自定义骑行数据服务；讲解 characteristic 属性、Notification/Indication 机制、CCCD 描述符及 Bicycle_Watch 传感器到 BLE 的数据链路
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# nRF52840 GATT 服务设计与骑行数据协议

## 1. GATT 体系结构

### 1.1 Profile → Service → Characteristic 层次模型

```
Profile (应用规范)
  └─ Service (服务, 一组相关功能的集合)
      ├─ Characteristic (特征，一个可读/可写/可通知的数据单元)
      │   ├─ Value (数据值)
      │   ├─ Properties (属性: Read / Write / Notify / Indicate)
      │   └─ Descriptor (描述符, 控制特征的行为)
      │       └─ CCCD (Client Characteristic Configuration Descriptor)
      │           └─ 手机写入此描述符来启用 Notify/Indicate
      └─ Characteristic
          └─ ...
```

### 1.2 Bicycle_Watch 的 GATT 结构

```
RidePulse BLE Device
│
├─ Generic Access Service (0x1800)         ← 设备名称、外观
├─ Generic Attribute Service (0x1801)      ← MTU、Service Changed
├─ Device Information Service (0x180A)     ← 制造商、型号、固件版本
│   ├─ Manufacturer Name String
│   ├─ Model Number String
│   ├─ Firmware Revision String
│   └─ Hardware Revision String
│
├─ Battery Service (0x180F)                ← 电池电量
│   └─ Battery Level (Read | Notify)
│
├─ Heart Rate Service (0x180D)             ← 心率数据 (标准服务)
│   ├─ Heart Rate Measurement (Notify)
│   └─ Body Sensor Location (Read)
│
├─ Cycling Speed and Cadence (0x1816)      ← 骑行速度/踏频 (标准服务)
│   ├─ CSC Measurement (Notify)
│   └─ CSC Feature (Read)
│
└─ RidePulse Custom Service (自定义 128-bit UUID)
    ├─ Ride Status (Notify)                ← 骑行状态：骑/停/暂停
    ├─ Ride Record (Notify)                ← 单次骑行摘要
    ├─ Device Config (Read | Write)        ← 码表参数配置
    ├─ OTA Control (Write | Notify)        ← OTA 升级控制
    └─ STM32 Command (Write | Notify)      ← 透传 STM32 指令通道
```

## 2. 标准服务实现：心率服务 (HRS)

### 2.1 HRS 定义（Bluetooth SIG 标准）

心率服务是所有支持心率显示的 BLE 设备（心率带、运动手表、码表）必须支持或兼容的服务。

```
Heart Rate Service (UUID: 0x180D)
├─ Heart Rate Measurement (UUID: 0x2A37)   ← Mandatory, Notify
│   └─ CCCD (0x2902)                       ← 手机启用/禁用通知
└─ Body Sensor Location (UUID: 0x2A38)     ← Optional, Read
    └─ Values: 0=Other, 1=Chest, 2=Wrist, 3=Finger, 4=Hand, 5=Ear, 6=Foot
```

### 2.2 心率测量数据格式（Flag Fields 位定义）

```
Heart Rate Measurement (0x2A37) 数据包格式：

Byte 0: Flags
  bit 0: Heart Rate Value Format
         0 = UINT8  (≤255 bpm, 单位: bpm)
         1 = UINT16 (≤65535 bpm, 单位: bpm)
  bit 1: Sensor Contact Status  (bit1=0 & bit2=0 → 不支持检测)
         0 = 传感器接触检测不支持
         1 = 传感器接触检测不支持
  bit 2: Sensor Contact Status
         0 = 传感器接触良好
         1 = 传感器接触不良
  bit 3: Energy Expended Status
         0 = 不包含能量消耗字段
         1 = 包含能量消耗字段 (UINT16, 单位: kJ)
  bit 4: RR-Interval
         0 = 不包含 RR 间期
         1 = 包含一个或多个 RR 间期 (UINT16, 单位: 1/1024 秒)

Byte 1: Heart Rate Value (UINT8) 或 Byte 1-2: Heart Rate Value (UINT16)
Byte 2+: 可选字段 (根据 Flags 决定)
```

### 2.3 nRF52840 上实现 HRS

```c
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>

// ==================== HRS 服务实现 ====================

// State 变量：心率测量特征值句柄（手机连接后发现服务时赋值）
static struct bt_gatt_attr hrs_attrs[4];

// CCCD 配置变化回调 —— 手机 App 开启/关闭心率通知时触发
// 这个回调很重要：只有手机启用了 CCCD 才推送数据，否则白白耗电
static void hrs_cccd_changed(const struct bt_gatt_attr *attr,
                             uint16_t value)
{
    // value & BT_GATT_CCC_NOTIFY → 手机已启用 Notification
    bool notif_enabled = (value == BT_GATT_CCC_NOTIFY);

    printk("HRS notification %s\n",
           notif_enabled ? "ENABLED" : "DISABLED");

    // 通知 STM32 心率数据推送状态变化
    // STM32 据此决定是否停止读取心率传感器以省电
    uart_notify_stm32(CMD_HRS_CCCD_UPDATE, notif_enabled);
}

// 心率测量通知 —— 由 STM32 通过 UART 传入心率值后调用
// STM32 每收到一次心率传感器数据就传给 nRF52840 推送
int hrs_notify(uint8_t heart_rate, bool sensor_contact,
               uint16_t *rr_intervals, uint8_t rr_count)
{
    // 构造心率测量数据包（按 Bluetooth SIG HRS 规范）
    uint8_t data[20];  // 心率包通常很小，20 字节足够
    uint8_t pos = 0;

    // Byte 0: Flags
    uint8_t flags = 0;
    flags |= 0x00;  // bit 0 = 0: 心率值使用 UINT8 格式

    if (sensor_contact) {
        flags |= (1 << 2);  // bit 2: 传感器接触良好
    } else {
        flags |= (1 << 1);  // bit 1 = 0, bit 2 = 0: 不支持接触检测
    }

    if (rr_count > 0) {
        flags |= (1 << 4);  // bit 4: 包含 RR 间期字段
    }
    data[pos++] = flags;

    // Byte 1: Heart Rate Value (UINT8, 单位 bpm)
    data[pos++] = heart_rate & 0xFF;

    // 可选: RR 间期 (每个占 2 字节)
    if (rr_count > 0) {
        for (int i = 0; i < rr_count; i++) {
            // RR 间期 = 心跳间隔 × 1024
            sys_put_le16(rr_intervals[i], &data[pos]);
            pos += 2;
        }
    }

    // 通过 GATT Notification 推送
    int err = bt_gatt_notify(NULL, &hrs_attrs[1],
                             data, pos);
    if (err) {
        printk("HRS notify failed (err %d)\n", err);
    }
    return err;
}

// Body Sensor Location 读取回调
static ssize_t read_body_sensor_location(struct bt_conn *conn,
                                          const struct bt_gatt_attr *attr,
                                          void *buf, uint16_t len,
                                          uint16_t offset)
{
    // Bicycle_Watch 的心率传感器位置：Wrist（腕带式码表）
    uint8_t location = 0x02;  // 2 = Wrist
    return bt_gatt_attr_read(conn, attr, buf, len, offset,
                             &location, sizeof(location));
}

// 定义 HRS GATT 属性表（Attribute Table）
// 这是 SoftDevice 管理 GATT 数据库的核心数据结构
BT_GATT_SERVICE_DEFINE(hrs_svc,
    // ① 首要服务声明
    BT_GATT_PRIMARY_SERVICE(BT_UUID_HRS),

    // ② 心率测量特征值 (0x2A37)
    //    BT_GATT_CHRC_NOTIFY → 支持 Notify（无需对方确认，效率高）
    BT_GATT_CHARACTERISTIC(
        BT_UUID_HRS_MEASUREMENT,
        BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_NONE,    // 值本身无 Read/Write 权限
        NULL, NULL, NULL      // 实际数据由 Notify 推送，手机通过 CCCD 订阅
    ),

    // ③ CCCD 描述符 (0x2902)
    //    BT_GATT_PERM_READ | BT_GATT_PERM_WRITE → 手机可读写 CCCD
    //    手机向此描述符写入 0x0001 来订阅 Notify
    BT_GATT_CCC(
        hrs_cccd_changed,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE
    ),

    // ④ Body Sensor Location 特征值 (0x2A38)
    //    BT_GATT_CHRC_READ → 只读，手机可读取传感器位置
    BT_GATT_CHARACTERISTIC(
        BT_UUID_HRS_BODY_SENSOR_LOCATION,
        BT_GATT_CHRC_READ,
        BT_GATT_PERM_READ,
        read_body_sensor_location, NULL, NULL
    ),
);

// Helper: 从 STM32 接收心率数据的 UART 回调
// STM32 每 1 秒发送一次心率值（来自板载心率传感器）
void on_stm32_heart_rate(uint8_t hr)
{
    static bool hr_cccd_enabled = false;

    // 只在手机开启了心率通知时才推送
    if (hr_cccd_enabled) {
        hrs_notify(hr, true, NULL, 0);
    }
}
```

## 3. 标准服务实现：骑行速度踏频服务 (CSC)

### 3.1 CSC 数据格式

```
CSC Measurement (UUID: 0x2A5B) 数据包格式：

Byte 0: Flags
  bit 0: Wheel Revolution Data Present
         1 = 包含车轮转速数据（码表必须）
  bit 1: Crank Revolution Data Present
         1 = 包含曲柄转速数据（踏频）

当 bit0 = 1 — 车轮数据:
  Byte 1-4:   Cumulative Wheel Revolutions (UINT32)
              累计车轮转动圈数（上电起算，溢出后归零）
  Byte 5-6:   Last Wheel Event Time (UINT16)
              上次车轮事件时间 (单位: 1/1024 秒)

当 bit1 = 1 — 曲柄数据:
  Byte 7-8:   Cumulative Crank Revolutions (UINT16)
              累计曲柄转动圈数
  Byte 9-10:  Last Crank Event Time (UINT16)
              上次曲柄事件时间 (单位: 1/1024 秒)
```

### 3.2 nRF52840 上实现 CSC

```c
// CSC 特征值声明
// 与 HRS 实现模式完全相同，只是数据格式不同
static struct bt_gatt_attr csc_attrs[3];

static void csc_cccd_changed(const struct bt_gatt_attr *attr,
                             uint16_t value)
{
    printk("CSC notification %s\n",
           value == BT_GATT_CCC_NOTIFY ? "ENABLED" : "DISABLED");
}

// 推送骑行速度和踏频数据
// STM32 通过轮速霍尔传感器和踏频传感器实时计算后传入
int csc_notify(uint32_t wheel_revs, uint16_t last_wheel_event,
               uint16_t crank_revs, uint16_t last_crank_event)
{
    uint8_t data[11];
    uint8_t pos = 0;

    // Byte 0: Flags — 同时包含车轮和曲柄数据
    uint8_t flags = (1 << 0) | (1 << 1);
    data[pos++] = flags;

    // Wheel Revolution Data
    sys_put_le32(wheel_revs, &data[pos]);
    pos += 4;
    sys_put_le16(last_wheel_event, &data[pos]);
    pos += 2;

    // Crank Revolution Data (踏频)
    sys_put_le16(crank_revs, &data[pos]);
    pos += 2;
    sys_put_le16(last_crank_event, &data[pos]);
    pos += 2;

    return bt_gatt_notify(NULL, &csc_attrs[1], data, pos);
}

BT_GATT_SERVICE_DEFINE(csc_svc,
    BT_GATT_PRIMARY_SERVICE(BT_UUID_CSC),

    BT_GATT_CHARACTERISTIC(
        BT_UUID_CSC_MEASUREMENT,
        BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_NONE,
        NULL, NULL, NULL
    ),

    BT_GATT_CCC(csc_cccd_changed,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);
```

## 4. 自定义服务：RidePulse 骑行数据服务

标准服务只能传输心率、速度和踏频，但 Bicycle_Watch 还有很多数据需要和手机共享——骑行状态、骑行记录、设备配置。自定义服务正好填补这个空白。

### 4.1 自定义 128-bit UUID 生成

```c
// 使用 Nordic 推荐的 UUID 基础（Vendor Specific UUID Base）
// 128-bit UUID = 16-bit UUID Alias + 128-bit Base
//
// 自定义服务 Base:
//   f364adc9-b000-4042-ba50-05ca45b9e29e
// 自定义 16-bit aliases (在 Base 上替换 bit 12-13):
//   0x0000: Ride Status Characteristic
//   0x0001: Ride Record Characteristic
//   0x0002: Device Config Characteristic
//   0x0003: OTA Control Characteristic
//   0x0004: STM32 Command Characteristic

#define RIDEPULSE_SERVICE_UUID_BASE \
    BT_UUID_DECLARE_128(0xf364adc9, 0xb000, 0x4042, \
                        0xba50, 0x05ca45b9e29e)

// 用 BT_UUID_128_ENCODE 来定义 128-bit服务的 16 位别名
// Nordic 的使用习惯是：Base UUID 中 bit 12-13 用别名替换

// 注册自定义 UUID Base
static struct bt_uuid_128 ridepulse_svc_uuid =
    BT_UUID_INIT_128(RIDEPULSE_SERVICE_UUID_BASE);
```

### 4.2 骑行状态特征值

```c
// ============ 骑行状态通知 (Notify) ============

// 数据格式（每次骑行状态变化时推送一次）：
// Byte 0:  骑行状态 (0=停止, 1=骑行中, 2=暂停, 3=自动暂停)
// Byte 1-2: 当前骑行时长 (UINT16, 单位: 秒)
// Byte 3-6: 当前里程 (UINT32, 单位: 米)
// Byte 7-8: 当前速度 (UINT16, 单位: 0.1 km/h, 范围 0~6563)
// Byte 9:   电池百分比 (0-100)
// Byte 10:  GPS 信号强度 (0-100, 0=无信号)

struct ride_status_payload {
    uint8_t  state;        // 骑行状态
    uint16_t duration;     // 时长 (秒)
    uint32_t distance;     // 里程 (米)
    uint16_t speed;        // 速度 (0.1 km/h)
    uint8_t  battery;      // 电池
    uint8_t  gps_signal;   // GPS 信号
} __attribute__((packed));

// 通知：骑行状态发生变化时推送到手机
int ride_status_notify(struct ride_status_payload *status)
{
    // 限制最小推送间隔 = 1 秒（避免过度推送耗电）
    static int64_t last_notify_time = 0;
    int64_t now = k_uptime_get();

    if ((now - last_notify_time) < 1000) {
        return 0;  // 跳过，不给手机发洪水
    }
    last_notify_time = now;

    return bt_gatt_notify(NULL, &ridepulse_attrs[2],
                          status, sizeof(*status));
}
```

### 4.3 骑行记录特征值（骑行结束后推送摘要）

```c
// ============ 骑行记录通知 (Notify) ============

// 数据结构（一次骑行结束后，STM32 计算摘要传给 nRF52840 推送）：
struct ride_record_payload {
    uint32_t record_id;       // 记录编号（递增）
    uint32_t start_timestamp; // 开始时间 (Unix 时间戳)
    uint32_t duration;        // 骑行时长 (秒)
    uint32_t distance;        // 总里程 (米)
    uint16_t avg_speed;       // 平均速度 (0.1 km/h)
    uint16_t max_speed;       // 最高速度 (0.1 km/h)
    uint8_t  avg_hr;          // 平均心率 (bpm)
    uint8_t  max_hr;          // 最高心率 (bpm)
    uint16_t calories;        // 卡路里消耗 (kcal)
    uint16_t ascent;          // 累计爬升 (米)
    uint8_t  ride_type;       // 骑行类型 (0=通勤, 1=公路, 2=山地, 3=其他)
} __attribute__((packed));

int ride_record_notify(struct ride_record_payload *record)
{
    printk("Sending ride record #%u: %.2f km, %u min\n",
           record->record_id,
           record->distance / 1000.0f,
           record->duration / 60);

    return bt_gatt_notify(NULL, &ridepulse_attrs[3],
                          record, sizeof(*record));
}
```

### 4.4 设备配置特征值（可读写）

```c
// ============ 设备配置 (Read | Write) ============

// 手机 App 通过 Write 修改码表配置，nRF52840 通过 UART 透传给 STM32
// 手机 App 通过 Read 读取当前配置值

struct device_config {
    uint16_t wheel_circumference; // 轮径 (mm, 默认 2096 = 700×23C)
    uint8_t  units;               // 单位制 (0=公制, 1=英制)
    uint8_t  auto_pause;          // 自动暂停 (0=关, 1=开启, 阈值 3km/h)
    uint8_t  backlight_timeout;   // 屏幕超时 (秒, 0=常亮)
    uint8_t  hr_zone_max;         // 心率区间上限 (bpm)
    char     rider_name[16];      // 骑手名称
} __attribute__((packed));

// 写回调 — 手机 App 下发配置
static ssize_t device_config_write(struct bt_conn *conn,
                                    const struct bt_gatt_attr *attr,
                                    const void *buf, uint16_t len,
                                    uint16_t offset, uint8_t flags)
{
    if (len != sizeof(struct device_config)) {
        return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
    }

    // 将配置通过 UART 转发给 STM32
    uart_send_config_to_stm32((struct device_config *)buf);

    // 更新本地存储的配置（支持手机 Read 查询）
    memcpy(&g_device_config, buf, sizeof(g_device_config));

    return len;
}

// 读回调 — 手机 App 查询当前配置
static ssize_t device_config_read(struct bt_conn *conn,
                                   const struct bt_gatt_attr *attr,
                                   void *buf, uint16_t len,
                                   uint16_t offset)
{
    return bt_gatt_attr_read(conn, attr, buf, len, offset,
                             &g_device_config, sizeof(g_device_config));
}
```

### 4.5 完整自定义服务定义

```c
// 自定义服务的 GATT Attribute Table
// 包含以上所有特征值的完整定义

enum {
    RIDEPULSE_ATTR_SVC,           // 主服务声明
    RIDEPULSE_ATTR_STATUS,        // 骑行状态 (Notify)
    RIDEPULSE_ATTR_STATUS_CCCD,   // 骑行状态 CCCD
    RIDEPULSE_ATTR_RECORD,        // 骑行记录 (Notify)
    RIDEPULSE_ATTR_RECORD_CCCD,   // 骑行记录 CCCD
    RIDEPULSE_ATTR_CONFIG,        // 设备配置 (Read | Write)
    RIDEPULSE_ATTR_OTA,           // OTA 控制 (Write | Notify)
    RIDEPULSE_ATTR_OTA_CCCD,      // OTA CCCD
    RIDEPULSE_ATTR_STM32_CMD,     // STM32 命令透传 (Write | Notify)
    RIDEPULSE_ATTR_STM32_CCCD,    // STM32 命令 CCCD
    RIDEPULSE_ATTR_COUNT,
};

// BT_GATT_SERVICE_DEFINE 宏展开为全局的结构体数组（.compound 段）
// SoftDevice 在 bt_enable() 时自动将此数组注册到 GATT 数据库
BT_GATT_SERVICE_DEFINE(ridepulse_svc,
    // ① 首要服务：使用自定义 128-bit UUID
    BT_GATT_PRIMARY_SERVICE(&ridepulse_svc_uuid),

    // ② 骑行状态特征值
    BT_GATT_CHARACTERISTIC(
        BT_UUID_DECLARE_16(0x0000),    // 16-bit Alias
        BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_NONE,
        NULL, NULL, NULL
    ),
    BT_GATT_CCC(status_cccd_changed,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

    // ③ 骑行记录特征值
    BT_GATT_CHARACTERISTIC(
        BT_UUID_DECLARE_16(0x0001),
        BT_GATT_CHRC_NOTIFY,
        BT_GATT_PERM_NONE,
        NULL, NULL, NULL
    ),
    BT_GATT_CCC(record_cccd_changed,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

    // ④ 设备配置特征值
    BT_GATT_CHARACTERISTIC(
        BT_UUID_DECLARE_16(0x0002),
        BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
        BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
        device_config_read, device_config_write, NULL
    ),
);
```

## 5. 数据链路全景：从传感器到手机 App

```
Bicycle_Watch 中一次心率推送的完整数据链路：

┌──────────────┐    I2C     ┌──────────────┐   UART    ┌──────────────┐
│  心率传感器   │──────────►│  STM32F411   │──────────►│  nRF52840    │
│  (MAX30102)  │ 原始PPG数据 │  滤波+算心率  │ 心率值(bpm)│  BLE协议栈    │
└──────────────┘            └──────────────┘           └──────┬───────┘
                                                              │
              ┌───────────────────────────────────────────────┘
              │ GATT Notification
              ▼
┌─────────────────────┐     ┌─────────────────┐
│  手机 BLE 协议栈     │────►│  RidePulse App  │
│  (iOS/Android)      │     │  显示心率曲线    │
└─────────────────────┘     └─────────────────┘

时间预算（从传感器读到手机显示）：
  MAX30102 采集:  25ms    (FIFO 32 samples @ 100Hz)
  STM32 滤波+算HR: <1ms   (移动平均滤波)
  UART 传输:      <1ms    (115200bps, 4 字节数据)
  BLE Notification: ~3ms  (连接间隔 25ms 内)
  App UI 刷新:    <16ms   (60fps)
  ─────────────────────
  总延迟:         <50ms   (满足实时心率显示需求)
```

## 6. Notification 批量优化

每发送一次 Notification 都需要一次射频活动。如果连续发送多个特征值，应合并到一次连接事件中：

```c
// 连续推送心率 + 速度 + 骑行状态到手机
// 优化：3 次 Notification 合并到同一个连接事件中（单次射频唤醒）
void push_all_sensor_data(struct sensor_snapshot *snap)
{
    // 心率
    if (hrs_cccd_enabled) {
        hrs_notify(snap->heart_rate, true, NULL, 0);
    }

    // 骑行速度踏频
    if (csc_cccd_enabled) {
        csc_notify(snap->wheel_revs, snap->last_wheel_event,
                   snap->crank_revs, snap->last_crank_event);
    }

    // 骑行状态
    if (status_cccd_enabled) {
        ride_status_notify(&snap->ride_status);
    }

    // SoftDevice 将这 3 次 Notification 排队，在同一个连接事件中发送
    // 不会增加额外的射频唤醒开销
}
```

## 7. 手机端开发要点

手机 App 与 nRF52840 GATT 服务交互的典型流程（Android BLE API 示例）：

```java
// Android BLE 连接后服务发现与订阅流程
BluetoothGatt gatt = device.connectGatt(context, false, gattCallback);

@Override
public void onServicesDiscovered(BluetoothGatt gatt, int status) {
    // ① 发现心率服务
    BluetoothGattService hrsService =
        gatt.getService(UUID.fromString("0000180D-0000-1000-8000-00805f9b34fb"));

    // ② 获取心率测量特征
    BluetoothGattCharacteristic hrMeasurement =
        hrsService.getCharacteristic(
            UUID.fromString("00002A37-0000-1000-8000-00805f9b34fb"));

    // ③ 启用 CCCD → 开始接收心率通知
    BluetoothGattDescriptor cccd =
        hrMeasurement.getDescriptor(
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
    cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
    gatt.writeDescriptor(cccd);
}

@Override
public void onCharacteristicChanged(BluetoothGatt gatt,
                                     BluetoothGattCharacteristic chr) {
    byte[] data = chr.getValue();
    // 根据 UUID 区分是心率、CSC 还是自定义骑行状态
    // 解析 Flag Fields 提取实际数据
    parseAndDisplay(data);
}
```

## 下一步

本文详细讲解了 GATT 服务设计与骑行数据协议实现。下一篇文章将深入 **BLE Mesh 组网定位**：Node 类型（Relay、Friend、Low Power）、Mesh 消息模型、骑行队伍组网方案，以及基于 RSSI 的多点定位。

> **提示**：GATT 服务定义的代码建议抽象为独立的 `ble_services.c` 模块，与 GAP 管理的 `ble_gap.c` 和 UART 通信的 `ble_uart_bridge.c` 分离开，便于测试和维护。
