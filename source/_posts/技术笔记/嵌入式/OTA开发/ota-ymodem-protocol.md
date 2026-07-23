---
title: Ymodem 协议解析与 Bicycle_Watch 实现
date: 2025-09-26
categories:
  - 技术笔记
  - 嵌入式
  - OTA开发
tags:
  - OTA
  - Ymodem
  - CRC16
  - 串口传输
  - STM32
  - Bicycle_Watch
description: Ymodem 文件传输协议深度解析：数据包格式（SOH/STX/EOT/ACK/NAK）、握手流程、CRC16 校验、超时重传机制、Bicycle_Watch 中的双缓冲接收实现（DMA+IDLE）、文件大小传递与进度回调
cover: /img/covers/articles/ota-ymodem-protocol.svg
top_img: /img/covers/articles/ota-ymodem-protocol.svg
---

# Ymodem 协议解析与 Bicycle_Watch 实现

## 1. 为什么 Ymodem 适合嵌入式 OTA

Ymodem 是 Xmodem 协议族的一员，诞生于 1980 年代，至今仍是嵌入式领域最常用的文件传输协议：

| 协议 | 包大小 | 校验方式 | 传输效率 | 文件名支持 |
|------|--------|---------|---------|:---:|
| Xmodem | 128B | Checksum | 低 | ✗ |
| Xmodem-1K | 1024B | CRC16 | 中 | ✗ |
| **Ymodem** | **1024B** | **CRC16** | **高** | **✓** |
| Zmodem | 可变 | CRC32 | 最高 | ✓ |

Ymodem 在嵌入式中不可替代的原因：
- **实现简单**：发送方和接收方各约 400 行 C 代码
- **无依赖**：纯串口流，不依赖操作系统或文件系统
- **自带纠错**：ACK/NAK + 超时重传
- **支持文件名和大小**：首包传递文件元数据
- **SecureCRT/TeraTerm 原生支持**：开发阶段直接用终端发送

## 2. 数据包格式

### 2.1 包结构

```
Ymodem 数据包（1024 字节模式）：

┌──────┬──────┬──────┬──────────────┬──────┬──────┐
│ SOH  │ Pkt# │ ~Pkt#│   Data       │ CRC  │ CRC  │
│ 0x01 │ 1B   │ 1B   │ 1024 Bytes   │ Hi   │ Lo   │
└──────┴──────┴──────┴──────────────┴──────┴──────┘
   1      1      1        1024         1      1
                                      └─── 2B CRC16 ──┘

或 128 字节模式：
┌──────┬──────┬──────┬──────────────┬──────┬──────┐
│ STX  │ Pkt# │ ~Pkt#│   Data       │ CRC  │ CRC  │
│ 0x02 │ 1B   │ 1B   │ 128 Bytes    │ Hi   │ Lo   │
└──────┴──────┴──────┴──────────────┴──────┴──────┘

关键字段：
  Pkt#  = 包序列号（从 0x00 开始，0xFF 后回绕到 0x00）
  ~Pkt# = 包序列号的反码（用于快速校验）
  Data  = 128 或 1024 字节有效载荷（不足时用 0x1A 填充）
  CRC   = 16-bit CRC-CCITT（多项式 0x1021）
```

### 2.2 Bicycle_Watch 的常量定义

```c
// ymodem.h — 协议常量

// 控制字符
#define SOH   0x01  // 128 字节数据包起始
#define STX   0x02  // 1024 字节数据包起始
#define EOT   0x04  // 文件传输结束
#define ACK   0x06  // 正确接收确认
#define NAK   0x15  // 接收错误（请求重传）
#define CA    0x18  // 连续两个 CA = 取消传输
#define CRC16 0x43  // 'C'——请求 CRC16 校验模式

// 用户取消传输
#define ABORT1 0x41  // 'A'
#define ABORT2 0x61  // 'a'

// 包结构参数
#define PACKET_HEADER   3      // SOH/STX + Pkt# + ~Pkt#
#define PACKET_TRAILER  2      // CRC16 Hi + CRC16 Lo
#define PACKET_OVERHEAD (PACKET_HEADER + PACKET_TRAILER)  // = 5 字节
#define PACKET_SIZE     128    // 128 字节模式
#define PACKET_1K_SIZE  1024   // 1024 字节模式

// 文件元数据
#define FILE_NAME_LENGTH 256   // 文件名最大长度
#define FILE_SIZE_LENGTH 16    // 文件大小字符串最大长度

// 错误处理
#define MAX_ERRORS       3      // 最大连续错误次数（超过则放弃）
```

