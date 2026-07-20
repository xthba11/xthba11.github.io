---
title: C 语言指针第五篇：内存生命周期、悬空指针和工程安全写法
date: 2024-03-06 09:50:00
categories:
  - 技术笔记
  - C语言
  - 指针
tags:
  - C语言
  - 指针
  - 内存管理
  - malloc
  - 调试
description: 从栈、堆、全局区和字符串常量区讲清楚指针生命周期，整理悬空指针、内存泄漏、越界和工程安全写法。
cover: /img/covers/articles/c-pointer-lifetime-memory.svg
top_img: /img/covers/articles/c-pointer-lifetime-memory.svg
---

前面几篇文章讲了指针怎么用。这一篇讲更重要的问题：**指针指向的对象什么时候有效，什么时候失效。**

很多 C 程序的 bug 不是语法写错，而是生命周期错了：

- 返回局部变量地址。
- 使用已经 `free` 的内存。
- 忘记释放堆内存。
- 缓冲区越界写。
- 指针保存了已经失效的对象地址。

这些问题在嵌入式里可能表现为 HardFault，在 Linux 用户态可能表现为段错误，在网络服务里可能变成偶发崩溃。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS
- 编译器：GCC 11/12
- 编译命令：`gcc -Wall -Wextra -g lifetime.c -o lifetime`
- 调试工具：`gdb`、`valgrind`、AddressSanitizer
- 适用场景：嵌入式、Linux C、网络服务、驱动用户态测试程序

建议准备两个调试命令：

```bash
valgrind --leak-check=full ./lifetime
gcc -Wall -Wextra -g -fsanitize=address lifetime.c -o lifetime_asan
```

## 问题背景

指针本身只是地址。真正关键的是：这个地址对应的对象还活着吗？

C 程序里常见对象位置：

```text
栈          局部变量、函数参数
堆          malloc/calloc/realloc 申请的内存
全局区      全局变量、static 变量
只读区      字符串常量
```

不同区域生命周期不同。

## 栈上的对象

局部变量通常在栈上：

```c
#include <stdio.h>

void func(void)
{
    int a = 10;

    // a 在 func 执行期间有效
    printf("a=%d\n", a);
}

int main(void)
{
    func();
    return 0;
}
```

`a` 的生命周期从进入 `func` 开始，到 `func` 返回结束。

所以不能返回局部变量地址：

```c
int *bad_return(void)
{
    int a = 10;

    // 错误：函数返回后 a 失效
    return &a;
}
```

正确方式一：调用者提供空间。

```c
int get_value(int *out)
{
    if (out == NULL) {
        return -1;
    }

    *out = 10;
    return 0;
}
```

正确方式二：返回值直接返回。

```c
int get_value_simple(void)
{
    return 10;
}
```

正确方式三：如果确实需要动态对象，用堆内存，但调用者必须负责释放。

```c
#include <stdlib.h>

int *create_value(void)
{
    int *p = malloc(sizeof(*p));
    if (p == NULL) {
        return NULL;
    }

    *p = 10;
    return p;
}
```

## 堆上的对象

堆内存由程序员手动管理：

```c
#include <stdio.h>
#include <stdlib.h>

int main(void)
{
    int *p = malloc(sizeof(*p));
    if (p == NULL) {
        return 1;
    }

    *p = 100;
    printf("%d\n", *p);

    free(p);
    p = NULL;

    return 0;
}
```

堆内存规则：

- `malloc` 成功后开始有效。
- `free` 后生命周期结束。
- 每块成功申请的内存应该释放一次。
- 不能重复释放。
- 释放后不要再访问。

## 悬空指针

悬空指针指向已经失效的对象。

```c
#include <stdlib.h>

int main(void)
{
    int *p = malloc(sizeof(*p));
    if (p == NULL) {
        return 1;
    }

    *p = 10;
    free(p);

    // 错误：p 仍然保存旧地址，但那块内存已经无效
    // *p = 20;

    p = NULL;
    return 0;
}
```

把指针置空不能修复已经发生的错误，但能减少后续误用。

## 内存泄漏

内存泄漏是申请了堆内存，却没有释放。

```c
#include <stdlib.h>

void leak(void)
{
    int *p = malloc(sizeof(*p));
    if (p == NULL) {
        return;
    }

    *p = 10;

    // 错误：函数返回前没有 free(p)
}
```

用 `valgrind` 检查：

```bash
valgrind --leak-check=full ./lifetime
```

如果泄漏，会看到类似：

```text
definitely lost: 4 bytes in 1 blocks
```

工程里减少泄漏的习惯：

- 谁申请，谁释放。
- 如果跨模块传递所有权，文档和函数名要写清楚。
- 错误路径也要释放已经申请的资源。

## 错误路径释放

真实工程里，经常是多个资源连续申请：

