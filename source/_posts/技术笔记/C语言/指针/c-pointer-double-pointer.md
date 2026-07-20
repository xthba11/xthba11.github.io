---
title: C 语言指针第三篇：二级指针、输出参数和动态数组
date: 2024-02-10 09:30:00
categories:
  - 技术笔记
  - C语言
  - 指针
tags:
  - C语言
  - 指针
  - 二级指针
  - malloc
description: 用输出参数、字符串数组、动态内存申请和链表头修改讲清楚二级指针为什么存在。
cover: /img/covers/articles/c-pointer-double-pointer.svg
top_img: /img/covers/articles/c-pointer-double-pointer.svg
---

二级指针是很多 C 初学者的坎。`int **pp` 看起来像是把复杂度翻倍了，但它其实只解决一个问题：**当你想在函数里修改一个指针变量本身时，就需要传入这个指针变量的地址。**

这句话有点绕，我们慢慢拆。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS
- 编译器：GCC 11/12
- 编译命令：`gcc -Wall -Wextra -g double_pointer.c -o double_pointer`
- 调试工具：`gdb`、`valgrind`
- 适用场景：动态内存、字符串数组、链表、初始化函数、Linux/嵌入式驱动接口

## 问题背景

你可能见过这些函数形式：

```c
int init_buffer(uint8_t **out_buf, size_t *out_len);
int create_object(struct object **out_obj);
int main(int argc, char **argv);
```

为什么不是 `uint8_t *out_buf`，而是 `uint8_t **out_buf`？

原因是：函数参数默认是值传递。你把一个指针传进函数，函数拿到的是指针值的副本。它可以通过这个指针修改指向的内容，但不能修改调用者那个指针变量本身。

## 一级指针能改什么

先看一级指针：

```c
#include <stdio.h>

void change_value(int *p)
{
    if (p == NULL) {
        return;
    }

    // 修改 p 指向的 int 对象
    *p = 20;
}

int main(void)
{
    int a = 10;

    change_value(&a);
    printf("a = %d\n", a);

    return 0;
}
```

输出：

```text
a = 20
```

这里 `change_value()` 修改的是 `a` 的内容。

## 一级指针不能改调用者的指针变量

再看一个错误示例：

```c
#include <stdio.h>
#include <stdlib.h>

void bad_alloc(int *p)
{
    // p 是调用者指针变量的副本
    p = malloc(sizeof(int));
    if (p != NULL) {
        *p = 123;
    }
}

int main(void)
{
    int *ptr = NULL;

    bad_alloc(ptr);

    // 这里 ptr 仍然是 NULL
    if (ptr == NULL) {
        printf("ptr is still NULL\n");
    }

    return 0;
}
```

为什么？

```text
main 里的 ptr 变量      -> 保存 NULL
bad_alloc 里的 p 参数   -> 也是一个指针变量副本，开始时保存 NULL
```

`p = malloc(...)` 只改变了函数内部的 `p`，没有改变 `main` 里的 `ptr`。

## 二级指针改调用者的指针

正确写法：

```c
#include <stdio.h>
#include <stdlib.h>

int good_alloc(int **out)
{
    if (out == NULL) {
        return -1;
    }

    // *out 是调用者传进来的那个指针变量
    *out = malloc(sizeof(int));
    if (*out == NULL) {
        return -2;
    }

    // **out 是分配出来的 int 对象
    **out = 123;
    return 0;
}

int main(void)
{
    int *ptr = NULL;

    if (good_alloc(&ptr) != 0) {
        printf("alloc failed\n");
        return 1;
    }

    printf("*ptr = %d\n", *ptr);

    free(ptr);
    ptr = NULL;
    return 0;
}
```

理解这三层：

```text
ptr     : int *，保存 int 对象地址
&ptr    : int **，ptr 这个指针变量自己的地址
*out    : 调用者的 ptr
**out   : ptr 指向的 int 对象
```

所以 `int **out` 的意思不是“故意复杂”，而是“我要修改调用者的 `int *`”。

## 输出参数模式

工程里常见写法是返回错误码，结果通过输出参数带出：

```c
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int build_packet(uint8_t **out_buf, size_t *out_len)
{
    uint8_t *buf;
    size_t len = 4;

    if (out_buf == NULL || out_len == NULL) {
        return -1;
    }

    // 先把输出参数清空，避免调用者误用旧值
    *out_buf = NULL;
    *out_len = 0;

    buf = malloc(len);
    if (buf == NULL) {
        return -2;
    }

    // 构造一帧简单数据
    buf[0] = 0xAA; // 帧头
    buf[1] = 0x01; // 命令
    buf[2] = 0x01; // 长度
    buf[3] = 0x55; // 数据

    *out_buf = buf;
    *out_len = len;
    return 0;
}
```

