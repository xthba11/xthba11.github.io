---
title: nRF52840 + STM32 主从架构设计与 Bicycle_Watch 集成实战
date: 2026-07-20
categories:
  - 技术笔记
  - 嵌入式
  - BLE开发
tags:
  - nRF52840
  - STM32
  - UART通信
  - 主从架构
  - Bicycle_Watch
  - BLE
  - Nordic
description: nRF52840 与 STM32F411 主从架构设计：UART 通信协议（AT指令 + 二进制帧）、Bicycle_Watch 项目集成实践、双 MCU 任务划分、ID 命令系统设计、透传通道与异常恢复
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# nRF52840 + STM32 主从架构设计与 Bicycle_Watch 集成实战

## 1. 为什么选择双 MCU 架构

Bicycle_Watch 项目采用 STM32F411（主 MCU）+ nRF52840（BLE 协处理器）的双 MCU 架构。这个设计的出发点：

```
┌──────────────────────────────────────────────────────┐
│                   Bicycle_Watch 硬件架构               │
│                                                      │
│  ┌─────────────────────┐   ┌─────────────────────┐  │
│  │    STM32F411 (主)    │   │  nRF52840 (BLE协)    │  │
│  │                     │   │                     │  │
│  │ · FreeRTOS 任务调度   │◄──┤ · SoftDevice BLE栈   │  │
│  │ · LVGL 图形界面      │UART│ · GATT 服务          │  │
│  │ · 传感器采集         │115k│ · BLE Mesh 组网      │  │
│  │ · 数据存储 (Flash)   │bps │ · 配对/安全管理       │  │
│  │ · OTA 升级控制       │   │ · 低功耗广播/扫描      │  │
│  │ · 电源管理           │   │                     │  │
│  │ · 骑行算法           │   │                     │  │
│  └─────────┬───────────┘   └─────────┬───────────┘  │
│            │ I2C/SPI                 │ BLE          │
│  ┌─────────┴───────────┐   ┌─────────┴───────────┐  │
│  │ 各种传感器            │   │ 手机 App             │  │
│  │ · MPU6050 (IMU)     │   │ · 骑行数据查看         │  │
│  │ · AHT21 (温湿度)     │   │ · 配置管理            │  │
│  │ · BMP280 (气压)     │   │ · OTA 升级            │  │
│  │ · EM7028 (心率)     │   │ · 团队定位            │  │
│  │ · 霍尔传感器 (轮速)   │   │                     │  │
│  │ · W25Q64 (Flash)    │   │ 其他 BLE 设备          │  │
│  └─────────────────────┘   │ · 心率带               │  │
│                            │ · 踏频器               │  │
│                            └───────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**双 MCU 架构的收益：**

| 维度 | STM32 单 MCU 方案 | STM32 + nRF52840 双 MCU |
|------|------------------|------------------------|
| BLE 协议栈兼容性 | 依赖 HC-05 等透传模块，功能受限 | SoftDevice 认证协议栈，支持全部 BLE 5 特性 |
| 稳定性和可维护性 | 透传模块无状态管理，断连需手动恢复 | SoftDevice 管理连接状态，自动断连恢复 |
| BLE Mesh | 不支持（经典蓝牙透传模块无 Mesh） | 完整 Mesh 支持 |
| 射频性能 | 第三方模块性能不可控 | Nordic 原厂射频指标业界顶尖 |
| 功耗 | 单 MCU 低 | 增加 ~200μA（可接受） |
| 开发复杂度 | 简单 | 增加 UART 协议设计，但模块解耦更清晰 |
| BOM 成本 | 低 | 增加 nRF52840 + 晶振/天线（约 ¥15） |

## 2. 硬件连接：UART 通信链路

### 2.1 引脚连接

```
STM32F411                          nRF52840
┌──────────┐                    ┌──────────┐
│          │                    │          │
│  PA2 TX  │───────────────────►│  P0.08 RX│  UART 数据线（STM → nRF）
│  PA3 RX  │◄───────────────────│  P0.06 TX│  UART 数据线（nRF → STM）
│          │                    │          │
│  PB0     │───────────────────►│  P0.13   │  STM 输出：nRF 复位控制
│  PB1     │◄───────────────────│  P0.14   │  nRF 输出：BLE 连接状态指示
│  PB2     │───────────────────►│  P0.15   │  STM 输出：nRF 唤醒（低功耗场景）
│          │                    │          │
│  3.3V    │────────────────────│  VDD     │
│  GND     │────────────────────│  GND     │
└──────────┘                    └──────────┘

