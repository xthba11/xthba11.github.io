---
title: nRF52840 BLE 开发环境搭建与入门
date: 2026-07-19
categories:
  - 技术笔记
  - 嵌入式
  - BLE开发
tags:
  - nRF52840
  - BLE
  - nRF Connect SDK
  - SoftDevice
  - 蓝牙
  - Nordic
description: 从零搭建 nRF52840 BLE 开发环境：nRF Connect SDK 安装、工程模板创建、SoftDevice 烧录与第一个 Beacon 广播程序
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# nRF52840 BLE 开发环境搭建与入门

## 1. nRF52840 芯片概述

nRF52840 是 Nordic 推出的旗舰级多协议 SoC，在 Bicycle_Watch 项目中作为独立的 BLE 通信协处理器，与 STM32F411 主机通过 UART 连接。

| 参数 | 规格 |
|------|------|
| 内核 | ARM Cortex-M4F @ 64MHz |
| Flash | 1MB |
| RAM | 256KB |
| 蓝牙 | BLE 5.4（2M PHY、Long Range、Advertising Extensions） |
| 其他无线 | 802.15.4（Thread / Zigbee）、ANT、NFC-A |
| 外设 | USB 2.0、QSPI、I2S、PDM、UART/SPI/I2C ×2 |
| GPIO | 48 个可编程 IO |

相比 STM32F411 内置的蓝牙方案，nRF52840 的优势在于：
- **原生 BLE 协议栈**：SoftDevice 经过 SIG 认证，兼容性远好于第三方透传模块
- **极低功耗**：休眠电流 < 1μA，BLE 广播平均电流 < 20μA
- **Long Range 模式**：空旷距离可达 800m+，适合户外骑行场景
- **BLE Mesh 支持**：骑行队伍组网、电子围栏等高级功能的基础

## 2. 开发环境安装

### 2.1 工具链概览

```
┌──────────────────────────────────────────────┐
│              开发主机（Windows / macOS）        │
│  ┌─────────────┐  ┌──────────────────────┐   │
│  │ nRF Connect │  │  nRF Command Line    │   │
│  │  for VS Code│  │  Tools (nrfjprog)    │   │
│  └──────┬──────┘  └──────────┬───────────┘   │
│         │                    │                │
│  ┌──────┴────────────────────┴───────────┐   │
│  │        nRF Connect SDK (v2.6+)        │   │
│  │    Zephyr RTOS + SoftDevice + HAL     │   │
│  └──────────────────┬────────────────────┘   │
│                     │                         │
│  ┌──────────────────┴────────────────────┐   │
│  │  ARM GNU Toolchain (arm-none-eabi-)   │   │
│  └───────────────────────────────────────┘   │
└──────────────────────┬───────────────────────┘
                       │ J-Link / DAP-Link
┌──────────────────────┴───────────────────────┐
│              nRF52840 DK / 自制板              │
└──────────────────────────────────────────────┘
```

### 2.2 安装步骤

**第 1 步：安装 nRF Command Line Tools**

从 Nordic 官网下载并安装 nRF Command Line Tools（含 `nrfjprog`、`J-Link` 驱动）：

```bash
# Windows 用户直接运行安装包
# 安装后验证
nrfjprog --version
# 输出: nrfjprog version: 10.24.0
```

**第 2 步：安装 VS Code 与 nRF Connect 插件**

```bash
# VS Code 扩展市场搜索并安装：
# 1. nRF Connect for VS Code (官方插件包)
# 2. nRF DeviceTree (设备树语法支持)
# 3. nRF Kconfig (Kconfig 语法支持)
```

**第 3 步：通过 nRF Connect 插件安装 SDK**

在 VS Code 中打开 nRF Connect 面板 → `Manage SDKs` → 安装 `nRF Connect SDK v2.6.0`（或最新稳定版）。插件会自动安装 Zephyr RTOS、SoftDevice 和必要的 Python 依赖。

**第 4 步：安装 ARM GNU 工具链**

插件会自动提示安装，也可手动安装：

```bash
# Windows (scoop)
scoop install arm-none-eabi-gcc

# macOS (Homebrew)
brew install --cask gcc-arm-embedded

# 验证
arm-none-eabi-gcc --version
```

### 2.3 硬件连接

nRF52840 开发板通过 J-Link 或板载调试器连接到 PC：

