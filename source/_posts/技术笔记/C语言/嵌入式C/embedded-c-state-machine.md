---
title: 嵌入式 C 第五篇：状态机，按键、协议、任务流程怎么写
date: 2026-07-17 10:50:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - 状态机
  - 按键
  - 协议解析
description: 用按键消抖和串口协议解析讲清楚状态机设计方法，避免业务逻辑散落在大量 if else 中。
cover: /img/covers/articles/embedded-c-state-machine.svg
top_img: /img/covers/articles/embedded-c-state-machine.svg
---

嵌入式程序里很多逻辑都不是“一次函数调用完成”，而是随着时间和事件逐步推进。比如按键消抖、长按检测、串口协议解析、OTA 流程、设备初始化流程。

这种场景最适合用状态机。

## 状态机是什么

状态机包含三件事：

- 当前状态。
- 输入事件。
- 根据状态和事件切换到下一个状态。

```text
IDLE --按下--> DEBOUNCE --稳定--> PRESSED --松开--> RELEASED
```

状态机的价值是让流程显式化，不让逻辑散落在很多 `if else` 里。

## 按键状态机

按键问题：

- 机械按键会抖动。
- 需要区分短按和长按。
- 不能在中断里 `delay`。

状态定义：

```c
typedef enum {
    KEY_STATE_IDLE = 0,
    KEY_STATE_DEBOUNCE_PRESS,
    KEY_STATE_PRESSED,
    KEY_STATE_DEBOUNCE_RELEASE,
} KeyState;
```

上下文：

```c
#include <stdint.h>

typedef struct {
    KeyState state;
    uint32_t state_tick;
    uint8_t last_level;
    uint8_t long_reported;
} KeyContext;
```

状态机实现：

```c
#include <stdint.h>
#include <stdio.h>

#define KEY_ACTIVE_LEVEL 0
#define DEBOUNCE_MS 20
#define LONG_PRESS_MS 1000

uint32_t get_tick_ms(void);
uint8_t read_key_level(void);

void key_init(KeyContext *ctx)
{
    ctx->state = KEY_STATE_IDLE;
    ctx->state_tick = get_tick_ms();
    ctx->last_level = 1;
    ctx->long_reported = 0;
}

void key_poll(KeyContext *ctx)
{
    uint32_t now = get_tick_ms();
    uint8_t level = read_key_level();

    switch (ctx->state) {
    case KEY_STATE_IDLE:
        if (level == KEY_ACTIVE_LEVEL) {
            ctx->state = KEY_STATE_DEBOUNCE_PRESS;
            ctx->state_tick = now;
        }
        break;

    case KEY_STATE_DEBOUNCE_PRESS:
        if (level != KEY_ACTIVE_LEVEL) {
            ctx->state = KEY_STATE_IDLE;
        } else if (now - ctx->state_tick >= DEBOUNCE_MS) {
            ctx->state = KEY_STATE_PRESSED;
            ctx->state_tick = now;
            ctx->long_reported = 0;
            printf("key pressed\n");
        }
        break;

    case KEY_STATE_PRESSED:
        if (level != KEY_ACTIVE_LEVEL) {
            ctx->state = KEY_STATE_DEBOUNCE_RELEASE;
            ctx->state_tick = now;
        } else if (!ctx->long_reported && now - ctx->state_tick >= LONG_PRESS_MS) {
            ctx->long_reported = 1;
            printf("key long press\n");
        }
        break;

    case KEY_STATE_DEBOUNCE_RELEASE:
        if (level == KEY_ACTIVE_LEVEL) {
            ctx->state = KEY_STATE_PRESSED;
        } else if (now - ctx->state_tick >= DEBOUNCE_MS) {
            ctx->state = KEY_STATE_IDLE;
            printf("key released\n");
        }
        break;

    default:
        ctx->state = KEY_STATE_IDLE;
        break;
    }
}
```

这个状态机没有阻塞延时，适合放在主循环或 RTOS 任务里周期调用。

## 协议解析状态机

协议格式：

```text
0xAA LEN CMD PAYLOAD CHECKSUM
```

状态：

```c
typedef enum {
    PARSE_WAIT_HEADER = 0,
    PARSE_WAIT_LEN,
    PARSE_WAIT_CMD,
    PARSE_WAIT_PAYLOAD,
    PARSE_WAIT_CHECKSUM,
} ParseState;
```

上下文：

```c
#include <stdint.h>
#include <stddef.h>

#define PAYLOAD_MAX 32

typedef struct {
    ParseState state;
    uint8_t len;
    uint8_t cmd;
    uint8_t payload[PAYLOAD_MAX];
    uint8_t index;
    uint8_t checksum;
} Parser;
```

输入一个字节：

```c
int parser_input(Parser *p, uint8_t byte)
{
    if (p == NULL) {
        return -1;
    }

    switch (p->state) {
    case PARSE_WAIT_HEADER:
        if (byte == 0xAA) {
            p->checksum = byte;
            p->state = PARSE_WAIT_LEN;
        }
        break;

    case PARSE_WAIT_LEN:
        if (byte > PAYLOAD_MAX) {
            p->state = PARSE_WAIT_HEADER;
            return -2;
        }
        p->len = byte;
        p->index = 0;
        p->checksum ^= byte;
        p->state = PARSE_WAIT_CMD;
        break;

    case PARSE_WAIT_CMD:
        p->cmd = byte;
        p->checksum ^= byte;
        p->state = (p->len == 0) ? PARSE_WAIT_CHECKSUM : PARSE_WAIT_PAYLOAD;
        break;

    case PARSE_WAIT_PAYLOAD:
        p->payload[p->index++] = byte;
        p->checksum ^= byte;
        if (p->index >= p->len) {
            p->state = PARSE_WAIT_CHECKSUM;
        }
        break;

    case PARSE_WAIT_CHECKSUM:
        if (p->checksum == byte) {
            p->state = PARSE_WAIT_HEADER;
            return 1; // 一帧完成
        }
        p->state = PARSE_WAIT_HEADER;
        return -3;

    default:
        p->state = PARSE_WAIT_HEADER;
        break;
    }

    return 0; // 继续等待
}
```

串口任务里这样接入：

```c
void uart_process_byte(uint8_t byte)
{
    int ret = parser_input(&g_parser, byte);
    if (ret == 1) {
        // 收到完整帧，处理命令
        handle_frame(g_parser.cmd, g_parser.payload, g_parser.len);
    }
}
```

## 任务流程状态机

设备启动流程也可以用状态机：

```text
POWER_ON -> INIT_SENSOR -> MOUNT_FS -> START_UI -> RUNNING -> ERROR
```

这样比在一个函数里连续阻塞初始化更容易处理失败重试。

## 常见坑

- 状态太少，导致一个状态里塞太多逻辑。
- 状态太多，命名混乱。
- 状态切换没有日志。
- 错误状态没有恢复路径。
- 在状态机里阻塞等待，导致系统卡住。

## 验证方法

测试状态机时，不要只测正常路径。建议构造：

- 按键抖动。
- 协议半包。
- 错误帧头。
- payload 长度超限。
- 校验失败。
- 状态超时。

## 复盘

状态机适合处理“事情分阶段完成”的逻辑。写状态机时先画图，再写枚举，再写 switch。

一旦你能把状态、事件、动作、转移条件写清楚，按键、协议、OTA、任务流程都会比一堆 `if else` 稳定很多。