UART 参数：
  波特率: 115200
  数据位: 8
  停止位: 1
  校验位: None
  流控:   无（软件协议保证可靠性）
```

### 2.2 STM32 侧 UART 初始化

```c
// stm32_uart_bridge.c — Bicycle_Watch 工程中与 nRF52840 通信的 UART 驱动
// 位置: 02_BSP_Platform/Bsp_Drivers/bsp_uart_nrf_bridge.c

#include "stm32f4xx_hal.h"

// 使用 USART2 与 nRF52840 通信（PA2=TX, PA3=RX）
// 复用 DMA 接收，减轻 CPU 负担

#define NRF_UART            USART2
#define NRF_UART_BAUDRATE   115200
#define NRF_RX_BUF_SIZE     512    // 接收环形缓冲区大小
#define NRF_TX_BUF_SIZE     256    // 发送队列大小

typedef struct {
    uint8_t  rx_buf[NRF_RX_BUF_SIZE];   // 接收环形缓冲区
    uint16_t rx_head;                    // 写指针（中断中递增）
    uint16_t rx_tail;                    // 读指针（主循环中递增）
    uint8_t  rx_dma_buf[64];            // DMA 半满中断临时缓冲

    uint8_t  tx_queue[NRF_TX_BUF_SIZE]; // 发送队列
    uint16_t tx_head;
    uint16_t tx_tail;
    bool     tx_busy;                    // DMA 发送忙标志
} nrf_uart_t;

static nrf_uart_t g_nrf_uart;

// UART 初始化
void NRF_UART_Init(void)
{
    __HAL_RCC_USART2_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_DMA1_CLK_ENABLE();

    // GPIO: PA2=AF7(USART2_TX), PA3=AF7(USART2_RX)
    GPIO_InitTypeDef gpio = {
        .Pin = GPIO_PIN_2 | GPIO_PIN_3,
        .Mode = GPIO_MODE_AF_PP,
        .Pull = GPIO_NOPULL,
        .Speed = GPIO_SPEED_FREQ_HIGH,
        .Alternate = GPIO_AF7_USART2,
    };
    HAL_GPIO_Init(GPIOA, &gpio);

    // UART 参数: 115200-8-N-1
    UART_HandleTypeDef huart2 = {
        .Instance = USART2,
        .Init.BaudRate = 115200,
        .Init.WordLength = UART_WORDLENGTH_8B,
        .Init.StopBits = UART_STOPBITS_1,
        .Init.Parity = UART_PARITY_NONE,
        .Init.Mode = UART_MODE_TX_RX,
        .Init.HwFlowCtl = UART_HWCONTROL_NONE,
        .Init.OverSampling = UART_OVERSAMPLING_16,
    };
    HAL_UART_Init(&huart2);

    // 启动 DMA 空闲中断接收（效率远高于逐字节中断）
    // IDLE 中断识别帧间隙 → 比基于字节的帧解析更可靠
    __HAL_UART_ENABLE_IT(&huart2, UART_IT_IDLE);
    HAL_UART_Receive_DMA(&huart2, g_nrf_uart.rx_dma_buf, 64);
}

