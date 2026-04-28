---
title: MCU开发专题：蓝牙开发从入门到实战
date: 2026-04-28
categories:
  - 技术笔记
  - 嵌入式
  - MCU开发
  - 蓝牙开发
tags:
  - MCU
  - STM32
  - 蓝牙
  - BLE
  - HC-05
  - BLE5.0
description: 蓝牙开发详解：HC-05 蓝牙模块、BLE 协议、透传与数据通信
top_img: https://source.unsplash.com/1600x900/?bluetooth,wireless
---

## 1. 蓝牙模块对比
description: 蓝牙开发详解：HC-05 蓝牙模块、BLE 协议、透传与数据通信
---

# MCU开发专题：蓝牙开发从入门到实战

## 1. 蓝牙模块对比

| 模块 | 类型 | 功耗 | 距离 | 价格 | 复杂度 |
|------|------|------|------|------|--------|
| HC-05 | 经典蓝牙 2.0 | 高 | 10m | 低 | 简单 |
| HC-08 | BLE 4.2 | 低 | 80m | 低 | 中等 |
| JDY-31 | 经典蓝牙 2.1 | 高 | 20m | 低 | 简单 |
| nRF52832 | BLE 5.0 | 极低 | 200m | 高 | 复杂 |
| ESP32 | BLE + WiFi | 中 | 200m | 中 | 中等 |

---

## 2. HC-05 经典蓝牙模块

### 硬件连接

```
MCU (USART2)    HC-05 模块
-------------------
PA2 (TX)    →   RX
PA3 (RX)    →   TX
3.3V        →   VCC
GND         →   GND
```

### AT 指令配置

```c
#include "usart.h"

// 发送 AT 指令
void HC05_SendCMD(char *cmd) {
    UART_SendString(cmd);
    UART_SendString("\r\n");
    delay_ms(500);
}

// 常用 AT 指令
void HC05_Config(void) {
    // 测试连接
    HC05_SendCMD("AT");

    // 设置蓝牙名称
    HC05_SendCMD("AT+NAME=MyBluetooth");

    // 设置配对密码
    HC05_SendCMD("AT+PSWD=1234");

    // 设置波特率（115200, 8N1）
    HC05_SendCMD("AT+UART=115200,0,0");

    // 设置角色：从机
    HC05_SendCMD("AT+ROLE=0");

    // 恢复默认
    HC05_SendCMD("AT+ORGL");
}
```

### 透传模式通信

```c
// HC-05 连接成功后自动进入透传模式
// 串口发送的数据会透传到对方

void UART2_Init(void) {
    // 115200, 8N1
    USART_Init(115200);
}

// 发送数据
void BT_SendData(uint8_t *data, uint16_t len) {
    for (uint16_t i = 0; i < len; i++) {
        USART_SendByte(data[i]);
    }
}

// 接收数据（中断）
void USART2_IRQHandler(void) {
    if (USART2->SR & USART_SR_RXNE) {
        uint8_t ch = USART2->DR;
        // 处理接收字节
        RingBuffer_Push(&rx_buf, ch);
    }
}
```

---

## 3. BLE 蓝牙开发（nRF52 系列）

### BLE 协议栈架构

```
┌─────────────────────────────────┐
│         Application            │  应用层
├─────────────────────────────────┤
│         GAP / GATT              │  协议层
├─────────────────────────────────┤
│         Host                     │  主机
├─────────────────────────────────┤
│         Controller               │  控制器
└─────────────────────────────────┘
         ↓  HCI ↓
┌─────────────────────────────────┐
│           BLE 芯片              │
└─────────────────────────────────┘
```

### BLE 服务定义

```c
// BLE 服务结构（以心率服务为例）
#include "ble.h"

// 心率服务 UUID: 0x180D
#define BLE_UUID_HEART_RATE_SERVICE    0x180D
// 心率测量特征 UUID: 0x2A37
#define BLE_UUID_HR_MEASUREMENT         0x2A37

// 心率测量特征值
typedef struct {
    uint8_t flags;        // 0x01: UINT8, 0x03: UINT16
    uint8_t heart_rate;   // 心率值
    uint16_t rr_interval; // RR 间期（可选）
} heart_rate_t;

// 广播参数
void BLE_Start_Adv(void) {
    ble_gap_adv_params_t adv_params = {
        .type = BLE_GAP_ADV_TYPE_ADV_IND,
        .p_peer_addr = NULL,
        .fp = BLE_GAP_ADV_FP_ANY,
        .interval = 100,  // 100 * 0.625ms = 62.5ms
        .timeout = 0      // 无超时
    };
    sd_ble_gap_adv_start(&adv_params);
}

// 发送心率数据
void BLE_Send_HeartRate(uint8_t hr) {
    heart_rate_t hr_data = {
        .flags = 0x01,
        .heart_rate = hr
    };

    ble_gatts_hvx_params_t hvx_params = {
        .handle = m_hrs_hrm_handle,
        .type = BLE_GATT_HVX_NOTIFICATION,
        .p_len = sizeof(hr_data),
        .p_data = (uint8_t *)&hr_data
    };
    sd_ble_gatts_hvx(BLE_CONN_HANDLE, &hvx_params);
}
```

### ESP32 BLE 开发

