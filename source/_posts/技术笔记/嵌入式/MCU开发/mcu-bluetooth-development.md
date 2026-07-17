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
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
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

// 发送 AT 指令到 HC-05（末尾追加 \r\n 作为命令结束符）
void HC05_SendCMD(char *cmd) {
    UART_SendString(cmd);       // 发送 AT 命令字符串
    UART_SendString("\r\n");    // AT 命令必须用回车换行结尾
    delay_ms(500);              // 等待模块响应（500ms 足够处理）
}

// HC-05 常用 AT 指令配置流程
void HC05_Config(void) {
    // 测试通信是否正常，模块应回复 "OK"
    HC05_SendCMD("AT");

    // 设置蓝牙广播名称（手机搜索时显示的名称）
    HC05_SendCMD("AT+NAME=MyBluetooth");

    // 设置配对密码（经典蓝牙 PIN 码，默认 1234）
    HC05_SendCMD("AT+PSWD=1234");

    // 设置串口参数：波特率 115200, 停止位 0=1bit, 校验位 0=None
    // 注意：修改波特率后需要以新波特率重新连接
    HC05_SendCMD("AT+UART=115200,0,0");

    // 设置角色：0=从机（Slave），1=主机（Master）
    // 从机模式等待手机连接，主机模式主动搜索并连接
    HC05_SendCMD("AT+ROLE=0");

    // 恢复出厂默认设置（慎用，会清除所有配置）
    HC05_SendCMD("AT+ORGL");
}
```

### 透传模式通信

```c
// HC-05 连接成功后自动进入透传模式
// 透传模式下，UART 发送的每个字节都会原封不动地通过蓝牙发送到对端
// 手机发送的数据也会原封不动地从 UART 输出

void UART2_Init(void) {
    // 初始化 USART2，参数需与 HC-05 AT 配置一致
    USART_Init(115200);  // 115200 波特率, 8 位数据, 1 位停止位, 无校验 (8N1)
}

// 透传发送：将数据逐字节写入串口
void BT_SendData(uint8_t *data, uint16_t len) {
    for (uint16_t i = 0; i < len; i++) {
        USART_SendByte(data[i]);  // 阻塞发送每个字节
    }
}

// 透传接收（中断方式）：在 USART2 中断中接收数据
void USART2_IRQHandler(void) {
    // 检查 RXNE 标志：接收数据寄存器非空（有新数据到达）
    if (USART2->SR & USART_SR_RXNE) {
        uint8_t ch = USART2->DR;          // 读取接收到的字节（自动清除 RXNE）
        // 将接收字节存入环形缓冲区，主循环再解析完整帧
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
// nRF52 系列 BLE 服务定义（以心率服务 Heart Rate Service 为例）
// BLE 标准服务 UUID 由 Bluetooth SIG 定义，确保跨设备兼容
#include "ble.h"

// 心率服务 UUID: 0x180D（Bluetooth SIG 标准 16-bit UUID）
#define BLE_UUID_HEART_RATE_SERVICE    0x180D
// 心率测量特征 UUID: 0x2A37（属于心率服务的 Mandatory Characteristic）
#define BLE_UUID_HR_MEASUREMENT         0x2A37

// 心率测量数据结构（遵循 Bluetooth SIG Heart Rate Service 规范）
typedef struct {
    uint8_t flags;        // Flags 字段：bit0=心率值格式(0=UINT8,1=UINT16), bit1=传感器接触状态, bit2=能量消耗, bit3=RR间期
    uint8_t heart_rate;   // 心率值（bpm，当 flags bit0=0 时用 UINT8）
    uint16_t rr_interval; // RR 间期（单位 1/1024 秒，可选字段，取决于 flags bit3）
} heart_rate_t;

// 开始 BLE 广播：向周围设备宣告自身存在
void BLE_Start_Adv(void) {
    ble_gap_adv_params_t adv_params = {
        .type = BLE_GAP_ADV_TYPE_ADV_IND,  // 可连接的非定向广播（通用发现模式）
        .p_peer_addr = NULL,               // 不指定目标地址（广播给所有设备）
        .fp = BLE_GAP_ADV_FP_ANY,          // 允许任何设备扫描和连接
        .interval = 100,                   // 广播间隔 = 100 * 0.625ms = 62.5ms（快速广播）
        .timeout = 0                       // 0 = 持续广播，不超时
    };
    sd_ble_gap_adv_start(&adv_params);     // SoftDevice API：启动广播
}

// 通过 BLE Notification 发送心率数据到已连接的手机
void BLE_Send_HeartRate(uint8_t hr) {
    heart_rate_t hr_data = {
        .flags = 0x01,       // flag bit0=1: 心率值使用 UINT8 格式（≤255 bpm）
        .heart_rate = hr     // 当前心率值
    };

    ble_gatts_hvx_params_t hvx_params = {
        .handle = m_hrs_hrm_handle,             // 心率测量特征的 GATT 句柄
        .type = BLE_GATT_HVX_NOTIFICATION,      // Notification：无需对端确认，效率更高
        .p_len = sizeof(hr_data),               // 数据长度
        .p_data = (uint8_t *)&hr_data           // 指向数据结构的指针
    };
    sd_ble_gatts_hvx(BLE_CONN_HANDLE, &hvx_params); // SoftDevice API：发送 Handle Value eXchange
}
```

### ESP32 BLE 开发

```c
// Arduino ESP32 BLE 服务示例（使用 ESP32 BLE Arduino 库）
// 创建一个自定义 GATT 服务，包含可读和可通知的特征值
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>        // BLE2902 = Client Characteristic Configuration Descriptor (CCCD)

BLEServer *pServer;                      // BLE 服务器指针
BLEService *pService;                    // GATT 服务指针
BLECharacteristic *pCharacteristic;      // GATT 特征值指针
bool deviceConnected = false;            // 连接状态标志

// 自定义服务 UUID 和特征 UUID（128-bit，可用在线工具随机生成）
#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// 连接状态回调类：监听设备的连接和断开事件
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;   // 设备连接成功
    }
    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;  // 设备断开连接，需重新广播
    }
};

