---
title: nRF52840 BLE Mesh 组网与骑行定位方案
date: 2025-08-22
categories:
  - 技术笔记
  - 嵌入式
  - BLE开发
tags:
  - nRF52840
  - BLE Mesh
  - RSSI定位
  - 组网
  - Nordic
  - 骑行定位
description: nRF52840 BLE Mesh 深度实践：Node 类型（Relay/Friend/Low Power）、消息模型（Client/Server）、骑行队伍组网架构、电子围栏方案；结合 RSSI 多点定位和 BLE Direction Finding 实现骑行场景中的位置感知
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# nRF52840 BLE Mesh 组网与骑行定位方案

## 1. BLE Mesh 是什么

BLE Mesh 是 Bluetooth SIG 在 2017 年发布的基于 BLE 的网状网络规范。与传统 BLE 的一对一（Central ↔ Peripheral）星型拓扑不同，Mesh 允许设备之间多对多通信——消息可以通过 Relay 节点多跳转发，覆盖范围远超单个 BLE 连接的距离。

```
传统 BLE（星型拓扑，点到点）      BLE Mesh（网状拓扑，多对多）
       Phone                         ┌──────────┐
      (Central)                 ┌───►│Rider A   │◄───┐
    ╱    │    ╲                 │    └────┬─────┘    │
   ╱     │     ╲                │         │ Relay     │
Device1  Dev2  Dev3             │    ┌────▼─────┐    │
                                ├───►│Rider B   │◄───┤
                                │    └────┬─────┘    │
                                │         │          │
                                │    ┌────▼─────┐    │
                                └───►│Rider C   │◄───┘
                                     └──────────┘
```

在骑行场景中，BLE Mesh 让骑行队伍中的每个码表都成为网络中的一个节点，消息（位置、告警、队形调整）自动多跳转发到所有队员。

## 2. BLE Mesh 架构基础

### 2.1 协议栈分层

```
┌─────────────────────────────────────────────────┐
│                Model Layer (模型层)               │
│  定义设备行为：开关、传感器、灯光控制等            │
├─────────────────────────────────────────────────┤
│              Access Layer (访问层)                │
│  定义消息格式：Opcode、参数编解码                  │
├───────────────────────┬─────────────────────────┤
│   Upper Transport      │ 分段/重组、心跳、Friend   │
├───────────────────────┼─────────────────────────┤
│   Lower Transport      │ 分段/重组、SEQ、重传      │
├───────────────────────┼─────────────────────────┤
│   Network Layer         │ 地址分配、中继、TTL       │
├───────────────────────┼─────────────────────────┤
│   Bearer Layer          │ ADV Bearer / GATT Bearer │
├───────────────────────┼─────────────────────────┤
│   BLE Core (Link Layer)│ 广播/扫描                 │
└───────────────────────┴─────────────────────────┘
```

### 2.2 四种 Node 类型

| Node 类型 | 功能 | 供电要求 | 骑行场景中的角色 |
|-----------|------|---------|----------------|
| **Relay** | 转发其他节点的消息 | 需持续供电 | 领队码表、保障车设备 |
| **Friend** | 为 Low Power 节点缓存消息 | 需持续供电 | 骑行 App（带手机的手环） |
| **Low Power (LPN)** | 仅定期唤醒查询 Friend 的消息 | 电池供电 | 队员码表（省电模式） |
| **Proxy** | BLE Mesh ↔ GATT 桥接 | 需持续供电 | 手机 App 通过 GATT 接入 Mesh |

### 2.3 编址模型

```c
// Mesh 网络中的地址系统
// ┌──────────────┬──────────┬────────────────────┐
// │  Unicast     │  Group   │  Virtual           │
// │  单个节点地址 │  组播地址 │  虚拟地址(128-bit)   │
// │  范围:0x0001-│ 0xC000-  │  基于 Label UUID    │
// │  0x7FFF      │ 0xFEFF   │  的哈希值            │
// └──────────────┴──────────┴────────────────────┘

// Bicycle_Watch 骑行队伍的地址分配方案：
//   0x0001:  领队码表 (Team Leader)
//   0x0002-0x0009: 队员码表 (Team Members, 最多 8 人)
//   0xC001: 全体广播组 (ALL_RIDERS) —— 领队通知全员
//   0xC002: 前后位置组 (FRONT_REAR) —— 队首/队尾专用通道
//   0xC003: 告警广播组 (ALERT) —— 紧急告警专用
```

## 3. Provisioning：设备入网

设备加入 Mesh 网络需要先经过 Provisioning 流程。手机 App 作为 Provisioner，通过 GATT Bearer 将网络密钥分发给新设备。