## 3. 传输流程

### 3.1 握手与文件传输时序

```
发送方（PC/SecureCRT）                   接收方（STM32, ota_task）

        │                                      │
        │         ◄══════ 'C' ════════════     │ ① 请求 CRC16 模式
        │                                      │
        │  ═══════ SOH 00 FF [文件名+大小] ═══►│ ② 首包：文件信息
        │  ═══════ CRC16 ═══════════════════► │   "firmware.bin" + "464000"
        │                                      │
        │         ◄══════ ACK ═════════════    │ ③ 确认首包
        │         ◄══════ 'C' ═════════════    │   请求下一包
        │                                      │
        │  ═══════ STX 01 FE [1024B Data] ══► │ ④ 数据包 #1
        │  ═══════ CRC16 ═══════════════════► │
        │                                      │
        │         ◄══════ ACK ═════════════    │ ⑤ 确认
        │                                      │
        │  ... 重复 N 个数据包 ...               │
        │                                      │
        │  ═══════ STX 12 ED [1024B Data] ══► │ ⑥ 数据包 #0x12
        │  ═══════ CRC16 ═══════════════════► │
        │                                      │
        │         ◄══════ ACK ═════════════    │
        │                                      │
        │  ═══════ EOT ═════════════════════► │ ⑦ 文件传输结束
        │                                      │
        │         ◄══════ NAK ═════════════    │ ⑧ NAK 确认 EOT
        │                                      │
        │  ═══════ EOT ═════════════════════► │ ⑨ 二次 EOT
        │                                      │
        │         ◄══════ ACK ═════════════    │ ⑩ 最终确认
        │         ◄══════ 'C' ═════════════    │
        │                                      │
        │  ═══════ SOH 00 FF [全0x00] ══════► │ ⑪ 空首包（表示无更多文件）
        │  ═══════ CRC16 ═══════════════════► │
        │                                      │
        │         ◄══════ ACK ═════════════    │ ⑫ 会话结束
```

### 3.2 首包格式（文件元数据）

```
首包包含文件名和文件大小，格式为以 '\0' 分隔的字符串：

SOH 00 FF [文件名\0文件大小字符串\0...填充0x00...] CRC16 CRC16

示例（firmware.bin, 464KB = 475136 字节）：

Byte 0:     0x01 (SOH)
Byte 1:     0x00 (Pkt# = 0)
Byte 2:     0xFF (~Pkt#)
Byte 3-15:  "firmware.bin\0"    (文件名)
Byte 16-23: "475136\0"          (文件大小字符串)
Byte 24-130: 0x00               (填充到 128 字节)
Byte 131-132: CRC16 值
```

### 3.3 序列号回绕

```c
// Ymodem 使用单字节序列号，范围 0x00~0xFF
// Bicycle_Watch 的 Ymodem_Receive 中：
//   packets_received 从 0 开始，每次正确接收后 +1
//   首包(packets_received==0) → 接收文件名和大小 → 发 ACK + CRC16
//   数据包(packets_received>=1) → 释放数据到 Download Task → 发 ACK

// 序列号校验：
if ((packet_data[PACKET_SEQNO_INDEX] & 0xff) !=
    (packets_received & 0xff)) {
    Send_Byte(NAK);  // 序列号不匹配 → 请求重传
}
```

## 4. CRC16 校验实现

### 4.1 算法原理

```c
// CRC-16-CCITT（多项式: 0x1021 = x¹⁶ + x¹² + x⁵ + 1）
// Ymodem 按位计算法（计算量小，适合 MCU）

uint16_t UpdateCRC16(uint16_t crcIn, uint8_t byte)
{
    uint32_t crc = crcIn;
    uint32_t in = byte | 0x100;  // 在 bit 8 附加一个虚拟的 1

    do {
        crc <<= 1;
        in <<= 1;
        if (in & 0x100) ++crc;   // 当前数据位为 1 → CRC 加 1
        if (crc & 0x10000)        // CRC 第 16 位溢出
            crc ^= 0x1021;        // XOR 多项式
    } while (!(in & 0x10000));   // 直到虚拟位也移出（循环 8 次）

    return crc & 0xFFFF;
}

// 对完整数据块计算 CRC16
uint16_t Cal_CRC16(const uint8_t* data, uint32_t size)
{
    uint32_t crc = 0;
    const uint8_t* dataEnd = data + size;
    while (data < dataEnd)
        crc = UpdateCRC16(crc, *data++);

    // ★ 尾部的两个零字节是 CRC-16-CCITT 的标准要求
    crc = UpdateCRC16(crc, 0);
    crc = UpdateCRC16(crc, 0);
    return crc & 0xFFFF;
}
```