void setup() {
    Serial.begin(115200);

    // 第1步：初始化 BLE 设备，设置广播名称
    BLEDevice::init("ESP32_BLE");

    // 第2步：创建 BLE 服务器并注册连接回调
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    // 第3步：创建 GATT 服务（UUID 标识服务类型）
    pService = pServer->createService(SERVICE_UUID);

    // 第4步：在服务下创建特征值（支持 Read 和 Notify 操作）
    pCharacteristic = pService->createCharacteristic(
        CHARACTERISTIC_UUID,
        BLECharacteristic::PROPERTY_READ |    // 允许手机主动读取
        BLECharacteristic::PROPERTY_NOTIFY    // 允许主动推送数据到手机
    );

    // 第5步：添加 CCCD 描述符（手机必须写入此描述符才能收到 Notify）
    pCharacteristic->addDescriptor(new BLE2902());
    pService->start();  // 启动服务

    // 第6步：配置广播数据并开始广播
    BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);  // 在广播包中携带服务 UUID
    pAdvertising->setScanResponse(true);         // 支持扫描响应数据
    BLEDevice::startAdvertising();               // 开始广播
}

void loop() {
    if (deviceConnected) {
        // 连接后每 100ms 发送一次模拟随机数据
        uint32_t data = random(0, 100);               // 生成 0-99 的随机数
        pCharacteristic->setValue(&data, 4);          // 设置特征值为 4 字节的 uint32
        pCharacteristic->notify();                     // 通过 Notify 推送到手机
    }
    delay(100);  // 100ms 发送间隔
}
```

---

## 4. 手机与 MCU 蓝牙通信

### Android 蓝牙连接步骤

```kotlin
// Android 经典蓝牙连接步骤（使用 RFCOMM 协议与 HC-05 通信）

// 第1步：获取 BluetoothAdapter（系统蓝牙管理器，单例对象）
val bluetoothAdapter = BluetoothAdapter.getDefaultAdapter()

// 第2步：检查蓝牙是否已开启，未开启则请求用户授权打开
if (!bluetoothAdapter.isEnabled) {
    val enableBtIntent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)  // 系统蓝牙开启意图
    startActivityForResult(enableBtIntent, REQUEST_ENABLE_BT)           // 弹窗请求用户授权
}

// 第3步：获取已配对设备列表（已绑定过 PIN 码的设备）
val pairedDevices = bluetoothAdapter.bondedDevices

// 第4步：通过 MAC 地址创建 RFCOMM 套接字并建立连接
val device = bluetoothAdapter.getRemoteDevice(macAddress)          // 根据 MAC 地址获取远程设备对象
val socket = device.createRfcommSocketToServiceRecord(uuid)        // 创建 RFCOMM 通道（基于 SDP UUID）
socket.connect()                                                    // 阻塞连接（需在后台线程执行）

// 第5步：建立连接后，通过 IO 流收发数据（经典蓝牙 SPP 串口协议）
val outputStream = socket.outputStream      // 获取输出流（MCU → Android）
val inputStream = socket.inputStream        // 获取输入流（Android → MCU）
outputStream.write(byteArrayOf(0x01, 0x02, 0x03))  // 发送十六进制指令到 MCU
```

### 数据协议设计

```c
// 自定义蓝牙数据帧协议：帧头 + 长度 + 命令 + 数据 + 校验
// 解决透传模式下的粘包和半包问题
typedef struct {
    uint8_t head;       // 帧头固定为 0xAA（同步字节，用于帧边界识别）
    uint8_t len;        // 数据长度 = cmd(1字节) + data(n字节)
    uint8_t cmd;        // 命令字（例如 0x01=控制, 0x02=查询, 0x03=配置）
    uint8_t data[32];   // 数据负载（最大 32 字节）
    uint8_t checksum;   // XOR 校验和（异或运算，简单高效）
} __attribute__((packed)) frame_t;  // packed 禁止编译器对齐填充

