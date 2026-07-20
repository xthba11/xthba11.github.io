---
title: 嵌入式 C 第九篇：回调函数和函数指针表
date: 2024-06-02 11:30:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - 回调
  - 函数指针
  - 驱动接口
description: 结合按键事件、协议命令分发和设备操作表，讲清楚回调函数与函数指针表在嵌入式工程里的实际用法。
cover: /img/covers/articles/embedded-c-callback-function-table.svg
top_img: /img/covers/articles/embedded-c-callback-function-table.svg
---

回调函数和函数指针表是嵌入式 C 模块解耦的重要手段。它们能让底层模块不直接依赖上层业务，同时让命令分发和驱动接口更清晰。

## 回调函数

底层按键驱动检测到按键事件，但它不应该知道上层要切页面、开灯还是发消息。它只负责通知。

```c
#include <stdint.h>

typedef enum {
    KEY_EVENT_PRESS = 0,
    KEY_EVENT_RELEASE,
    KEY_EVENT_LONG_PRESS,
} KeyEvent;

typedef void (*key_callback_t)(KeyEvent event, void *user_data);

typedef struct {
    key_callback_t cb;
    void *user_data;
} KeyDriver;

void key_register_callback(KeyDriver *drv, key_callback_t cb, void *user_data)
{
    if (drv == NULL) {
        return;
    }

    drv->cb = cb;
    drv->user_data = user_data;
}

void key_emit_event(KeyDriver *drv, KeyEvent event)
{
    if (drv == NULL || drv->cb == NULL) {
        return;
    }

    // 底层只通知事件，不关心上层怎么处理
    drv->cb(event, drv->user_data);
}
```

上层注册：

```c
#include <stdio.h>

void app_key_handler(KeyEvent event, void *user_data)
{
    const char *name = user_data;
    printf("[%s] key event=%d\n", name, event);
}

void app_init(void)
{
    static KeyDriver key;

    key_register_callback(&key, app_key_handler, "main_page");
}
```

`user_data` 用来传上下文，避免回调依赖全局变量。

## 命令函数表

协议命令多时，函数指针表比大 switch 更清晰。

```c
#include <stdint.h>
#include <stddef.h>

typedef int (*cmd_handler_t)(const uint8_t *payload, size_t len);

typedef struct {
    uint8_t cmd;
    cmd_handler_t handler;
} CmdEntry;

int cmd_get_version(const uint8_t *payload, size_t len)
{
    (void)payload;
    (void)len;
    return 0;
}

int cmd_set_led(const uint8_t *payload, size_t len)
{
    if (payload == NULL || len < 1) {
        return -1;
    }

    // payload[0] 表示 LED 开关
    return 0;
}

static const CmdEntry g_cmd_table[] = {
    {0x01, cmd_get_version},
    {0x02, cmd_set_led},
};

int cmd_dispatch(uint8_t cmd, const uint8_t *payload, size_t len)
{
    size_t count = sizeof(g_cmd_table) / sizeof(g_cmd_table[0]);

    for (size_t i = 0; i < count; i++) {
        if (g_cmd_table[i].cmd == cmd) {
            return g_cmd_table[i].handler(payload, len);
        }
    }

    return -1;
}
```

新增命令时，只需要新增函数和表项。

## 设备操作表

类似 Linux 驱动里的 `file_operations`，嵌入式里也可以定义设备操作表：

```c
typedef struct {
    int (*init)(void);
    int (*read)(uint8_t *buf, size_t len);
    int (*write)(const uint8_t *buf, size_t len);
    int (*deinit)(void);
} DeviceOps;
```

UART 实现：

```c
int uart_init(void) { return 0; }
int uart_read(uint8_t *buf, size_t len)
{
    (void)buf;
    return (int)len;
}
int uart_write(const uint8_t *buf, size_t len)
{
    (void)buf;
    return (int)len;
}
int uart_deinit(void) { return 0; }

static const DeviceOps g_uart_ops = {
    .init = uart_init,
    .read = uart_read,
    .write = uart_write,
    .deinit = uart_deinit,
};
```

上层统一调用：

```c
int device_test(const DeviceOps *ops)
{
    uint8_t buf[16] = {0};

    if (ops == NULL) {
        return -1;
    }

    if (ops->init) {
        ops->init();
    }

    if (ops->read) {
        ops->read(buf, sizeof(buf));
    }

    if (ops->deinit) {
        ops->deinit();
    }

    return 0;
}
```

## 使用注意

- 回调可能在中断里执行，不要做阻塞操作。
- 回调的 `user_data` 生命周期必须足够长。
- 函数指针调用前要判空。
- 函数签名必须完全匹配。
- 表项建议 `static const`，减少误修改。

## 验证方法

```bash
gcc -Wall -Wextra -g callback_table.c -o callback_table
./callback_table
```

建议测试：

- 未注册回调。
- 注册回调后触发事件。
- 未知命令。
- handler 参数为空。
- DeviceOps 某些函数为空。

## 复盘

回调解决“底层通知上层”，函数表解决“根据编号选择函数”，操作表解决“统一设备接口”。

这三种写法掌握后，你再看 LVGL 事件、FreeRTOS hook、Linux file_operations、嵌入式驱动抽象，都会顺很多。