```c
#include <zephyr/bluetooth/mesh.h>

// ==================== 设备入网流程 ====================
//
// Step 1: nRF52840 上电后，发送 Unprovisioned Beacon
// Step 2: 手机 App (Provisioner) 扫描到此 Beacon
// Step 3: 建立 GATT 连接，通过 PB-GATT 协议交换密钥
// Step 4: 分配 Unicast Address 和 NetKey
// Step 5: 设备存储密钥和地址到 Flash
// Step 6: 断开 GATT，设备进入 Mesh 模式

// 设备 Provisioning 完成后的回调
static void prov_complete(uint16_t net_idx, uint16_t addr)
{
    printk("Provisioned! NetIdx: 0x%04x, Addr: 0x%04x\n",
           net_idx, addr);

    // 节点入网后自动将状态保存到 Settings 子系统（Flash）
    // 下次开机自动恢复到同一个 Mesh 网络
}

// Provisioning 恢复（从 Flash 加载已有配置）
static void mesh_ready(void)
{
    uint16_t own_addr = bt_mesh_primary_addr();

    if (BT_MESH_ADDR_IS_UNASSIGNED(own_addr)) {
        // 未配置 → 发送 Unprovisioned Beacon 等待手机配网
        printk("Waiting for provisioning...\n");
        // 闪灯提示用户打开 App 配网
        gpio_pin_set_dt(&led0, 1);
    } else {
        // 已有配置 → 直接进入 Mesh 模式
        printk("Restored Mesh node, addr: 0x%04x\n", own_addr);
    }
}

// Provisioning 能力位配置
// 在 Bicycle_Watch 中，码表有显示屏可以显示 OOB 信息
static const struct bt_mesh_prov prov_caps = {
    .uuid = dev_uuid,              // 设备 UUID（16 字节唯一标识）
    .uri = NULL,                   // 不使用 URI 配网
    .oob_info = BT_MESH_PROV_OOB_NONE, // 不使用带外（OOB）认证
    .static_val = NULL,            // 不使用静态 OOB
    .static_val_len = 0,
    .output_size = 4,             // 支持输出 OOB（显示 4 位 PIN 码）
    .output_actions = BT_MESH_DISPLAY_NUMBER,
    .output_number = display_prov_pin,  // 回调：在屏幕上显示 PIN
    .input_size = 0,
    .input_actions = 0,
};
```

## 4. 消息模型：骑行数据共享

### 4.1 自定义 Vendor Model

BLE Mesh 定义了两类消息模型：
- **SIG 定义模型**（如 Generic OnOff、Sensor Server）：Bluetooth SIG 标准
- **Vendor 模型**：厂商自定义，适合骑行场景的特殊数据