```c
// Arduino ESP32 BLE 服务示例
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

BLEServer *pServer;
BLEService *pService;
BLECharacteristic *pCharacteristic;
bool deviceConnected = false;

#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
    }
    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;
    }
};

void setup() {
    Serial.begin(115200);

    // 创建 BLE 设备
    BLEDevice::init("ESP32_BLE");

    // 创建服务器
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    // 创建服务
    pService = pServer->createService(SERVICE_UUID);

    // 创建特征
    pCharacteristic = pService->createCharacteristic(
        CHARACTERISTIC_UUID,
        BLECharacteristic::PROPERTY_READ |
        BLECharacteristic::PROPERTY_NOTIFY
    );

    // 添加描述符
    pCharacteristic->addDescriptor(new BLE2902());
    pService->start();

    // 开始广播
    BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    BLEDevice::startAdvertising();
}

void loop() {
    if (deviceConnected) {
        // 发送模拟数据
        uint32_t data = random(0, 100);
        pCharacteristic->setValue(&data, 4);
        pCharacteristic->notify();
    }
    delay(100);
}
```

---

## 4. 手机与 MCU 蓝牙通信

### Android 蓝牙连接步骤

```kotlin
// 1. 获取 BluetoothAdapter
val bluetoothAdapter = BluetoothAdapter.getDefaultAdapter()

// 2. 检查蓝牙是否开启
if (!bluetoothAdapter.isEnabled) {
    val enableBtIntent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)
    startActivityForResult(enableBtIntent, REQUEST_ENABLE_BT)
}

// 3. 获取已配对设备
val pairedDevices = bluetoothAdapter.bondedDevices

// 4. 连接设备
val device = bluetoothAdapter.getRemoteDevice(macAddress)
val socket = device.createRfcommSocketToServiceRecord(uuid)
socket.connect()

// 5. 读写数据
val outputStream = socket.outputStream
val inputStream = socket.inputStream
outputStream.write(byteArrayOf(0x01, 0x02, 0x03))
```

### 数据协议设计

```c
// 自定义协议：帧头 + 长度 + 数据 + 校验
typedef struct {
    uint8_t head;       // 0xAA
    uint8_t len;        // 数据长度
    uint8_t cmd;        // 命令字
    uint8_t data[32];   // 数据
    uint8_t checksum;   // XOR 校验
} __attribute__((packed)) frame_t;

// 发送
void BT_SendFrame(uint8_t cmd, uint8_t *data, uint8_t len) {
    uint8_t buf[36];
    buf[0] = 0xAA;
    buf[1] = len + 2;  // cmd + data
    buf[2] = cmd;
    memcpy(&buf[3], data, len);

    // 计算校验和（异或）
    uint8_t sum = 0;
    for (int i = 0; i < len + 3; i++)
        sum ^= buf[i];
    buf[len + 3] = sum;

    // 串口发送
    for (int i = 0; i < len + 4; i++)
        USART_SendByte(buf[i]);
}

// 接收
int BT_ReceiveFrame(frame_t *frame) {
    static uint8_t state = 0;
    static uint8_t buf[36];
    static uint8_t idx = 0;

    if (USART_Available()) {
        uint8_t ch = USART_ReadByte();

        switch (state) {
        case 0:
            if (ch == 0xAA) {
                buf[idx++] = ch;
                state = 1;
            }
            break;
        case 1:
            buf[idx++] = ch;
            if (ch > 36) state = 0;  // 长度异常
            else state = 2;
            break;
        case 2:
            buf[idx++] = ch;
            if (idx >= buf[1] + 4) {
                // 校验
                uint8_t sum = 0;
                for (int i = 0; i < idx - 1; i++)
                    sum ^= buf[i];
                if (sum == buf[idx - 1]) {
                    memcpy(frame, buf, idx);
                    state = 0;
                    idx = 0;
                    return 1;  // 接收成功
                }
                state = 0;
                idx = 0;
            }
            break;
        }
    }
    return 0;
}
```

---

## 5. 常见问题排查

| 问题 | 原因 | 解决 |
|------|------|------|
| HC-05 无法配对 | 波特率不匹配 | AT+UART 确认 9600 |
| HC-05 无法通信 | 透传模式未进入 | AT+CMODE=0 设为固定模式 |
| BLE 连接失败 | UUID 不匹配 | 确认服务和特征 UUID |
| BLE 断开 | 信号弱 | 增加天线、减小距离 |
| 数据乱码 | 串口参数错误 | 确认 8N1, 115200 |

---

## 6. 功耗优化

```c
// BLE 广播间隔与功耗
#define FAST_ADV_INTERVAL_MS    50   // 快速广播：省电
#define SLOW_ADV_INTERVAL_MS    1000 // 慢速广播：省电

// 深度睡眠模式（无通信时）
void BLE_Sleep(void) {
    sd_power_system_off();
}

// 连接参数更新（连接后降低功耗）
void BLE_Update_Params(uint16_t min_interval, uint16_t max_interval) {
    ble_gap_conn_params_t params = {
        .min_conn_interval = min_interval,
        .max_conn_interval = max_interval,
        .slave_latency = 0,
        .conn_sup_timeout = 500
    };
    sd_ble_gap_conn_param_update(conn_handle, &params);
}
```

---

## 总结

| 模块 | 推荐场景 | 难度 |
|------|---------|------|
| HC-05 | 简单透传、Arduino | ★☆☆ |
| HC-08 | BLE 低功耗 | ★★☆ |
| ESP32 | BLE + WiFi 双模 | ★★☆ |
| nRF52 | 专业 BLE 产品 | ★★★ |

> **选型建议**：项目简单用 HC-05，要低功耗用 BLE4.0+，要做产品用 nRF52。
