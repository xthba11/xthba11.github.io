---
title: 嵌入式 C 第六篇：模块化工程，.h 和 .c 到底怎么拆
date: 2024-06-14 11:00:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - 模块化
  - 头文件
  - 工程架构
description: 从 LED 驱动模块开始，讲清楚头文件放接口、源文件放实现、static 隐藏细节和多文件工程的组织方式。
cover: /img/covers/articles/embedded-c-module-h-c.svg
top_img: /img/covers/articles/embedded-c-module-h-c.svg
---

很多嵌入式项目一开始所有代码都写在 `main.c`，点灯、串口、传感器、协议解析混在一起。项目小的时候能跑，功能一多就很难维护。

模块化的目标不是“文件变多”，而是让每个文件有清晰职责。

## 基本原则

- `.h` 放对外接口、类型定义、必要宏。
- `.c` 放具体实现、私有变量、私有函数。
- 能 `static` 的函数和变量尽量 `static`。
- 头文件不要定义全局变量。
- 模块之间通过函数交互，不要互相改内部变量。

## LED 模块示例

目录：

```text
Drivers/
├── led.h
└── led.c
App/
└── app_main.c
```

`led.h`：

```c
#ifndef LED_H
#define LED_H

#include <stdint.h>

typedef enum {
    LED_ID_RUN = 0,
    LED_ID_ERROR,
    LED_ID_MAX,
} LedId;

void led_init(void);
void led_on(LedId id);
void led_off(LedId id);
void led_toggle(LedId id);

#endif
```

头文件只告诉别人“能调用什么”，不暴露内部怎么实现。

`led.c`：

```c
#include "led.h"

typedef struct {
    uint32_t port;
    uint32_t pin;
    uint8_t active_low;
} LedConfig;

// static 表示只在 led.c 内部可见
static const LedConfig g_led_config[LED_ID_MAX] = {
    [LED_ID_RUN] = {.port = 0, .pin = 13, .active_low = 1},
    [LED_ID_ERROR] = {.port = 1, .pin = 5, .active_low = 0},
};

static uint8_t g_led_state[LED_ID_MAX];

static void led_write_hw(const LedConfig *cfg, uint8_t on)
{
    // 真实工程中这里调用 HAL_GPIO_WritePin
    // active_low 表示低电平点亮
    uint8_t level = cfg->active_low ? !on : on;
    (void)level;
}

void led_init(void)
{
    for (int i = 0; i < LED_ID_MAX; i++) {
        g_led_state[i] = 0;
        led_write_hw(&g_led_config[i], 0);
    }
}

void led_on(LedId id)
{
    if (id >= LED_ID_MAX) {
        return;
    }

    g_led_state[id] = 1;
    led_write_hw(&g_led_config[id], 1);
}

void led_off(LedId id)
{
    if (id >= LED_ID_MAX) {
        return;
    }

    g_led_state[id] = 0;
    led_write_hw(&g_led_config[id], 0);
}

void led_toggle(LedId id)
{
    if (id >= LED_ID_MAX) {
        return;
    }

    if (g_led_state[id]) {
        led_off(id);
    } else {
        led_on(id);
    }
}
```

`app_main.c`：

```c
#include "led.h"

void app_main(void)
{
    led_init();
    led_on(LED_ID_RUN);
}
```

应用层只关心 `led_on()`，不关心端口、引脚、是否低电平点亮。

## 头文件保护

每个头文件都应该有 include guard：

```c
#ifndef MODULE_H
#define MODULE_H

// declarations

#endif
```

或者：

```c
#pragma once
```

传统嵌入式项目里 include guard 更通用。

## 不要在头文件定义变量

错误：

```c
// app.h
int g_count = 0;
```

多个 `.c` 包含后会重复定义。

正确：

```c
// app.h
extern int g_count;
```

```c
// app.c
int g_count = 0;
```

更推荐封装函数：

```c
void app_set_count(int count);
int app_get_count(void);
```

## 模块依赖方向

推荐分层：

```text
App -> Driver -> BSP -> HAL/Register
```

上层可以调用下层，下层不要反过来调用上层。如果下层需要通知上层，用回调或事件队列。

## 常见坑

- `.h` 里写变量定义。
- 所有函数都暴露，没用 `static`。
- 应用层直接操作 GPIO 细节。
- 模块之间互相包含头文件，形成循环依赖。
- 一个文件几千行，职责不清。

## 验证方法

PC 上可以先编译模块：

```bash
gcc -Wall -Wextra -c led.c
gcc -Wall -Wextra app_main.c led.c -o app
```

如果出现重复定义、隐式声明、类型不匹配，说明模块边界还不干净。

## 复盘

`.h/.c` 拆分的核心是边界：

- 头文件是契约。
- 源文件是实现。
- `static` 是隐藏细节。
- 函数接口是模块之间的门。

当你把 LED、UART、Sensor、Storage、Protocol 都按这个方式拆开，项目才会从“能跑”走向“能维护”。