```
nRF52840 DK          USB Cable         PC
┌──────────┐      ╔══════════╗      ┌──────┐
│  USB     │◄────►║  Micro   ║◄────►│ VS   │
│  (J-Link)│      ║  USB     ║      │ Code │
├──────────┤      ╚══════════╝      └──────┘
│  VDD     │◄── 3.3V
│  GND     │◄── GND
│  P0.13   │──► LED1（调试用）
│  P0.06   │──► UART TX（串口日志）
│  P0.08   │──► UART RX
```

## 3. 第一个工程：Beacon 广播

### 3.1 创建工程

在 VS Code 中使用 nRF Connect 插件创建工程：

1. `Welcome` → `Create a new application`
2. 选择 `Copy a sample` → 搜索 `beacon`
3. Board 选择 `nrf52840dk_nrf52840`
4. 工程名：`bicycle_watch_beacon`

### 3.2 核心代码

```c
// main.c — 最小化 BLE Beacon 广播程序
// 基于 nRF Connect SDK (Zephyr) + SoftDevice BLE Controller

#include <zephyr/kernel.h>          // Zephyr RTOS 内核 API
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gap.h>          // GAP：广播、扫描、连接管理

// ----- 1. 广播数据 -----
// BLE 广播包（ADV_IND）：最多 31 字节
// 数据格式：Length(1) + AD Type(1) + AD Data(n) 的串联
static const struct bt_data ad_data[] = {
    // Flags: 通用发现模式（LE General Discoverable）
    // BR/EDR Not Supported（经典蓝牙不可用，纯 BLE 设备）
    BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),

    // Complete Local Name: 手机扫描时显示的设备名称
    BT_DATA_BYTES(BT_DATA_NAME_COMPLETE,
                  'R', 'i', 'd', 'e', 'P', 'u', 'l', 's', 'e',
                  '_', 'B', 'L', 'E'),

    // TX Power Level: 发射功率 @ 0dBm
    // 手机可根据接收信号强度 (RSSI) 与发射功率估算距离
    BT_DATA_BYTES(BT_DATA_TX_POWER, 0x00),
};

// ----- 2. 扫描响应数据 -----
// 手机主动扫描 (Active Scan) 时，设备可以额外回复 31 字节
// 用于存放设备信息、服务 UUID、设备型号等不适宜放进广播包的数据
static const struct bt_data sd_data[] = {
    // 16-bit Service UUID（不完整列表）：告知手机本设备支持的服务
    BT_DATA_BYTES(BT_DATA_UUID16_ALL,
                  0x0a, 0x18,  // 设备信息服务 (Device Information: 0x180A)
                  0x0f, 0x18,  // 电池服务 (Battery Service: 0x180F)
    ),
};

// ----- 3. 广播参数配置 -----
// 这些参数直接影响功耗和发现延迟
static struct bt_le_adv_param adv_param =
    BT_LE_ADV_PARAM_INIT(
        BT_LE_ADV_OPT_CONNECTABLE |    // 可连接（允许手机建立 GATT 连接）
        BT_LE_ADV_OPT_USE_NAME,        // 在扫描响应中包含设备名称
        160,    // 广播间隔最小 160 × 0.625ms = 100ms
        200,    // 广播间隔最大 200 × 0.625ms = 125ms
        NULL    // 不限制目标地址（向所有设备广播）
    );

// ----- 4. 广播启动/停止控制 -----
// 在 Bicycle_Watch 项目中，可通过 STM32 串口指令控制广播启停
// 产品待机时关闭广播省电，手机需要连接时再由 STM32 下发出广播

void start_advertising(void)
{
    int err;

    // 停止正在运行的广播（避免重复启动报错 -EALREADY）
    bt_le_adv_stop();

    // 启动广播：传入广播数据、扫描响应、广播参数
    err = bt_le_adv_start(&adv_param, ad_data, ARRAY_SIZE(ad_data),
                          sd_data, ARRAY_SIZE(sd_data));
    if (err) {
        printk("Advertising failed (err %d)\n", err);
        return;
    }
    printk("BLE Advertising started as RidePulse_BLE\n");
}

void stop_advertising(void)
{
    bt_le_adv_stop();
    printk("BLE Advertising stopped\n");
}

// ----- 5. 软就绪回调 -----
// SoftDevice Controller 初始化完成后由协议栈调用
// 在此处启动广播是最佳时机——协议栈已就绪，应用层初始化也已完成
static void bt_ready(int err)
{
    if (err) {
        printk("Bluetooth init failed (err %d)\n", err);
        return;
    }
    printk("SoftDevice ready, BLE stack initialized\n");

    // 协议栈就绪 → 启动广播
    start_advertising();
}

// ----- 6. 主函数 -----
void main(void)
{
    int err;

    printk("=== Bicycle_Watch nRF52840 BLE Node ===\n");
    printk("Build: %s %s\n", __DATE__, __TIME__);

    // 启用蓝牙子系统：注册 bt_ready 回调
    // bt_enable() 是非阻塞的——它触发 SoftDevice 初始化，
    // 初始化完成后在系统工作队列（System Workqueue）中回调 bt_ready
    err = bt_enable(bt_ready);
    if (err) {
        printk("bt_enable() failed (err %d)\n", err);
        return;
    }

    // 主循环空转——系统工作队列负责 BLE 事件处理
    // 实际项目中这里处理 STM32 串口指令（见第 5 篇文章）
    while (1) {
        k_sleep(K_FOREVER);
    }
}
```