// IDLE 中断 → 表示 nRF 的一次完整发送结束
void USART2_IRQHandler(void)
{
    if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_IDLE)) {
        __HAL_UART_CLEAR_IDLEFLAG(&huart2);

        // 计算本次收到的字节数
        uint16_t rx_len = 64 - __HAL_DMA_GET_COUNTER(huart2.hdmarx);

        // 从 DMA buffer 拷贝到环形缓冲区
        for (uint16_t i = 0; i < rx_len; i++) {
            g_nrf_uart.rx_buf[g_nrf_uart.rx_head] =
                g_nrf_uart.rx_dma_buf[i];
            g_nrf_uart.rx_head =
                (g_nrf_uart.rx_head + 1) % NRF_RX_BUF_SIZE;
        }

        // 重新启动 DMA 接收
        HAL_UART_DMAStop(&huart2);
        HAL_UART_Receive_DMA(&huart2, g_nrf_uart.rx_dma_buf, 64);

        // 通知协议解析任务有新数据到达
        osSignalSet(nrf_parser_task_id, NRF_SIGNAL_RX_DATA);
    }

    HAL_UART_IRQHandler(&huart2);
}
```

## 3. 通信协议设计：ID 命令系统

### 3.1 协议设计思路

STM32 和 nRF52840 之间的通信协议需要同时满足：
- **命令-响应** 式交互（STM 下发命令 → nRF 执行并回复结果）
- **异步推送**（nRF 收到 BLE 数据后主动推给 STM）
- **可扩展**（新功能用新 ID，不影响旧指令）

我们设计了一套基于 **帧头 + ID + 长度 + 负载 + CRC** 的二进制协议：

```
帧格式（最大 256 字节）：

┌────────┬──────┬────────┬──────────┬──────┬──────┐
│ 0x5A   │  ID  │ Length │  Payload │ CRC8 │ 0xA5 │
│ 1 Byte │ 1Byte│ 1 Byte │  N Bytes │ 1Byte│ 1Byte│
│ 同步头  │ 命令ID│数据长度 │  数据负载  │ 校验 │ 帧尾  │
└────────┴──────┴────────┴──────────┴──────┴──────┘

特殊字节转义：若 Payload 中出现 0x5A/0xA5/0x7D，替换为 0x7D + (原始^0x20)
```

### 3.2 ID 指令表

```c
// nrf_cmd_id.h — STM32 ↔ nRF52840 通信协议
// 两端的代码库共用此头文件

// ====== STM32 → nRF52840 命令（0x01-0x7F） ======
#define CMD_NRF_PING                0x01  // 心跳检测（nRF 返回 PONG）
#define CMD_NRF_RESET               0x02  // 软件复位 nRF（不重置配对信息）
#define CMD_NRF_FACTORY_RESET       0x03  // 恢复出厂设置（删除所有配对信息）
#define CMD_NRF_GET_VERSION         0x04  // 查询 nRF 固件版本
#define CMD_NRF_GET_STATUS          0x05  // 查询 nRF 当前状态

// BLE 广播/连接控制
#define CMD_BLE_ADV_START           0x10  // 开始广播
#define CMD_BLE_ADV_STOP            0x11  // 停止广播（进入低功耗）
#define CMD_BLE_ADV_SET_PARAM       0x12  // 设置广播参数（间隔、模式）
#define CMD_BLE_DISCONNECT          0x13  // 断开指定连接
#define CMD_BLE_SCAN_START          0x14  // 扫描心率带/踏频器

// BLE GATT 数据推送
#define CMD_BLE_SEND_RIDE_STATUS    0x20  // 推送骑行状态到手机
#define CMD_BLE_SEND_RIDE_RECORD    0x21  // 推送骑行记录到手机
#define CMD_BLE_SEND_HR             0x22  // 推送心率数据

// BLE Mesh
#define CMD_MESH_SEND_POSITION      0x30  // 广播自身 GPS 位置
#define CMD_MESH_SEND_ALERT         0x31  // 发送紧急告警
#define CMD_MESH_GET_RIDERS         0x32  // 查询当前 Mesh 网络中的队员列表

// OTA
#define CMD_OTA_START               0x40  // 开始 OTA 升级
#define CMD_OTA_DATA                0x41  // OTA 数据块
#define CMD_OTA_FINISH              0x42  // OTA 结束校验