```c
// ==================== 骑行位置共享模型 ====================

// 我们定义一个 Vendor Model 用于位置共享
// Company ID: 0xFFFF (实际产品应向 Bluetooth SIG 申请 Company ID)
#define RIDEPULSE_COMPANY_ID    0xFFFF

// 消息 Opcode（3 字节：1 字节 Opcode + 2 字节 Company ID）
// 在 Mesh 消息中，Vendor 消息的 Opcode 格式为：
//   Byte 1: 0xC0-0xFF 的 SI 字段 + Company ID[0]
//   Byte 2: Company ID[1]
//   Byte 3: 实际操作码

enum ridepulse_mesh_opcodes {
    RIDEPULSE_OP_POSITION     = 0x01,  // 位置共享
    RIDEPULSE_OP_ALERT        = 0x02,  // 紧急告警
    RIDEPULSE_OP_FORMATION    = 0x03,  // 队形调整
    RIDEPULSE_OP_HEARTBEAT    = 0x04,  // 心跳/存活检测
    RIDEPULSE_OP_RIDE_STATS   = 0x05,  // 骑行统计（速度、里程）
};

// 位置消息负载（GPS 坐标 + 海拔）
struct position_msg {
    int32_t  latitude;   // 纬度 × 10^7
    int32_t  longitude;  // 经度 × 10^7
    int16_t  altitude;   // 海拔 (米)
    uint16_t heading;    // 航向 (度 × 100)
    uint8_t  speed;      // 速度 (km/h)
    uint8_t  accuracy;   // GPS 精度 (米, 0=无效)
} __attribute__((packed));

// 收到对端位置消息
static void handle_position_msg(struct bt_mesh_model *model,
                                struct bt_mesh_msg_ctx *ctx,
                                struct net_buf_simple *buf)
{
    struct position_msg pos;

    // 从消息 buffer 中解析 GPS 坐标
    pos.latitude  = net_buf_simple_pull_le32(buf);
    pos.longitude = net_buf_simple_pull_le32(buf);
    pos.altitude  = net_buf_simple_pull_le16(buf);
    pos.heading   = net_buf_simple_pull_le16(buf);
    pos.speed     = net_buf_simple_pull_u8(buf);
    pos.accuracy  = net_buf_simple_pull_u8(buf);

    printk("Rider 0x%04x: lat=%.6f lon=%.6f alt=%dm speed=%dkm/h\n",
           ctx->addr,
           pos.latitude / 1e7f, pos.longitude / 1e7f,
           pos.altitude, pos.speed);

    // 转发给 STM32 在 LVGL 地图页面上标注队友位置
    uart_send_rider_position(ctx->addr, &pos);
}

// 发送自身位置到全体广播组
int broadcast_position(struct position_msg *pos)
{
    struct net_buf_simple *msg = NET_BUF_SIMPLE(20);
    struct bt_mesh_msg_ctx ctx = {
        .net_idx = net_idx,         // 网络索引
        .app_idx = app_idx,         // 应用密钥索引
        .addr = 0xC001,             // ALL_RIDERS 组播地址
        .send_ttl = BT_MESH_TTL_DEFAULT,  // TTL = 3 (最多 3 跳)
        .send_rel = true,           // 要求 Relay 节点转发
    };

    // 构造位置消息
    net_buf_simple_init(msg, 0);
    net_buf_simple_add_le32(msg, pos->latitude);
    net_buf_simple_add_le32(msg, pos->longitude);
    net_buf_simple_add_le16(msg, pos->altitude);
    net_buf_simple_add_le16(msg, pos->heading);
    net_buf_simple_add_u8(msg, pos->speed);
    net_buf_simple_add_u8(msg, pos->accuracy);

    // 通过 Vendor Model 发布消息
    return bt_mesh_model_publish(&position_model, &ctx, msg);
}
```

### 4.2 紧急告警模型

```c
// ==================== 紧急告警 ====================

// 告警类型
enum alert_type {
    ALERT_CRASH         = 0x01,  // 摔车
    ALERT_MECHANICAL    = 0x02,  // 机械故障
    ALERT_LOW_BATTERY   = 0x03,  // 低电量
    ALERT_OFF_COURSE    = 0x04,  // 偏离路线
    ALERT_LOST_SIGNAL   = 0x05,  // 失去队员信号
};

// 告警消息（含 GPS 坐标方便队友定位）
struct alert_msg {
    uint8_t  type;       // 告警类型
    int32_t  latitude;   // 事发位置（纬度 × 10^7）
    int32_t  longitude;  // 事发位置（经度 × 10^7）
    uint8_t  severity;   // 严重程度（1-5, 5=最严重）
} __attribute__((packed));

// 摔车检测触发告警广播
int crash_alert_broadcast(struct position_msg *last_known_pos)
{
    struct alert_msg alert = {
        .type = ALERT_CRASH,
        .latitude  = last_known_pos->latitude,
        .longitude = last_known_pos->longitude,
        .severity = 5,  // 最高严重等级
    };

    // 告警使用独立的告警组播地址 + 高 TTL 确保送达
    struct bt_mesh_msg_ctx ctx = {
        .addr = 0xC003,              // ALERT 组播组
        .send_ttl = 5,               // 较高 TTL（最多 5 跳，扩大覆盖范围）
        .send_rel = true,
    };

    printk("!!! CRASH ALERT BROADCAST !!!\n");
    return bt_mesh_model_publish(&alert_model, &ctx,
                                  NET_BUF_SIMPLE_DEFINE(&alert, sizeof(alert)));
}
```

### 4.3 定义 Mesh Model