// 发送帧：组装协议帧并通过串口发送
void BT_SendFrame(uint8_t cmd, uint8_t *data, uint8_t len) {
    uint8_t buf[36];            // 临时缓冲区（1+1+1+32+1 = 36 字节）
    buf[0] = 0xAA;              // 帧头
    buf[1] = len + 2;           // 数据长度 = cmd(1字节) + data(len字节)
    buf[2] = cmd;               // 命令字
    memcpy(&buf[3], data, len); // 拷贝数据负载

    // 计算 XOR 校验和（帧头到数据末尾逐字节异或）
    uint8_t sum = 0;
    for (int i = 0; i < len + 3; i++)
        sum ^= buf[i];          // 逐字节异或累加
    buf[len + 3] = sum;         // 校验和放在帧尾

    // 串口阻塞发送整个帧
    for (int i = 0; i < len + 4; i++)
        USART_SendByte(buf[i]); // 帧总长度 = 4字节(头/长/命令/校验) + len
}

// 接收帧：状态机逐字节解析（在串口中断或主循环中调用）
int BT_ReceiveFrame(frame_t *frame) {
    static uint8_t state = 0;    // 状态机状态：0=等待帧头, 1=接收长度, 2=接收数据
    static uint8_t buf[36];      // 接收缓冲区
    static uint8_t idx = 0;      // 接收字节索引

    if (USART_Available()) {     // 检查串口是否有新数据
        uint8_t ch = USART_ReadByte();  // 读取一个字节

        switch (state) {
        case 0:  // 状态0：等待帧头 0xAA（同步字节）
            if (ch == 0xAA) {
                buf[idx++] = ch; // 保存帧头
                state = 1;       // 进入下一状态
            }
            // 非 0xAA 的字节直接丢弃（同步恢复）
            break;
        case 1:  // 状态1：接收长度字段
            buf[idx++] = ch;
            if (ch > 36) state = 0;  // 长度异常（超过最大帧长），复位状态机
            else state = 2;          // 长度合法，进入数据接收状态
            break;
        case 2:  // 状态2：接收剩余数据（命令字 + 数据 + 校验）
            buf[idx++] = ch;
            // 判断是否收齐一帧：索引达到 (长度字段值 + 4字节固定头部)
            if (idx >= buf[1] + 4) {
                // 第1步：计算 XOR 校验和
                uint8_t sum = 0;
                for (int i = 0; i < idx - 1; i++)
                    sum ^= buf[i];          // 对除校验字节外的所有字节做异或
                // 第2步：校验对比
                if (sum == buf[idx - 1]) {  // 校验通过
                    memcpy(frame, buf, idx); // 拷贝完整帧数据
                    state = 0;               // 复位状态机
                    idx = 0;
                    return 1;                // 返回 1 表示成功接收一帧
                }
                // 校验失败：丢弃整帧，状态机复位等待下一帧
                state = 0;
                idx = 0;
            }
            break;
        }
    }
    return 0;  // 未收到完整帧，继续等待
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
// BLE 广播间隔与功耗关系
// 广播间隔越短 → 手机发现越快 → 功耗越高
#define FAST_ADV_INTERVAL_MS    50   // 快速广播：设备刚上电或等待配对时使用
#define SLOW_ADV_INTERVAL_MS    1000 // 慢速广播：配对后降低功耗（1秒发一次广播包）

// 深度睡眠模式：系统完全断电，只有外部中断或复位能唤醒
// 适用场景：传感器节点长时间无数据需要上报
void BLE_Sleep(void) {
    sd_power_system_off();  // nRF SoftDevice API：关闭系统电源
}

// 连接参数更新：通过调整连接间隔降低已连接状态下的功耗
// 应在连接建立后由从机发起参数更新请求
void BLE_Update_Params(uint16_t min_interval, uint16_t max_interval) {
    ble_gap_conn_params_t params = {
        .min_conn_interval = min_interval,  // 最小连接间隔（单位 1.25ms）
        .max_conn_interval = max_interval,  // 最大连接间隔（越大约省电，但延迟越高）
        .slave_latency = 0,                 // 从机延迟：0=每个连接事件都响应
        .conn_sup_timeout = 500            // 连接监督超时（单位 10ms，500=5秒）
        // 若 5 秒内无数据交互则判定断连
    };
    sd_ble_gap_conn_param_update(conn_handle, &params); // 请求主机更新连接参数
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