// ====== nRF52840 → STM32 事件（0x81-0xFF） ======
#define EVT_NRF_PONG                0x81  // 心跳响应
#define EVT_NRF_READY               0x82  // nRF 初始化完成（上电后第一个事件）
#define EVT_NRF_VERSION             0x84  // 版本信息
#define EVT_NRF_STATUS              0x85  // 状态信息

// BLE 连接事件
#define EVT_BLE_CONNECTED           0x91  // 手机连接成功
#define EVT_BLE_DISCONNECTED        0x92  // 手机断开连接
#define EVT_BLE_CONN_PARAM_UPDATED  0x93  // 连接参数更新
#define EVT_BLE_PAIRING_REQUEST     0x94  // 配对请求（携带对方地址）
#define EVT_BLE_PAIRING_COMPLETE    0x95  // 配对完成
#define EVT_BLE_PAIRING_FAILED      0x96  // 配对失败

// BLE 数据事件
#define EVT_BLE_RIDE_CONFIG_WRITE   0xA1  // 手机 App 修改了设备配置
#define EVT_BLE_STM32_CMD_WRITE     0xA2  // 手机 App 通过透传通道发送指令
#define EVT_BLE_OTA_CTRL_WRITE      0xA3  // 手机 App OTA 控制指令

// Mesh 事件
#define EVT_MESH_RIDER_POSITION     0xB1  // 收到队友位置
#define EVT_MESH_ALERT              0xB2  // 收到告警
#define EVT_MESH_RIDER_ONLINE       0xB3  // 队友上线
#define EVT_MESH_RIDER_OFFLINE      0xB4  // 队友离线
```

### 3.3 协议帧实现（STM32 侧）

```c
// nrf_protocol.c — 二进制协议帧的组包和解析
// 放在 01_APP/User_NRF_Protocol/ 目录下

#include "nrf_cmd_id.h"

// 帧结构（最大 256 字节）
typedef struct __attribute__((packed)) {
    uint8_t sync;    // 0x5A
    uint8_t id;      // 命令/事件 ID
    uint8_t len;     // Payload 长度 (N)
    uint8_t data[252]; // Payload
    uint8_t crc8;    // CRC-8-CCITT
    uint8_t end;     // 0xA5
} nrf_frame_t;

// CRC-8-CCITT 查表法（多项式: 0x07）
static const uint8_t crc8_table[256] = {
    0x00,0x07,0x0E,0x09,0x1C,0x1B,0x12,0x15,
    // ... 完整 256 项查表
};
static uint8_t crc8_calc(const uint8_t *data, uint8_t len)
{
    uint8_t crc = 0x00;
    for (uint8_t i = 0; i < len; i++) {
        crc = crc8_table[crc ^ data[i]];
    }
    return crc;
}

// 组包：将命令 ID + Payload 封装为完整的帧
uint8_t nrf_send_frame(uint8_t cmd_id, uint8_t *payload, uint8_t len)
{
    nrf_frame_t frame;
    uint8_t pos = 0;

    frame.sync = 0x5A;
    frame.id = cmd_id;
    frame.len = len;

    // 转义拷贝 Payload (0x5A/0xA5/0x7D → 0x7D + byte^0x20)
    uint8_t escaped_len = 0;
    for (uint8_t i = 0; i < len; i++) {
        uint8_t byte = payload[i];
        if (byte == 0x5A || byte == 0xA5 || byte == 0x7D) {
            frame.data[escaped_len++] = 0x7D;    // 转义前缀
            frame.data[escaped_len++] = byte ^ 0x20;
        } else {
            frame.data[escaped_len++] = byte;
        }
    }

    // CRC 对 [id, len, data] 计算（不含 sync）
    uint8_t crc_buf[253];
    crc_buf[0] = cmd_id;
    crc_buf[1] = escaped_len;
    memcpy(&crc_buf[2], frame.data, escaped_len);
    frame.crc8 = crc8_calc(crc_buf, 2 + escaped_len);
    frame.end = 0xA5;

    // 通过 DMA 发送（非阻塞）
    nrf_uart_dma_send(&frame, 5 + escaped_len);
    return 0;  // 协议层不等待响应——上层阻塞调用 read_frame 来等
}