```c
// ==================== 注册 Mesh Model ====================

// 位置共享 Model 的操作码和回调映射
static const struct bt_mesh_model_op position_op[] = {
    {
        RIDEPULSE_OP_POSITION,              // Opcode
        BT_MESH_LEN_MIN(15),                // 最小消息长度验证
        handle_position_msg                 // 收到消息的回调
    },
    BT_MESH_MODEL_OP_END,  // 操作码列表结束标记
};

static const struct bt_mesh_model_op alert_op[] = {
    { RIDEPULSE_OP_ALERT,     BT_MESH_LEN_MIN(11), handle_alert_msg },
    { RIDEPULSE_OP_FORMATION, BT_MESH_LEN_MIN(2),  handle_formation_msg },
    BT_MESH_MODEL_OP_END,
};

// Model 声明（每个 Model 代表设备的一种行为）
static struct bt_mesh_model position_model = {
    .id = 0x0000,           // Model ID（在 Vendor 范围内的编号）
    .op = position_op,      // 支持的操作码
    .pub = &position_pub,   // 发布参数（定时/周期发布）
};

static struct bt_mesh_model alert_model = {
    .id = 0x0001,
    .op = alert_op,
    .pub = NULL,            // 告警不自动发布，手动触发
};

// Element 声明（一个设备可以有多个 Element）
// Bicycle_Watch 码表使用 2 个 Element：
//   Element 0: 核心功能（Provisioning、心率）
//   Element 1: 骑行数据（位置、告警、队形）
static struct bt_mesh_elem elements[] = {
    BT_MESH_ELEM(0, root_models, vendor_models),
    BT_MESH_ELEM(1, BT_MESH_MODEL_NONE, position_alert_vendor),
};
```

## 5. RSSI 与方向定位

在没有 GPS 的隧道、高架桥下骑行时，可以利用 BLE 信号强度（RSSI）进行相对定位。

### 5.1 RSSI 测距模型

```
RSSI 衰减公式（自由空间）:

  RSSI(d) = TX_Power - 10 × n × log₁₀(d)

其中：
  TX_Power = 发射功率 (0dBm 时 RSSI@1m)
  n        = 路径损耗指数 (空旷室外 ≈ 2.0, 城市 ≈ 2.7-3.5)
  d        = 距离 (米)

实测校准（nRF52840 @ 0dBm，空旷操场）：
  距离    RSSI
  1m      -45dBm
  5m      -65dBm
  10m     -78dBm
  20m     -88dBm
  50m     -96dBm
  100m    -105dBm (接近 receiver sensitivity limit)
```

### 5.2 多点 RSSI 三角定位

```c
// 队伍中有 3+ 个队员 → 可使用 RSSI 对某个队员做粗定位
// 精度：空旷场地约 3-5m，城市环境 5-15m

// 连续采集每个队友的 RSSI 做滑动平均
struct rssi_sample {
    uint16_t addr;       // 队友地址
    int8_t   rssi[16];   // 最近 16 个 RSSI 值
    uint8_t  idx;        // 环形缓冲区索引
    int8_t   avg;        // 当前平均值
};

// 定时（每 500ms）从 Mesh 心跳消息中更新 RSSI
static void update_rssi_from_heartbeat(uint16_t src_addr, int8_t rssi)
{
    struct rssi_sample *s = find_or_create_rssi_sample(src_addr);

    // 滑动窗口更新
    s->rssi[s->idx] = rssi;
    s->idx = (s->idx + 1) % 16;

    // 计算平均值（忽略最低和最高的 2 个值减少异常跳变）
    int8_t sorted[16];
    memcpy(sorted, s->rssi, 16);
    sort_int8(sorted, 16);
    int32_t sum = 0;
    for (int i = 2; i < 14; i++) {
        sum += sorted[i];
    }
    s->avg = sum / 12;
}

// 基于 RSSI 的距离估算
float rssi_to_distance(int8_t rssi, float n)
{
    // TX_Power @ 1m ≈ -45dBm (实测)
    return powf(10.0f, (-45.0f - rssi) / (10.0f * n));
}
```

## 6. 低功耗 Friend-LPN 方案

骑行车队中，队员设备对续航要求很高。使用 Friend-LPN 机制可以在不影响通信的前提下大幅降低队员设备的功耗：

```c
// ==================== Friend Node 配置（领队/保障车）=====================
// Friend 节点持续供电 → 具有足够的内存和电量缓存 LPN 的消息

#if CONFIG_BT_MESH_FRIEND
// Friend 节点需要足够的 RAM 缓存消息
// prj.conf:
//   CONFIG_BT_MESH_FRIEND=y
//   CONFIG_BT_MESH_FRIEND_QUEUE_SIZE=16    # 缓存 16 条消息
//   CONFIG_BT_MESH_FRIEND_RECV_WIN_FACTOR=8

void friend_init(void)
{
    bt_mesh_friend_init(BT_MESH_FRIEND_ENABLED);
    printk("Friend node enabled (caches messages for LPNs)\n");
}
#endif

// ==================== Low Power Node 配置（队员码表）=====================
// LPN 周期性唤醒查询 Friend，无需持续监听广播信道

#if CONFIG_BT_MESH_LOW_POWER
// prj.conf:
//   CONFIG_BT_MESH_LPN=y
//   CONFIG_BT_MESH_LPN_POLL_TIMEOUT=30      # 30 秒超时
//   CONFIG_BT_MESH_LPN_RECV_DELAY=100       # 接收延迟 100ms

// 节能效果：
//   标准 Relay 节点: 持续 RX → 平均电流 ~5mA
//   LPN (poll interval=5s): 间歇 RX → 平均电流 ~30μA
//   功耗降低约 99.4%

void lpn_init(void)
{
    // 设置 LPN 轮询策略
    struct bt_mesh_lpn_param lpn_params = {
        .rssi_factor   = 1,    // 信号质量权重
        .receive_delay = 100,  // 接收窗口 (ms)
        .poll_timeout  = 300,  // 超时时间 (100ms × 300 = 30s)
    };

    bt_mesh_lpn_init(&lpn_params);
    bt_mesh_lpn_set(true);    // 启用 LPN 模式
    printk("LPN mode enabled (poll every 30s)\n");
}
#endif
```

