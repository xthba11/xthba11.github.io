---
title: 嵌入式 C 第三篇：结构体、联合体与协议解析
date: 2024-04-26 10:30:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - 结构体
  - 联合体
  - 协议解析
description: 用结构体组织数据，用联合体理解内存复用，并结合串口协议讲清楚解析时的对齐、大小端和安全边界。
cover: /img/covers/articles/embedded-c-struct-union-protocol.svg
top_img: /img/covers/articles/embedded-c-struct-union-protocol.svg
---

结构体和联合体是嵌入式 C 里非常重要的工具。结构体用来组织一组相关数据，联合体用来让多个成员共享同一块内存。

它们常出现在：

- 传感器数据结构。
- 串口/CAN 协议帧。
- 寄存器位定义。
- 状态机上下文。
- 文件系统或 Flash 记录结构。

## 结构体：把相关数据放在一起

```c
#include <stdint.h>

typedef struct {
    int16_t temperature_x10; // 温度，放大 10 倍，例如 253 表示 25.3℃
    uint16_t humidity_x10;   // 湿度，放大 10 倍
    uint8_t valid;           // 数据是否有效
} SensorData;
```

比起散落的全局变量：

```c
int16_t g_temp;
uint16_t g_humi;
uint8_t g_valid;
```

结构体的边界更清晰。函数接口也更干净：

```c
int sensor_read(SensorData *out)
{
    if (out == NULL) {
        return -1;
    }

    out->temperature_x10 = 253;
    out->humidity_x10 = 601;
    out->valid = 1;
    return 0;
}
```

## 结构体对齐

结构体大小不一定等于成员大小相加。

```c
#include <stdio.h>
#include <stdint.h>

typedef struct {
    uint8_t a;
    uint32_t b;
    uint8_t c;
} Demo;

int main(void)
{
    printf("sizeof(Demo) = %zu\n", sizeof(Demo));
    return 0;
}
```

由于对齐，`sizeof(Demo)` 可能是 12，而不是 6。

为什么要对齐？因为很多 CPU 访问对齐地址更快，有些架构访问未对齐地址甚至会异常。

## 协议解析不要直接强转结构体

假设串口收到这帧：

```text
AA 01 02 34 12
```

含义：

- `0xAA`：帧头。
- `0x01`：命令。
- `0x02`：数据长度。
- `0x1234`：小端 16 位数据。

不要直接这样做：

```c
typedef struct {
    uint8_t header;
    uint8_t cmd;
    uint8_t len;
    uint16_t value;
} Frame;

Frame *f = (Frame *)buf; // 不推荐
```

原因：

- 结构体可能有 padding。
- 缓冲区可能未对齐。
- 大小端可能不一致。
- 收到的数据长度可能不足。

更稳的写法是逐字节解析：

```c
#include <stdint.h>
#include <stddef.h>

static uint16_t read_u16_le(const uint8_t *p)
{
    // 小端：低字节在前，高字节在后
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

int parse_frame(const uint8_t *buf, size_t len)
{
    uint8_t cmd;
    uint8_t data_len;
    uint16_t value;

    if (buf == NULL) {
        return -1;
    }

    if (len < 5) {
        return -2;
    }

    if (buf[0] != 0xAA) {
        return -3;
    }

    cmd = buf[1];
    data_len = buf[2];

    if (data_len != 2) {
        return -4;
    }

    value = read_u16_le(&buf[3]);

    // 根据 cmd 和 value 做业务处理
    (void)cmd;
    (void)value;
    return 0;
}
```

这才是协议解析的工程写法。

## 联合体：同一块内存的不同视角

```c
#include <stdint.h>
#include <stdio.h>

typedef union {
    uint32_t word;
    uint8_t bytes[4];
} WordBytes;

int main(void)
{
    WordBytes v;
    v.word = 0x11223344;

    printf("%02X %02X %02X %02X\n",
           v.bytes[0], v.bytes[1], v.bytes[2], v.bytes[3]);

    return 0;
}
```

联合体所有成员共享同一块内存。它适合观察底层布局，但写跨平台协议时仍建议显式移位，不要依赖联合体大小端。

## 位域要谨慎

```c
typedef struct {
    uint8_t enable : 1;
    uint8_t mode   : 2;
    uint8_t error  : 1;
} StatusBits;
```

位域看起来适合寄存器，但它有风险：

- 位顺序和编译器实现有关。
- 对齐和大小可能不直观。
- 跨平台协议不建议使用位域直接映射。

工程里更推荐用 mask：

```c
#define STATUS_ENABLE_MASK (1U << 0)
#define STATUS_MODE_MASK   (3U << 1)
#define STATUS_ERROR_MASK  (1U << 3)
```

## 完整协议结构建议

```c
#include <stdint.h>
#include <stddef.h>

#define FRAME_MAX_PAYLOAD 32

typedef struct {
    uint8_t cmd;
    uint8_t payload[FRAME_MAX_PAYLOAD];
    uint8_t payload_len;
} ProtocolFrame;

int protocol_parse(const uint8_t *buf, size_t len, ProtocolFrame *out)
{
    if (buf == NULL || out == NULL) {
        return -1;
    }

    if (len < 4) {
        return -2;
    }

    if (buf[0] != 0xAA) {
        return -3;
    }

    out->cmd = buf[1];
    out->payload_len = buf[2];

    if (out->payload_len > FRAME_MAX_PAYLOAD) {
        return -4;
    }

    if ((size_t)out->payload_len + 4U > len) {
        return -5;
    }

    for (uint8_t i = 0; i < out->payload_len; i++) {
        out->payload[i] = buf[3 + i];
    }

    // 最后一个字节假设是简单校验和
    uint8_t checksum = buf[3 + out->payload_len];
    (void)checksum;

    return 0;
}
```

## 常见坑

- 用结构体强转网络/串口数据。
- 忘记结构体 padding。
- 大小端不明确。
- payload 长度没有检查。
- 位域用于跨平台协议。

## 验证方法

```bash
gcc -Wall -Wextra -g struct_union_protocol.c -o struct_union_protocol
./struct_union_protocol
```

建议把异常帧也测一遍：

- 长度不足。
- 帧头错误。
- payload 超过最大值。
- 校验失败。

## 复盘

结构体适合表达“业务数据”，联合体适合理解“内存复用”。但协议解析最稳的方式仍然是逐字节读取、显式处理大小端、显式检查长度。

嵌入式里不要贪图一行强转省事，协议解析越靠近底层，越要保守。