// 解包：从接收缓冲区解析帧
// 返回: 1=收到完整帧, 0=尚未收到完整帧, -1=帧校验错误
int nrf_read_frame(uint8_t *cmd_id, uint8_t *payload,
                    uint8_t *len, uint32_t timeout_ms)
{
    nrf_frame_t frame;
    int ret = nrf_uart_read_frame_raw(&frame, timeout_ms);

    if (ret == 0) return 0;          // 超时，没有收到帧
    if (ret < 0) return -1;          // 帧格式错误

    // CRC 校验
    uint8_t crc_buf[253];
    crc_buf[0] = frame.id;
    crc_buf[1] = frame.len;
    memcpy(&crc_buf[2], frame.data, frame.len);
    uint8_t calc_crc = crc8_calc(crc_buf, 2 + frame.len);

    if (calc_crc != frame.crc8) {
        printk("NRF frame CRC error!\n");
        return -1;  // CRC 不匹配，丢弃
    }

    *cmd_id = frame.id;

    // 反转义拷贝
    uint8_t out_len = 0;
    for (uint8_t i = 0; i < frame.len; i++) {
        if (frame.data[i] == 0x7D) {
            i++;  // 跳过转义前缀
            payload[out_len++] = frame.data[i] ^ 0x20;
        } else {
            payload[out_len++] = frame.data[i];
        }
    }
    *len = out_len;
    return 1;  // 成功接收一帧
}
```

### 3.4 协议实现（nRF52840 侧）

```c
// ble_uart_bridge.c — nRF52840 端的 UART 桥接协议
// 与前几篇文章的 BLE 服务模块（ble_services.c、ble_gap.c）协作

#include <zephyr/drivers/uart.h>
#include "nrf_cmd_id.h"  // 与 STM32 侧共用的头文件

// UART 设备绑定
static const struct device *uart_dev =
    DEVICE_DT_GET(DT_NODELABEL(uart0));

// ============ 命令处理调度表 ============
// 用函数指针映射命令 ID → 处理函数，O(1) 查找
// 比 if-else 链或 switch 更干净，新增命令只需添加表项

typedef void (*cmd_handler_t)(uint8_t *payload, uint8_t len);

static void handle_ping(uint8_t *payload, uint8_t len);
static void handle_adv_start(uint8_t *payload, uint8_t len);
static void handle_send_ride_status(uint8_t *payload, uint8_t len);
static void handle_mesh_send_position(uint8_t *payload, uint8_t len);
// ... 更多处理函数

static const cmd_handler_t cmd_table[128] = {
    [CMD_NRF_PING]             = handle_ping,
    [CMD_NRF_RESET]            = handle_reset,
    [CMD_NRF_FACTORY_RESET]    = handle_factory_reset,
    [CMD_NRF_GET_VERSION]      = handle_get_version,
    [CMD_BLE_ADV_START]        = handle_adv_start,
    [CMD_BLE_ADV_STOP]         = handle_adv_stop,
    [CMD_BLE_ADV_SET_PARAM]    = handle_adv_set_param,
    [CMD_BLE_SEND_RIDE_STATUS] = handle_send_ride_status,
    [CMD_BLE_SEND_HR]          = handle_send_heart_rate,
    [CMD_MESH_SEND_POSITION]   = handle_mesh_send_position,
    [CMD_MESH_SEND_ALERT]      = handle_mesh_send_alert,
    // ... 更多命令映射
};

// 从 UART 收到一个完整帧后调用
void bridge_process_frame(uint8_t cmd_id, uint8_t *payload,
                           uint8_t len)
{
    if (cmd_id >= 0x80) {
        // 0x80+ 是事件（nRF → STM），不应从 STM 侧收到
        printk("Invalid cmd_id 0x%02X from STM32\n", cmd_id);
        return;
    }

    if (cmd_table[cmd_id]) {
        cmd_table[cmd_id](payload, len);
    } else {
        printk("Unknown cmd 0x%02X from STM32\n", cmd_id);
        // 返回 NACK 让 STM 知道命令未处理
        bridge_send_event(EVT_NRF_ERROR, &cmd_id, 1);
    }
}