### 4.2 Checksum 备选（兼容旧版 Xmodem）

```c
// 简单的字节累加和——用于兼容不支持 CRC16 的旧版终端
uint8_t CalChecksum(const uint8_t* data, uint32_t size)
{
    uint32_t sum = 0;
    const uint8_t* dataEnd = data + size;
    while (data < dataEnd)
        sum += *data++;
    return sum & 0xFF;  // 取低 8 位
}
```

## 5. 接收端核心实现

### 5.1 逐字节接收（DMA + IDLE 中断）

```c
// USART1 DMA + IDLE 中断接收——比逐字节中断省 CPU，比轮询更实时

static int32_t Receive_Byte(uint8_t *c, uint16_t length, uint32_t timeout)
{
    // 启动 DMA 接收 length 个字节（或 IDLE 中断提前结束）
    core_usart_receive_to_idle_dma(CORE_USART1, c, length);

    // 等待 DMA 完成中断或 IDLE 中断
    // → USART ISR 在收到完整数据后将长度放入 YmodemRec_Queue
    if (osal_queue_receive(
            st_userqueuecfg[YmodemRec_Queue].queue_handle,
            &s_u16_YmodRecLength, timeout) == OSAL_SUCCESS) {
        return 0;  // 收到数据
    }
    return -1;  // 超时
}

// 为什么使用 IDLE 中断（而非固定字节数接收）？
//  Ymodem 包的长度可变：首包 128B，数据包 128B 或 1024B
//  但 UART 上无法预知发送方使用 128 还是 1024 模式
//  IDLE 中断的优势：
//    发送完一帧后，UART 线上出现空闲（≥1 个字符时间无数据）→ 触发 IDLE 中断
//    → 此时 DMA 已经自动接收了所有数据
//    → 从 DMA 的剩余计数器可以算出实际接收了多少字节
// 这样就不需要预知包大小，实际收到的就是完整的一包
```

### 5.2 包接收状态机

```c
// Receive_Packet — 接收并校验一个完整的数据包

static int32_t Receive_Packet(uint8_t *data, int32_t *length,
                               uint32_t timeout)
{
    uint16_t packet_size;
    *length = 0;

    // ① 接收第一个字节 → 判断包类型
    if (Receive_Byte(data, 1030, timeout) != 0) {
        return -1;  // 超时
    }

    switch (*data) {
    case SOH:  packet_size = PACKET_SIZE;      break;  // 128B
    case STX:  packet_size = PACKET_1K_SIZE;   break;  // 1024B
    case EOT:  return 0;                               // 传输结束
    case CA:
        // 连续两个 CA → 发送方取消传输
        if ((Receive_Byte(data, 1, timeout) == 0) && (*data == CA)) {
            *length = -1;
            return 0;
        }
        return -1;
    case ABORT1:
    case ABORT2:
        return 1;  // 用户取消
    default:
        return -1; // 未知字符
    }

    // ② 序列号校验：Pkt# 和 ~Pkt# 应互为反码
    if (data[PACKET_SEQNO_INDEX] !=
        ((data[PACKET_SEQNO_COMP_INDEX] ^ 0xff) & 0xff)) {
        return -1;  // 序列号损坏 → 返回错误，上层重传
    }

    // ③ 长度校验：IDLE 中断收到的长度应该和包类型匹配
    if (s_u16_YmodRecLength != (packet_size + PACKET_OVERHEAD)) {
        return -1;
    }

    *length = packet_size;
    return 0;  // 包接收成功（CRC 校验在上层 Ymodem_Receive 中处理）
}
```

### 5.3 双缓冲接收主循环