### 3.3 编译与烧录

```bash
# 方式1：通过 nRF Connect VS Code 插件
# 点击侧边栏 "nRF Connect" → "Applications" → 选择工程 → "Build"

# 方式2：命令行编译
cd bicycle_watch_beacon
west build -b nrf52840dk_nrf52840 -p always

# 烧录（J-Link 连接后）
west flash

# 查看串口日志（波特率 115200）
# 使用 VS Code 内置串口终端或 PuTTY
```

烧录后手机打开 nRF Connect 或 LightBlue App，扫描后应能看到 `RidePulse_BLE` 设备。

## 4. SoftDevice 协议栈模型

nRF52840 使用 **SoftDevice** 作为 BLE 协议栈实现。理解 SoftDevice 的架构对后续开发至关重要。

### 4.1 内存布局

```
nRF52840 1MB Flash / 256KB RAM 布局：

Flash:
┌──────────────────────┐ 0x00000000
│   SoftDevice         │  ~152KB  (协议栈代码)
│   (BLE Controller)   │
├──────────────────────┤ 0x00026000
│   Application        │  ~872KB  (用户代码 + 文件系统)
│   (你的应用逻辑)      │
│                      │
│   ┌──────────────┐   │
│   │ 应用代码      │   │
│   ├──────────────┤   │
│   │ LVGL/UI 资源 │   │  (可选，在Bicycle_Watch中UI放STM32侧)
│   ├──────────────┤   │
│   │ LittleFS 存储 │   │  (配对信息、配置数据)
│   └──────────────┘   │
└──────────────────────┘ 0x00100000

RAM:
┌──────────────────────┐ 0x20000000
│   SoftDevice          │  ~12KB  (协议栈运行时数据)
├──────────────────────┤
│   Application         │  ~244KB (应用堆栈、数据缓冲区)
│   ┌──────────────┐   │
│   │ Zephyr Heap  │   │
│   ├──────────────┤   │
│   │ BLE Buffers  │   │
│   ├──────────────┤   │
│   │ App Data     │   │
│   └──────────────┘   │
└──────────────────────┘ 0x20040000
```

### 4.2 事件驱动模型

```c
// SoftDevice 使用异步事件驱动模型——所有 BLE 操作通过回调通知应用
// 这与 STM32 HAL 库的中断回调风格一致，便于理解和维护

// 以连接事件为例：
static void connected(struct bt_conn *conn, uint8_t err)
{
    if (err) {
        printk("Connection failed (err %u)\n", err);
        return;
    }

    // 获取对端设备地址并打印
    const bt_addr_le_t *peer = bt_conn_get_dst(conn);
    char addr_str[BT_ADDR_LE_STR_LEN];
    bt_addr_le_to_str(peer, addr_str, sizeof(addr_str));

    printk("Connected: %s\n", addr_str);  // Connected: XX:XX:XX:XX:XX:XX

    // 连接成功后停止广播以降低功耗
    stop_advertising();
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
    printk("Disconnected (reason %u)\n", reason);
    // 断开连接 → 重新开始广播，等待手机再次连接
    start_advertising();
}

// 注册连接回调（必须在 bt_enable 之前或 bt_ready 中调用）
BT_CONN_CB_DEFINE(conn_callbacks) = {
    .connected = connected,
    .disconnected = disconnected,
};
```

## 5. BLE 广播参数调优

在 Bicycle_Watch 项目中，广播参数的选型是功耗与体验之间的权衡：

