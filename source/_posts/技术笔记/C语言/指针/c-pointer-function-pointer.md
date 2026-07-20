---
title: C 语言指针第四篇：函数指针、回调和驱动接口
date: 2024-02-22 09:40:00
categories:
  - 技术笔记
  - C语言
  - 指针
tags:
  - C语言
  - 指针
  - 函数指针
  - 回调
  - 驱动开发
description: 从函数地址开始，讲清楚函数指针、回调函数、状态机分发表和嵌入式驱动接口设计。
cover: /img/covers/articles/c-pointer-function-pointer.svg
top_img: /img/covers/articles/c-pointer-function-pointer.svg
---

前面几篇文章讲的是“指向数据的指针”。这篇文章讲另一类指针：**指向函数的指针**。

函数指针看起来语法很怪，但它在 C 工程里非常常见：

- 中断回调。
- 协议命令分发。
- 状态机处理表。
- Linux 驱动里的 `file_operations`。
- 嵌入式 BSP/Driver 抽象接口。

函数指针的价值是：**把“要调用哪个函数”这件事变成数据，运行时可以选择。**

## 测试环境

- 主机系统：Ubuntu 22.04 LTS
- 编译器：GCC 11/12
- 编译命令：`gcc -Wall -Wextra -g function_pointer.c -o function_pointer`
- 适用场景：回调、状态机、驱动抽象、事件分发

## 问题背景

假设你在写一个通信协议，有不同命令：

```text
0x01: 读取版本
0x02: 设置 LED
0x03: 读取传感器
```

最直接写法是 `switch`：

```c
switch (cmd) {
case 0x01:
    handle_get_version();
    break;
case 0x02:
    handle_set_led();
    break;
case 0x03:
    handle_read_sensor();
    break;
}
```

命令少时没问题，但命令多了以后，`switch` 会越来越大。函数指针可以把命令和处理函数放到表里，让分发逻辑更清晰。

## 函数也有地址

先看最小例子：

```c
#include <stdio.h>

int add(int a, int b)
{
    return a + b;
}

int main(void)
{
    // 函数名 add 可以转换为函数地址
    printf("add address = %p\n", (void *)add);

    return 0;
}
```

严格来说，函数指针和 `void *` 不是完全同一种东西，但在很多平台上这样打印可以帮助理解。工程代码里不要依赖函数指针和数据指针可以随意互转。

## 定义函数指针

如果函数类型是：

```c
int add(int a, int b);
```

那么指向这种函数的指针写法是：

```c
int (*op)(int, int);
```

完整例子：

```c
#include <stdio.h>

int add(int a, int b)
{
    return a + b;
}

int sub(int a, int b)
{
    return a - b;
}

int main(void)
{
    // op 是一个函数指针，能指向“参数为两个 int，返回 int”的函数
    int (*op)(int, int) = NULL;

    op = add;
    printf("add result = %d\n", op(10, 3));

    op = sub;
    printf("sub result = %d\n", op(10, 3));

    return 0;
}
```

这行语法需要特别看：

```c
int (*op)(int, int);
```

如果写成：

```c
int *op(int, int);
```

那就不是函数指针，而是“声明一个函数，返回 `int *`”。括号非常重要。

## 用 typedef 简化

函数指针语法比较难读，工程里一般用 `typedef`。

```c
typedef int (*calc_func_t)(int a, int b);
```

使用：

```c
#include <stdio.h>

typedef int (*calc_func_t)(int a, int b);

int add(int a, int b)
{
    return a + b;
}

int run_calc(calc_func_t func, int a, int b)
{
    if (func == NULL) {
        return 0;
    }

    // 通过函数指针调用具体函数
    return func(a, b);
}

int main(void)
{
    printf("%d\n", run_calc(add, 1, 2));
    return 0;
}
```

`calc_func_t` 读起来比 `int (*)(int, int)` 友好多了。

## 回调函数

回调就是：你把一个函数交给别人，别人以后在合适的时候调用它。

示例：事件通知。

```c
#include <stdio.h>

typedef void (*event_cb_t)(int event_id, void *user_data);

typedef struct {
    event_cb_t cb;
    void *user_data;
} EventManager;

void event_manager_init(EventManager *mgr, event_cb_t cb, void *user_data)
{
    if (mgr == NULL) {
        return;
    }

    mgr->cb = cb;
    mgr->user_data = user_data;
}

void event_manager_emit(EventManager *mgr, int event_id)
{
    if (mgr == NULL || mgr->cb == NULL) {
        return;
    }

    // 事件发生时调用用户注册的回调
    mgr->cb(event_id, mgr->user_data);
}

void on_event(int event_id, void *user_data)
{
    const char *name = user_data;
    printf("[%s] event=%d\n", name, event_id);
}

int main(void)
{
    EventManager mgr;

    event_manager_init(&mgr, on_event, "app");
    event_manager_emit(&mgr, 100);

    return 0;
}
```

`user_data` 很重要。它让回调函数能拿到上下文，不必依赖全局变量。

## 命令分发表

回到协议命令处理：