```c
// Ymodem_Receive — 接收完整文件的顶层函数
// buf1 和 buf2 是 1030 字节的交替缓冲区（ping-pong）

int32_t Ymodem_Receive(uint8_t *buf1, uint8_t *buf2)
{
    uint8_t *packet_data = buf1;  // 当前写入缓冲区
    int32_t packet_length, session_done, file_done;
    int32_t packets_received, errors, session_begin, size = 0;

    // 外层循环 → 处理多个文件（Ymodem 支持批量传输）
    for (session_done = 0, errors = 0, session_begin = 0; ;) {
        // 内层循环 → 处理当前文件的每个包
        for (packets_received = 0, file_done = 0; ;) {
            switch (Receive_Packet(packet_data, &packet_length, 2000)) {

            case 0:  // 成功收到一个包
                errors = 0;  // 重置错误计数
                switch (packet_length) {

                case -1:  // 发送方取消
                    Send_Byte(ACK);
                    return 0;

                case 0:   // EOT — 当前文件传输结束
                    Send_Byte(ACK);
                    file_done = 1;
                    break;

                default:  // 正常数据包
                    // 序列号校验
                    if ((packet_data[PACKET_SEQNO_INDEX] & 0xff) !=
                        (packets_received & 0xff)) {
                        Send_Byte(NAK);
                    } else {
                        if (packets_received == 0) {
                            // ★ 首包 → 解析文件元数据
                            if (packet_data[PACKET_HEADER] != 0) {
                                // 提取文件名和大小
                                parse_file_info(packet_data);
                                // 通知 Download Task 文件总大小
                                osal_queue_send(
                                    st_userqueuecfg[AppDataBuffer_Queue]
                                        .queue_handle,
                                    &size, 0);
                                // 切换到另一个缓冲区
                                packet_data = (packet_data == buf1)
                                              ? buf2 : buf1;
                                Send_Byte(ACK);
                                Send_Byte(CRC16);
                            } else {
                                // 空首包 → 没有更多文件了
                                Send_Byte(ACK);
                                file_done = 1;
                                session_done = 1;
                            }
                        } else {
                            // ★ 数据包 → 交给 Download Task 处理
                            packet_data += PACKET_HEADER;
                            g_u32_datalength = packet_length;
                            osal_queue_send(
                                st_userqueuecfg[AppDataBuffer_Queue]
                                    .queue_handle,
                                &packet_data, OSAL_MAX_DELAY);
                            packet_data -= PACKET_HEADER;

                            // ★ 等待 Download Task 写入 W25Q64 完成
                            osal_mutex_take(Semaphore_ExtFlashState,
                                            OSAL_MAX_DELAY);
                            osal_mutex_give(Semaphore_ExtFlashState);

                            // 切换到另一个缓冲区
                            packet_data = (packet_data == buf1)
                                          ? buf2 : buf1;
                            Send_Byte(ACK);
                        }
                        packets_received++;
                        session_begin = 1;  // 标记会话已开始
                    }
                }
                break;

            case 1:  // 发送方取消传输
                Send_Byte(CA);
                Send_Byte(CA);
                return -3;

            default: // 接收超时或包校验失败
                if (session_begin > 0) errors++;
                if (errors > MAX_ERRORS) {
                    // ★ 连续错误超过 3 次 → 放弃
                    Send_Byte(CA);
                    Send_Byte(CA);
                    return 0;
                }
                Send_Byte(CRC16);  // 请求 CRC16 模式重新开始
                break;
            }

            if (file_done != 0) break;  // 当前文件接收完成
        }
        if (session_done != 0) break;  // 整个会话完成
    }
    return (int32_t)size;  // 返回文件大小
}
```

### 5.4 文件元数据解析

```c
// 从首包的 128 字节数据中提取文件名和大小

uint8_t file_name[FILE_NAME_LENGTH];     // 256 B
uint8_t file_size[FILE_SIZE_LENGTH];     // 16 B

// 解析逻辑（在收到 packets_received == 0 的首包时调用）
file_ptr = packet_data + PACKET_HEADER;

// 提取文件名（以 '\0' 结尾）
for (i = 0; (*file_ptr != 0) && (i < FILE_NAME_LENGTH);) {
    file_name[i++] = *file_ptr++;
}
file_name[i++] = '\0';

// 提取文件大小（文件名 '\0' 之后，以空格或 '\0' 结尾）
for (i = 0, file_ptr++; (*file_ptr != ' ') && (i < FILE_SIZE_LENGTH);) {
    file_size[i++] = *file_ptr++;
}
file_size[i++] = '\0';

// 将 ASCII 字符串转换为整数
Str2Int(file_size, &size);
// 例如 "475136" → 475136

// 结果：
//   file_name = "firmware.bin"
//   size = 475136 字节 (≈ 464KB)
```