调用：

```c
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

int build_packet(uint8_t **out_buf, size_t *out_len);

int main(void)
{
    uint8_t *packet = NULL;
    size_t packet_len = 0;

    if (build_packet(&packet, &packet_len) != 0) {
        printf("build packet failed\n");
        return 1;
    }

    for (size_t i = 0; i < packet_len; i++) {
        printf("%02X ", packet[i]);
    }
    printf("\n");

    free(packet);
    packet = NULL;
    return 0;
}
```

这种模式在协议栈、网络编程、驱动用户态库里都很常见。

## `char **argv`

`main` 函数里的 `argv` 也是二级指针：

```c
#include <stdio.h>

int main(int argc, char **argv)
{
    for (int i = 0; i < argc; i++) {
        // argv[i] 是 char *，指向一个字符串
        printf("argv[%d] = %s\n", i, argv[i]);
    }

    return 0;
}
```

可以这样理解：

```text
argv
 |
 v
+---------+      +-----+-----+-----+----+
| argv[0] | ---> | '.' | '/' | 'a' | 0  |
+---------+      +-----+-----+-----+----+
| argv[1] | ---> | '1' | '2' | '3' | 0  |
+---------+
```

`argv` 指向一个数组，数组里的每个元素都是 `char *`。

所以：

- `argv` 类型是 `char **`。
- `argv[i]` 类型是 `char *`。
- `argv[i][j]` 类型是 `char`。

## 字符串数组

```c
#include <stdio.h>

int main(void)
{
    const char *names[] = {
        "stm32",
        "linux",
        "freertos",
    };

    size_t count = sizeof(names) / sizeof(names[0]);

    for (size_t i = 0; i < count; i++) {
        printf("%s\n", names[i]);
    }

    return 0;
}
```

`names` 是数组，数组元素是 `const char *`。当传给函数时，会退化为 `const char **`。

```c
#include <stdio.h>

void print_names(const char **names, size_t count)
{
    if (names == NULL) {
        return;
    }

    for (size_t i = 0; i < count; i++) {
        if (names[i] != NULL) {
            printf("%s\n", names[i]);
        }
    }
}
```

## 修改链表头

二级指针在链表里也很常见。比如头插法：

```c
#include <stdio.h>
#include <stdlib.h>

typedef struct Node {
    int value;
    struct Node *next;
} Node;

int list_push_front(Node **head, int value)
{
    if (head == NULL) {
        return -1;
    }

    Node *node = malloc(sizeof(*node));
    if (node == NULL) {
        return -2;
    }

    node->value = value;

    // 新节点指向旧头节点
    node->next = *head;

    // 修改调用者的头指针
    *head = node;

    return 0;
}
```

为什么 `head` 要是 `Node **`？

因为插入第一个节点时，调用者的头指针会从 `NULL` 变成新节点地址。函数必须修改调用者的 `Node *head` 本身。

调用：

```c
int main(void)
{
    Node *head = NULL;

    list_push_front(&head, 10);
    list_push_front(&head, 20);

    for (Node *p = head; p != NULL; p = p->next) {
        printf("%d\n", p->value);
    }

    while (head != NULL) {
        Node *next = head->next;
        free(head);
        head = next;
    }

    return 0;
}
```

## 常见坑

### 坑一：忘记传地址

```c
int *p = NULL;
good_alloc(p);  // 错误：类型也不对，应该传 &p
good_alloc(&p); // 正确
```

### 坑二：输出参数没有初始化

```c
int create(int **out)
{
    if (some_error) {
        return -1; // 如果没有设置 *out，调用者可能拿到旧值
    }
}
```

建议函数一开始：

```c
*out = NULL;
```

### 坑三：分配失败后继续使用

```c
*out = malloc(size);
if (*out == NULL) {
    return -1;
}
```

一定要检查 `malloc` 返回值。

## 验证方法

编译：

```bash
gcc -Wall -Wextra -g double_pointer.c -o double_pointer
./double_pointer
```

检查内存泄漏：

```bash
valgrind --leak-check=full ./double_pointer
```

如果所有 `malloc` 都有对应 `free`，应该看到没有泄漏。

## 复盘

二级指针的本质非常简单：

- `T *p`：指向 `T` 的指针。
- `T **pp`：指向 `T *` 的指针。
- 想在函数里修改调用者的普通变量，传 `&变量`。
- 想在函数里修改调用者的指针变量，传 `&指针变量`。

当你看到 `uint8_t **out_buf` 时，不要害怕。它通常只是在说：这个函数会帮你创建或修改一个 `uint8_t *`。