```c
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>

typedef int (*cmd_handler_t)(const uint8_t *payload, size_t len);

typedef struct {
    uint8_t cmd;
    cmd_handler_t handler;
} CmdEntry;

int handle_get_version(const uint8_t *payload, size_t len)
{
    (void)payload;
    (void)len;
    printf("version: 1.0.0\n");
    return 0;
}

int handle_set_led(const uint8_t *payload, size_t len)
{
    if (payload == NULL || len < 1) {
        return -1;
    }

    printf("set led: %u\n", payload[0]);
    return 0;
}

static const CmdEntry g_cmd_table[] = {
    {0x01, handle_get_version},
    {0x02, handle_set_led},
};

int dispatch_cmd(uint8_t cmd, const uint8_t *payload, size_t len)
{
    size_t count = sizeof(g_cmd_table) / sizeof(g_cmd_table[0]);

    for (size_t i = 0; i < count; i++) {
        if (g_cmd_table[i].cmd == cmd) {
            // 找到命令后，调用对应处理函数
            return g_cmd_table[i].handler(payload, len);
        }
    }

    return -1;
}

int main(void)
{
    uint8_t led_payload[] = {1};

    dispatch_cmd(0x01, NULL, 0);
    dispatch_cmd(0x02, led_payload, sizeof(led_payload));

    return 0;
}
```

这种写法比巨大 `switch` 更容易扩展。新增命令时，只要加处理函数和表项。

## 状态机分发表

函数指针也适合状态机：

```c
#include <stdio.h>

typedef enum {
    STATE_IDLE = 0,
    STATE_RUNNING,
    STATE_ERROR,
    STATE_MAX,
} state_t;

typedef void (*state_handler_t)(void);

void handle_idle(void)
{
    printf("idle\n");
}

void handle_running(void)
{
    printf("running\n");
}

void handle_error(void)
{
    printf("error\n");
}

static state_handler_t g_state_handlers[STATE_MAX] = {
    [STATE_IDLE] = handle_idle,
    [STATE_RUNNING] = handle_running,
    [STATE_ERROR] = handle_error,
};

void run_state(state_t state)
{
    if (state >= STATE_MAX || g_state_handlers[state] == NULL) {
        return;
    }

    // 根据状态选择对应函数
    g_state_handlers[state]();
}
```

这种写法在嵌入式任务状态机里很常见。

## 驱动接口表

Linux 字符设备驱动里的 `file_operations` 本质上就是函数指针表。我们可以写一个简化版理解：

```c
#include <stdio.h>

typedef struct {
    int (*open)(void);
    int (*read)(char *buf, int len);
    int (*write)(const char *buf, int len);
    int (*close)(void);
} device_ops_t;

int uart_open(void)
{
    printf("uart open\n");
    return 0;
}

int uart_read(char *buf, int len)
{
    (void)buf;
    printf("uart read len=%d\n", len);
    return len;
}

int uart_write(const char *buf, int len)
{
    (void)buf;
    printf("uart write len=%d\n", len);
    return len;
}

int uart_close(void)
{
    printf("uart close\n");
    return 0;
}

static const device_ops_t g_uart_ops = {
    .open = uart_open,
    .read = uart_read,
    .write = uart_write,
    .close = uart_close,
};

void test_device(const device_ops_t *ops)
{
    char buf[16];

    if (ops == NULL) {
        return;
    }

    if (ops->open) {
        ops->open();
    }

    if (ops->read) {
        ops->read(buf, sizeof(buf));
    }

    if (ops->close) {
        ops->close();
    }
}

int main(void)
{
    test_device(&g_uart_ops);
    return 0;
}
```

这就是接口抽象：上层只知道 `device_ops_t`，不关心底层是 UART、SPI 还是 I2C。

## 常见坑

### 坑一：函数签名不一致

```c
typedef int (*handler_t)(int);

void bad_handler(int x) {}

// handler_t h = bad_handler; // 错误：返回值类型不一致
```

函数指针要求参数和返回值匹配。

### 坑二：回调里使用已经失效的 user_data

```c
void register_bad(EventManager *mgr)
{
    char name[] = "temp";

    // 错误：name 是局部数组，函数返回后失效
    event_manager_init(mgr, on_event, name);
}
```

回调可能在函数返回后才执行，所以 `user_data` 必须指向仍然有效的对象。

### 坑三：调用空函数指针

```c
handler_t h = NULL;
h(1); // 错误
```

调用前检查：

```c
if (h != NULL) {
    h(1);
}
```

## 验证方法

编译：

```bash
gcc -Wall -Wextra -g function_pointer.c -o function_pointer
./function_pointer
```

用 GDB 看函数指针：

```bash
gdb ./function_pointer
break main
run
print op
print add
```

你会看到 `op` 保存的是某个函数地址。

## 复盘

函数指针的本质也是地址，只不过它指向的是代码，而不是数据。

它最常见的价值：

- 把 `switch` 变成表驱动。
- 把模块行为抽象成接口。
- 让底层在事件发生时回调上层。
- 让状态机更清晰。

如果你以后读 Linux 驱动里的 `file_operations`、FreeRTOS hook、LVGL event callback，函数指针都是绕不开的基础。