| 场景 | 广播间隔 | 功耗 | 发现延迟 | 适用条件 |
|------|---------|------|---------|---------|
| 初始配对 | 20-30ms | ~1.5mA | <1s | 用户主动发起配对的 30s 窗口 |
| 快速广播 | 100-150ms | ~0.2mA | 1-3s | 骑行中需要手机维持连接 |
| 慢速广播 | 500-1000ms | ~0.04mA | 5-10s | 待机省电模式 |
| 定向广播 | 1-2s | ~0.02mA | 15-30s | 低电量紧急模式 |

```c
// 动态调整广播间隔——根据 STM32 主机指令切换模式
enum adv_mode {
    ADV_MODE_PAIRING,   // 配对模式：快速广播
    ADV_MODE_ACTIVE,    // 骑行模式：正常广播
    ADV_MODE_STANDBY,   // 待机模式：慢速广播
    ADV_MODE_LOW_BATT,  // 低电模式：定向慢速广播
};

static struct bt_le_adv_param adv_params[4] = {
    [ADV_MODE_PAIRING]  = BT_LE_ADV_PARAM_INIT(BT_LE_ADV_OPT_CONNECTABLE, 32, 48, NULL),
    [ADV_MODE_ACTIVE]   = BT_LE_ADV_PARAM_INIT(BT_LE_ADV_OPT_CONNECTABLE, 160, 200, NULL),
    [ADV_MODE_STANDBY]  = BT_LE_ADV_PARAM_INIT(BT_LE_ADV_OPT_CONNECTABLE, 800, 1200, NULL),
    [ADV_MODE_LOW_BATT] = BT_LE_ADV_PARAM_INIT(BT_LE_ADV_OPT_NONE, 1600, 3200, NULL),
};

// STM32 通过串口发送模式切换指令后调用此函数
void adv_mode_set(enum adv_mode mode)
{
    bt_le_adv_stop();

    int err = bt_le_adv_start(&adv_params[mode],
                              ad_data, ARRAY_SIZE(ad_data),
                              sd_data, ARRAY_SIZE(sd_data));
    if (err) {
        printk("Adv mode switch failed (err %d)\n", err);
    } else {
        printk("Adv mode: %d\n", mode);
    }
}
```

## 6. 调试方法

### 6.1 串口日志

nRF52840 使用 Zephyr 的 `printk` 输出日志到 UART：

```c
// prj.conf — 工程配置文件
CONFIG_LOG=y
CONFIG_LOG_MODE_IMMEDIATE=y       # 立即输出（不缓冲），调试用
CONFIG_UART_CONSOLE=y             # UART 作为控制台输出
```

### 6.2 nRF Connect 手机 App

手机端必备调试工具：[nRF Connect for Mobile](https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-for-mobile)

- **Scanner**：扫描周围 BLE 设备，查看广播包原始数据（AD Structure 逐字节解析）
- **Bonded**：查看已配对设备
- **Advertising**：手机模拟 BLE 外设广播（用于测试 nRF52840 的扫描功能）

### 6.3 抓包分析（nRF Sniffer）

```bash
# 使用 nRF52840 Dongle 作为 BLE Sniffer
# 配合 Wireshark 抓取空中 BLE 数据包
# 安装 nRF Sniffer for Bluetooth LE 插件后：
nrf_sniffer_ble.bat --extcap-interfaces
# 在 Wireshark 中选择 nRF Sniffer 接口即可抓包
```

## 7. 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `bt_enable` 返回 -5 | 未烧录 SoftDevice | 确认 prj.conf 中 `CONFIG_BT=y`，重新编译烧录 |
| 手机搜不到设备 | 广播间隔过大 / 天线问题 | 检查天线匹配网络、确认无金属遮挡 |
| 广播一段时间后停止 | 协议栈超时 | 检查是否误调用了 `bt_le_adv_stop()` |
| 编译错误 `CONFIG_BT_CTLR` | SDK 版本不匹配 | 使用 `west update` 同步子模块版本 |
| 连接立即断开 | 连接参数不兼容 | 检查 `conn_sup_timeout` 和 `slave_latency` |

## 下一步

本文搭建了 nRF52840 BLE 基础开发环境并跑通了 Beacon 广播。下一篇文章将深入 **BLE 广播与连接管理**：GAP 层详解、多角色并发（同时做 Peripheral 和 Central）、配对与绑定（LESC 安全配对），以及如何在 Bicycle_Watch 项目中实现手机自动回连。

> **Bicycle_Watch 项目背景**：nRF52840 作为 BLE 协处理器，通过 UART 接收 STM32F411 主机的指令来控制广播/扫描/连接。具体的主从通信协议设计见第 5 篇文章。