// ============ 主动推送事件到 STM32 ============
// nRF 内部发生的事件（连接、数据到达等）需要主动通知 STM32

int bridge_send_event(uint8_t evt_id, uint8_t *data, uint8_t len)
{
    return uart_send_frame(evt_id, data, len);
}

// GAP 连接事件 → 通知 STM32
static void connected_cb(struct bt_conn *conn, uint8_t err)
{
    if (!err) {
        const bt_addr_le_t *peer = bt_conn_get_dst(conn);
        // 通知 STM32：手机已连接，携带对方地址
        bridge_send_event(EVT_BLE_CONNECTED,
                          (uint8_t *)peer, sizeof(*peer));
    }
}

// GATT 配置写入 → 通知 STM32（手机修改了码表参数）
static ssize_t device_config_write_cb(struct bt_conn *conn,
                                       const struct bt_gatt_attr *attr,
                                       const void *buf, uint16_t len,
                                       uint16_t offset, uint8_t flags)
{
    // 透传给 STM32 处理
    bridge_send_event(EVT_BLE_RIDE_CONFIG_WRITE,
                      (uint8_t *)buf, len);
    return len;
}
```

## 4. STM32 侧任务模型

在 Bicycle_Watch 的 FreeRTOS 任务框架中，nRF 通信作为一个独立任务运行：

```c
// app_nrf_task.c — STM32 侧 nRF 通信任务
// 注册在 user_task_reso_config.c 中

// 任务优先级：低于 UI 刷新（80ms），高于日志（500ms）
#define NRF_TASK_PRIORITY   3
#define NRF_TASK_STACK_SIZE 1024

void NRF_Task(void *argument)
{
    uint8_t cmd_id, payload[252], len;
    uint32_t now;

    // 等待 nRF52840 上电完成（EVT_NRF_READY）
    printk("[NRF_Task] Waiting for nRF52840 ready...\n");
    wait_for_evt(EVT_NRF_READY, 3000);

    // 启动 BLE 广播
    nrf_send_frame(CMD_BLE_ADV_START, NULL, 0);

    while (1) {
        // 阻塞等待 nRF 发送的数据（超时 100ms）
        int ret = nrf_read_frame(&cmd_id, payload, &len, 100);

        if (ret == 1) {
            // 收到完整帧 → 分发处理
            switch (cmd_id) {

            case EVT_BLE_CONNECTED: {
                // 手机已连接 → 更新 UI 状态图标
                ui_set_ble_state(UI_BLE_CONNECTED);
                // 启动心率数据定期推送
                osTimerStart(hr_push_timer, 1000);  // 每秒推送一次
                break;
            }

            case EVT_BLE_DISCONNECTED:
                ui_set_ble_state(UI_BLE_DISCONNECTED);
                osTimerStop(hr_push_timer);          // 停止心率推送
                // nRF 会自动重新广播，无需手动处理
                break;

            case EVT_BLE_PAIRING_REQUEST: {
                // 弹窗：显示 PIN 码让用户确认
                uint8_t pin[6];
                memcpy(pin, payload, len);  // payload = 6 位 PIN 码 ASCII
                ui_show_pairing_dialog(pin, payload + 6);  // +6 = 设备地址
                break;
            }

            case EVT_BLE_RIDE_CONFIG_WRITE:
                // 手机 App 修改了配置 → 写入 Flash 并应用
                struct device_config *cfg = (void *)payload;
                flash_save_config(cfg);
                apply_config(cfg);  // 立即生效（如轮径、单位制）
                break;

            case EVT_MESH_RIDER_POSITION:
                // 收到队友 GPS 位置 → 在地图页面标注
                ui_update_rider_marker((void *)payload);
                break;

            case EVT_MESH_ALERT:
                // 队友告警 → 弹窗 + 蜂鸣器提醒
                ui_show_alert_popup(payload[0]);  // payload[0] = 告警类型
                buzzer_beep(3, 200);               // 3 短声
                break;
            }
        }

        // 定期心跳检测（每 5 秒发一次 PING）
        now = HAL_GetTick();
        static uint32_t last_ping = 0;
        if (now - last_ping > 5000) {
            last_ping = now;
            nrf_send_frame(CMD_NRF_PING, NULL, 0);
            // PONG 在 read_frame 中收到 → 确认 nRF 存活
        }
    }
}
```

## 5. 异常恢复机制

双 MCU 架构需要处理两种 MCU 各自可能的异常：

```c
// ============ STM32 侧异常监控 ============