```c
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    char *rx_buf;
    char *tx_buf;
} Device;

int device_init(Device *dev)
{
    if (dev == NULL) {
        return -1;
    }

    dev->rx_buf = NULL;
    dev->tx_buf = NULL;

    dev->rx_buf = malloc(128);
    if (dev->rx_buf == NULL) {
        return -2;
    }

    dev->tx_buf = malloc(128);
    if (dev->tx_buf == NULL) {
        // 第二步失败时，要释放第一步已经申请的资源
        free(dev->rx_buf);
        dev->rx_buf = NULL;
        return -3;
    }

    return 0;
}

void device_deinit(Device *dev)
{
    if (dev == NULL) {
        return;
    }

    free(dev->rx_buf);
    free(dev->tx_buf);

    dev->rx_buf = NULL;
    dev->tx_buf = NULL;
}
```

这个模式在嵌入式驱动初始化、Linux 用户态库初始化里很常见。

## 用 goto 统一错误清理

C 工程里常见 `goto`，不是为了乱跳，而是统一释放资源。

```c
#include <stdlib.h>

typedef struct {
    char *rx_buf;
    char *tx_buf;
    char *log_buf;
} Module;

int module_init(Module *m)
{
    int ret = 0;

    if (m == NULL) {
        return -1;
    }

    m->rx_buf = NULL;
    m->tx_buf = NULL;
    m->log_buf = NULL;

    m->rx_buf = malloc(128);
    if (m->rx_buf == NULL) {
        ret = -2;
        goto err;
    }

    m->tx_buf = malloc(128);
    if (m->tx_buf == NULL) {
        ret = -3;
        goto err;
    }

    m->log_buf = malloc(256);
    if (m->log_buf == NULL) {
        ret = -4;
        goto err;
    }

    return 0;

err:
    // free(NULL) 是安全的，所以可以统一释放
    free(m->log_buf);
    free(m->tx_buf);
    free(m->rx_buf);

    m->log_buf = NULL;
    m->tx_buf = NULL;
    m->rx_buf = NULL;

    return ret;
}
```

这种写法比在每个失败点手动释放更不容易漏。

## 字符串常量生命周期

```c
const char *s = "hello";
```

字符串常量通常位于只读区域，整个程序运行期间有效，但不能修改。

错误：

```c
char *s = "hello";
s[0] = 'H'; // 错误：尝试修改字符串常量
```

正确：

```c
char s[] = "hello";
s[0] = 'H'; // 正确：修改的是数组里的副本
```

建议写成：

```c
const char *s = "hello";
```

让编译器帮你阻止误修改。

## 所有权

指针代码里一定要想清楚所有权。

看两个函数名：

```c
const char *user_get_name(void);
char *user_dup_name(void);
```

我会约定：

- `get`：返回内部指针，调用者不能释放。
- `dup/create/alloc`：返回新申请的内存，调用者负责释放。

示例：

```c
#include <stdlib.h>
#include <string.h>

const char *user_get_name(void)
{
    // 返回字符串常量，调用者不能 free
    return "xthba";
}

char *user_dup_name(void)
{
    const char *name = "xthba";
    char *copy = malloc(strlen(name) + 1);
    if (copy == NULL) {
        return NULL;
    }

    strcpy(copy, name);
    return copy; // 调用者负责 free
}
```

调用：

```c
const char *name1 = user_get_name();
// free(name1); // 错误

char *name2 = user_dup_name();
free(name2);   // 正确
name2 = NULL;
```

## 工程安全写法清单

### 1. 指针初始化

```c
int *p = NULL;
```

不要让指针带着随机值。

### 2. 使用前判空

```c
if (p == NULL) {
    return -1;
}
```

### 3. 指针和长度一起传

```c
int parse(const uint8_t *buf, size_t len);
```

不要只传 `uint8_t *buf`，否则函数不知道边界。

### 4. 释放后置空

```c
free(p);
p = NULL;
```

### 5. 明确所有权

```c
// 返回内部缓存，不要释放
const char *config_get_name(void);

// 返回新分配内存，需要调用者释放
char *config_dup_name(void);
```

## 验证方法

编译：

```bash
gcc -Wall -Wextra -g lifetime.c -o lifetime
./lifetime
```

检查泄漏：

```bash
valgrind --leak-check=full ./lifetime
```

检查越界和 use-after-free：

```bash
gcc -Wall -Wextra -g -fsanitize=address lifetime.c -o lifetime_asan
./lifetime_asan
```

GDB 定位段错误：

```bash
gdb ./lifetime
run
bt
```

`bt` 可以打印调用栈，帮助你找到崩溃位置。

## 复盘

指针安全不是靠记住所有规则，而是靠稳定习惯：

- 每个指针都知道它指向谁。
- 每块内存都知道谁负责释放。
- 每次访问都知道长度边界。
- 每个错误路径都释放已申请资源。
- 每个返回指针的函数都说明所有权。

如果你能把生命周期想清楚，C 指针就不再是玄学。它只是地址和对象之间的一份契约：对象还活着，指针才有意义。