## 6. CRC16 校验流程

```c
// 注意！Bicycle_Watch 的接收端实现了一个有趣的设计：
// 发送方在每秒包的末尾附带 CRC16，但这些 CRC 字节也通过 DMA 一并接收了
// 所以数据缓冲区中包含 CRC16 尾随字节
// → Ymodem_Receive 不在接收端做 CRC16 重算（因为数据已经经过了 UART 硬件校验）
// → 只需要 IDLE 中断的长度校验 + 序列号反码校验

// 但发送端 Ymodem_Transmit 中仍然实现了完整的 CRC16 计算和发送：
// 发送方在每个包数据后手动计算 CRC16 并发送两个字节
// 接收方可以用 Cal_CRC16(data, length) 手动验算（如果需要最高安全性）
```

## 7. 传输中的错误处理

| 错误场景 | 检测方式 | 恢复策略 |
|---------|---------|---------|
| 字节丢失/损坏 | 序列号不匹配 (Pkt# ≠ ~Pkt#^0xFF) | 发送 NAK → 发送方重传上一个包 |
| 整包丢失 | 超时 (2s 内未收到完整包) | 发送 CRC16('C') → 发送方重传 |
| 长度不匹配 | IDLE 中断长度 ≠ packet_size + overhead | 丢弃本包 → 返回 -1 → 触发 NAK |
| 连续 3 次错误 | errors > MAX_ERRORS | 发送 CA CA → 取消传输 |
| 用户取消 | 收到 ABORT1/ABORT2 | 发送 ACK → 返回 0 |
| 发送方取消 | 收到 CA CA | 返回 -3 → 上层重新进入 WaitReqDownload |

## 8. 发送端实现要点

Bicycle_Watch 同时实现了 Ymodem 发送功能（`Ymodem_Transmit`），用于设备端向上位机发送数据（如导出骑行记录）：

```c
// Ymodem_Transmit 的关键差异点：

// ① 使用包大小自适应：剩余数据 > 1024 → 用 1K 包，否则用 128B 包
uint8_t Ymodem_Transmit(uint8_t *buf, const uint8_t* sendFileName,
                         uint32_t sizeFile)
{
    // ...
    while (size) {
        Ymodem_PreparePacket(buf_ptr, &packet_data[0], blkNumber, size);

        if (size >= PACKET_1K_SIZE) {
            pktSize = PACKET_1K_SIZE;
        } else {
            pktSize = PACKET_SIZE;
        }

        // 发送包 + CRC16
        Ymodem_SendPacket(packet_data, pktSize + PACKET_HEADER);
        tempCRC = Cal_CRC16(&packet_data[3], pktSize);
        Send_Byte(tempCRC >> 8);
        Send_Byte(tempCRC & 0xFF);

        // 等待 ACK
        if (Receive_Byte(&receivedC[0], 1, 100000) == 0) {
            if (receivedC[0] == ACK) {
                ackReceived = 1;
                // 移动指针，继续下一包
            }
        }
    }
    // 发送 EOT、空首包 ...
}
```

## 9. Bicycle_Watch 与 SecureCRT 的 Ymodem 对接

在开发调试阶段，使用 SecureCRT 的 Ymodem 发送功能测试 OTA：

```
操作步骤：
1. Bicycle_Watch 上电 → 等待 LVGL 显示"等待升级"
2. SecureCRT 连接 USART1 @ 115200-8-N-1
3. SecureCRT → Transfer → Send Ymodem → 选择 firmware.bin
4. SecureCRT 自动发送 'C' 握手 → STM32 响应 → 开始传输
5. LVGL 屏幕实时显示百分比进度
6. 传输完成 → LVGL 弹窗"固件下载完成，是否立即升级？"
7. 用户点击"立即升级" → 写 App Info → 软件复位
8. Boot Manager 校验新固件 → 拷贝到运行区 → 跳转执行
```

## 下一步

下一篇将深入 **外部 Flash 策略与 W25Q64 数据缓冲**：4096 字节扇区缓冲、双缓冲 ping-pong 写入、互斥锁保护的线程安全访问、以及 OTA 区与其他分区的隔离机制。