typedef enum {
    NRF_STATE_OFFLINE,       // nRF 无响应（可能未上电或死机）
    NRF_STATE_INIT,          // 初始化中
    NRF_STATE_READY,         // 正常运行
    NRF_STATE_ERROR,         // 故障（收到错误帧或 CRC 连续失败）
} nrf_state_t;

static nrf_state_t nrf_state = NRF_STATE_OFFLINE;
static uint8_t     nrf_ping_fail_count = 0;  // 连续心跳失败计数
#define NRF_PING_MAX_FAIL 3                   // 连续 3 次失败 → 硬件复位

void nrf_health_monitor(void)
{
    switch (nrf_state) {

    case NRF_STATE_OFFLINE:
        // 上电或复位 nRF → 等待 EVT_NRF_READY
        nrf_hardware_reset();  // PB0 拉低 100ms 再拉高
        nrf_state = NRF_STATE_INIT;
        break;

    case NRF_STATE_INIT:
        // 3 秒内应收到 EVT_NRF_READY，超时则重新复位
        break;

    case NRF_STATE_READY:
        // 正常运行时：检查心跳
        if (nrf_ping_fail_count >= NRF_PING_MAX_FAIL) {
            printk("[NRF] Ping timeout x%d → hardware reset\n",
                   nrf_ping_fail_count);
            nrf_state = NRF_STATE_OFFLINE;
            nrf_ping_fail_count = 0;
        }
        break;

    case NRF_STATE_ERROR:
        // 连续 CRC 错误 → 复位
        nrf_state = NRF_STATE_OFFLINE;
        break;
    }
}

// nRF 硬件复位
void nrf_hardware_reset(void)
{
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_RESET);  // PB0 LOW
    HAL_Delay(100);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_SET);    // PB0 HIGH
    printk("[NRF] Hardware reset issued\n");
}
```

## 6. 低功耗协同

在非骑行状态（码表放置在桌面），STM32 + nRF52840 进入联合低功耗模式：

```c
// ============ 联合低功耗策略 ============

typedef enum {
    POWER_MODE_ACTIVE,      // 骑行中：全速运行
    POWER_MODE_IDLE,        // 桌面待机：屏幕熄灭、BLE 慢速广播
    POWER_MODE_SLEEP,       // 深度休眠：STM32 STOP 模式、nRF System ON Idle
    POWER_MODE_OFF,         // 完全关机：两个 MCU 均断电
} power_mode_t;