### LPN 功耗对比

| 模式 | 平均电流 | 500mAh 续航 | 消息延迟 |
|------|---------|------------|---------|
| 标准 Relay | 5mA | 100h | <50ms |
| LPN (5s poll) | 70μA | ~300 天 | ≤5s |
| LPN (30s poll) | 15μA | ~3.8 年 | ≤30s |
| LPN (60s poll) | 8μA | ~7.1 年 | ≤60s |

> 骑行场景推荐 LPN 5s 轮询：延迟可接受（<5s），续航远超实际骑行时间。

## 7. 电子围栏方案

利用 BLE Mesh + RSSI 实现电子围栏——当队员偏离一定范围时自动告警：

```c
// ==================== 电子围栏 ====================

// 阈值配置
#define GEOFENCE_WARN_THRESHOLD_M   200   // 警告阈值 (米)
#define GEOFENCE_ALERT_THRESHOLD_M  500   // 告警阈值 (米)
#define GEOFENCE_LOST_THRESHOLD_M   1000  // 失联阈值 (米)

// 每 5 秒检测一次所有队员是否在围栏内
void geofence_check(void *arg)
{
    for (int i = 0; i < num_riders; i++) {
        float distance = rssi_to_distance(riders[i].rssi_avg, 2.5f);

        if (distance > GEOFENCE_LOST_THRESHOLD_M) {
            // 队员可能走失 → 发送告警
            alert_broadcast(ALERT_LOST_SIGNAL, riders[i].addr);
            // 通知 STM32 LVGL 显示"失联队员"警告
            uart_send_stm32_alarm(ALARM_RIDER_LOST, riders[i].addr);

        } else if (distance > GEOFENCE_ALERT_THRESHOLD_M) {
            // 距离较大 → 通知领队
            uart_send_stm32_alarm(ALARM_RIDER_FAR, riders[i].addr);

        } else if (distance > GEOFENCE_WARN_THRESHOLD_M) {
            // 轻提醒
            uart_send_stm32_alarm(ALARM_RIDER_DISTANT, riders[i].addr);
        }
    }
}

// 注册定时任务：每 5 秒执行一次围栏检查
K_TIMER_DEFINE(geofence_timer, geofence_check, NULL);
// 在初始化中启动：k_timer_start(&geofence_timer, K_SECONDS(5), K_SECONDS(5));
```

## 8. BLE Direction Finding（AoA/AoD）简介

nRF52840 支持 BLE 5.1 引入的 **Direction Finding** 特性，可实现亚米级精度定位。对比传统 RSSI 定位：

| 定位技术 | 精度 | 硬件要求 | 功耗 | 骑行适用 |
|----------|------|---------|------|:---:|
| RSSI 单点 | 5-15m | 标准天线 | 低 | 粗定位 |
| RSSI 三角 | 3-10m | 标准天线 | 中 | 一般追踪 |
| AoA (到达角) | 0.5-2m | 天线阵列 | 中 | ✓ 精确定位 |
| AoD (发射角) | 0.5-2m | 天线阵列 | 低 | 队员定位 |
| GPS | 3-10m | GPS 模块 | 高 | ✓ 户外主定位 |

> AoA/AoD 需要特殊的天线阵列设计（至少 2 个天线），会增加 BOM 成本和 PCB 面积。对消费级自行车码表来说，RSSI + GPS 的组合方案在成本/功耗上更优。高端产品可增加 AoA 作为差异化功能。

## 下一步

Mesh 组网为骑行队伍提供了去中心化的实时通信能力。下一篇文章将回到 **Bicycle_Watch 硬件架构**：nRF52840 如何通过 UART 与 STM32F411 通信，AT 指令协议设计，以及如何将前几篇文章的 BLE 能力无缝集成到现有的 STM32 码表工程中。