void power_mode_transition(power_mode_t new_mode)
{
    switch (new_mode) {

    case POWER_MODE_IDLE:
        // 命令 nRF 切换到慢速广播（1s 间隔）
        uint8_t param[] = {ADV_MODE_STANDBY};
        nrf_send_frame(CMD_BLE_ADV_SET_PARAM, param, 1);

        // STM32 降低主频、关闭背光
        HAL_SYSCLK_Config(HSI_8MHz);  // 从 100MHz 降到 8MHz
        lvgl_backlight_off();
        break;

    case POWER_MODE_SLEEP:
        // 命令 nRF 停止广播，进入 System ON Idle（GPIO 唤醒）
        nrf_send_frame(CMD_BLE_ADV_STOP, NULL, 0);

        // STM32 进入 STOP 模式（GPIO / RTC 唤醒）
        HAL_PWR_EnterSTOPMode(PWR_LOWPOWERREGULATOR_ON,
                              PWR_STOPENTRY_WFI);
        // 唤醒后恢复
        SystemClock_Config();
        break;
    }
}
```

## 7. 连接 Bicycle_Watch 现有工程

将本系列文章的 nRF52840 代码集成到 Bicycle_Watch 项目的步骤：

### 7.1 代码结构映射

```
Bicycle_Watch 仓库:
├── 01_APP/
│   ├── User_NRF_Bridge/          ← [新增] STM32 侧 UART 协议层
│   │   ├── nrf_cmd_id.h          ← 共用头文件（也链接到 nRF 工程）
│   │   ├── nrf_protocol.c/h      ← 组包/解包
│   │   └── app_nrf_task.c/h      ← NRF_Task 任务
│   └── ...
├── 02_BSP_Platform/
│   └── Bsp_Drivers/
│       └── bsp_uart_nrf_bridge.c ← [新增] UART DMA 驱动
├── 03_Config/
│   └── feature_config.h
│       └── #define CFG_USE_BLE_NRF52840  1  ← [新增] 功能开关
│
nRF52840 工程 (独立 VS Code + nRF Connect 工程):
├── src/
│   ├── main.c                    ← 入口（bt_enable → 初始化 → 主循环）
│   ├── ble_uart_bridge.c/h       ← UART 协议 + 命令调度
│   ├── ble_gap.c/h               ← GAP：广播/连接/配对
│   ├── ble_services.c/h          ← GATT 服务定义 (HRS/CSC/自定义)
│   ├── ble_mesh_node.c/h         ← Mesh Provisioning + 模型
│   ├── ble_power_mgmt.c/h        ← 低功耗管理
│   └── nrf_cmd_id.h              ← 与 STM32 共用（符号链接或拷贝）
├── prj.conf                      ← Zephyr/Kconfig 配置
└── CMakeLists.txt
```

### 7.2 集成检查清单

| 步骤 | 检查项 | 验证方法 |
|------|--------|---------|
| ① 硬件 | UART 线序确认、电平匹配 | 示波器测 STM32 PA2 引脚看 TX 波形 |
| ② 供电 | nRF 3.3V 由 STM32 板上的 LDO 提供 | 万用表测 nRF VDD ≈ 3.3V ± 0.1V |
| ③ UART 驱动 | STM32 能发送、nRF 能从串口收到 | nRF UART shell `device:uart:0` 输出收到的字符 |
| ④ 协议握手 | STM32 发送 PING → nRF 返回 PONG | STM32 串口调试日志：PING → PONG |
| ⑤ BLE 广播 | `CMD_BLE_ADV_START` → 手机能搜到 | nRF Connect App 扫描 |
| ⑥ GATT 服务 | 手机连接后能看到 HRS/CSC/自定义服务 | nRF Connect App 查看 Services |
| ⑦ 异常恢复 | 故意拔掉 nRF 电源 → STM32 自动重连 | STM32 日志显示 Ping fail → Reset |
| ⑧ 功耗验证 | 联合待机电流 | 低功耗测试仪 （STM32 STOP + nRF System ON Idle ≤ 200μA）|

## 总结

本系列五篇文章覆盖了 nRF52840 BLE 开发的完整链路：

| 文章 | 主题 | 关键收获 |
|------|------|---------|
| 第一篇 | 开发环境搭建 | nRF Connect SDK + Beacon 初体验 |
| 第二篇 | GAP 广播连接 | 广播类型、连接参数、多角色并发、LES 安全配对 |
| 第三篇 | GATT 服务设计 | HRS/CSC/自定义服务、Notification 机制、数据链路 |
| 第四篇 | BLE Mesh 组网 | Provisioning、Rider 位置共享、告警、LPN 低功耗 |
| 第五篇 | STM32 集成 | UART 协议、命令调度、异常恢复、联合低功耗 |

在 Bicycle_Watch 项目中，nRF52840 不是替代 STM32，而是 **聚焦 BLE 通信的协处理器**——STM32 继续负责显示、传感器、存储和电源管理，nRF52840 负责所有蓝牙无线通信。清晰的模块边界 + 二进制协议 + 异常处理 = 一个可维护的双 MCU 产品固件。
