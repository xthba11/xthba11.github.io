---
title: C 语言指针第一篇：从变量地址到内存模型
date: 2026-07-17 09:10:00
categories:
  - 技术笔记
  - C语言
  - 指针
tags:
  - C语言
  - 指针
  - 内存模型
  - 嵌入式
description: 从变量、地址、指针变量、解引用和内存布局开始，建立理解 C 语言指针的底层模型。
cover: /img/covers/articles/c-pointer-memory-model.svg
top_img: /img/covers/articles/c-pointer-memory-model.svg
---

很多人学 C 语言指针时会卡住，是因为一开始就背语法：`*p`、`&a`、`int *p`。这些符号确实重要，但如果脑子里没有“内存里到底发生了什么”的画面，后面遇到数组、二级指针、函数指针、结构体指针就会越来越乱。

这篇文章先不追求花哨技巧，只解决一个核心问题：**指针到底是什么**。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS
- 编译器：GCC 11/12
- 编译命令：`gcc -Wall -Wextra -g pointer_basic.c -o pointer_basic`
- 调试工具：`gdb`、`printf`
- 适用场景：C 基础、嵌入式、Linux 驱动、网络编程

建议初学者编译时始终打开告警：

```bash
gcc -Wall -Wextra -g pointer_basic.c -o pointer_basic
```

`-Wall -Wextra` 能帮你发现很多指针类型不匹配、未初始化变量、危险转换等问题。

## 问题背景

C 语言和 Python、Java 最大的区别之一是：C 语言允许你直接处理内存地址。

这带来两个结果：

- 好处：效率高，能写驱动、协议栈、RTOS、嵌入式底层代码。
- 代价：程序员必须自己理解对象在哪里、地址是什么、生命周期什么时候结束。

所以指针不是“高级语法”，而是 C 语言和内存打交道的基本工具。

## 变量和地址

先看一个最小例子：

```c
#include <stdio.h>

int main(void)
{
    int a = 10;

    // &a 表示变量 a 在内存中的地址
    printf("a value   = %d\n", a);
    printf("a address = %p\n", (void *)&a);

    return 0;
}
```

可能输出：

```text
a value   = 10
a address = 0x7ffc1a2c8b4c
```

这里要分清两件事：

- `a`：变量里保存的值，是 `10`。
- `&a`：变量所在内存位置的地址，例如 `0x7ffc...`。

可以把内存想成很多连续编号的格子：

```text
地址                 内容
0x1000              ?
0x1004              10   <- 变量 a
0x1008              ?
```

`a` 关心格子里的内容，`&a` 关心格子的编号。

## 指针变量是什么

指针变量也是变量，只是它保存的内容比较特殊：**它保存的是另一个对象的地址**。

```c
#include <stdio.h>

int main(void)
{
    int a = 10;

    // p 是一个指针变量，它保存 int 类型变量的地址
    int *p = &a;

    printf("a value        = %d\n", a);
    printf("a address      = %p\n", (void *)&a);
    printf("p value        = %p\n", (void *)p);
    printf("p own address  = %p\n", (void *)&p);

    return 0;
}
```

注意这几行的含义：

- `int *p`：定义一个指向 `int` 的指针变量。
- `p = &a`：把变量 `a` 的地址保存到 `p` 里面。
- `p`：指针变量里保存的地址。
- `&p`：指针变量 `p` 自己在内存中的地址。

这张图很关键：

```text
变量 a:
地址 0x1000，内容 10

变量 p:
地址 0x2000，内容 0x1000

p 保存的是 a 的地址
```

所以不要把 `p` 和 `&p` 混起来：

- `p` 是它保存的地址，也就是 `a` 的地址。
- `&p` 是指针变量自己所在的地址。

## 解引用

有了地址以后，怎么访问这个地址对应的内容？用解引用运算符 `*`。

```c
#include <stdio.h>

int main(void)
{
    int a = 10;
    int *p = &a;

    // *p 表示访问 p 指向的那个 int 对象
    printf("*p = %d\n", *p);

    // 通过指针修改 a
    *p = 20;

    printf("a = %d\n", a);

    return 0;
}
```

输出：

```text
*p = 10
a = 20
```

关键理解：

```c
*p = 20;
```

不是修改 `p` 的值，而是修改 `p` 指向的那块内存的值。因为 `p` 指向 `a`，所以 `a` 变成了 20。

## `int *p` 和 `*p` 不是一回事

这是初学者最容易混的地方。

```c
int *p = &a;
```

这里的 `*` 是声明的一部分，表示 `p` 的类型是“指向 int 的指针”。

```c
*p = 20;
```

这里的 `*` 是解引用运算符，表示“访问 p 指向的对象”。

同一个符号在不同上下文里含义不同：

| 写法 | 场景 | 含义 |
| --- | --- | --- |
| `int *p` | 声明变量 | `p` 是指向 int 的指针 |
| `*p` | 表达式 | 访问 `p` 指向的 int |
| `&a` | 表达式 | 取变量 `a` 的地址 |

## 指针类型为什么重要

指针保存的是地址，那为什么还要有 `int *`、`char *`、`double *`？

因为指针类型告诉编译器两件事：

- 解引用时读多少字节。
- 指针加一时移动多少字节。

看例子：

```c
#include <stdio.h>

int main(void)
{
    int a = 0x11223344;
    int *ip = &a;
    char *cp = (char *)&a;

    // int * 解引用时，会按 int 大小读取
    printf("*ip = 0x%x\n", *ip);

    // char * 解引用时，只读取 1 个字节
    printf("*cp = 0x%x\n", (unsigned char)*cp);

    printf("ip     = %p\n", (void *)ip);
    printf("ip + 1 = %p\n", (void *)(ip + 1)); // 通常增加 4 个字节

    printf("cp     = %p\n", (void *)cp);
    printf("cp + 1 = %p\n", (void *)(cp + 1)); // 增加 1 个字节

    return 0;
}
```

`ip + 1` 不是地址加 1，而是移动到下一个 `int`；`cp + 1` 才是移动到下一个 `char`。

这也是数组和指针关系的基础。

## 空指针

如果一个指针暂时不指向任何有效对象，应该初始化为 `NULL`。

```c
#include <stdio.h>

int main(void)
{
    int *p = NULL;

    // 使用指针前先判断是否为空
    if (p == NULL) {
        printf("p is NULL, cannot dereference\n");
        return 0;
    }

    // 如果 p 为空，执行 *p 会导致未定义行为，常见结果是段错误
    printf("%d\n", *p);

    return 0;
}
```

空指针的价值是：它能明确表达“当前没有指向有效对象”。

不要写这种代码：

```c
int *p;
printf("%d\n", *p); // 错误：p 未初始化，里面是随机地址
```

未初始化指针比空指针更危险，因为它看起来像一个地址，但这个地址不一定属于你的程序。

## 指针常见错误

### 错误一：返回局部变量地址

```c
int *bad_func(void)
{
    int a = 10;

    // 错误：a 是局部变量，函数返回后它的生命周期结束
    return &a;
}
```

函数返回后，`a` 所在的栈空间已经无效。调用者拿到的是悬空指针。

正确做法之一是由调用者提供存储空间：

```c
void good_func(int *out)
{
    if (out == NULL) {
        return;
    }

    // 修改调用者传进来的变量
    *out = 10;
}
```

### 错误二：使用已经释放的内存

```c
#include <stdlib.h>

int main(void)
{
    int *p = malloc(sizeof(int));
    if (p == NULL) {
        return 1;
    }

    *p = 10;
    free(p);

    // 错误：p 指向的堆内存已经释放
    // printf("%d\n", *p);

    // 建议释放后立刻置空，避免误用
    p = NULL;

    return 0;
}
```

### 错误三：类型不匹配

```c
double d = 3.14;
int *p = (int *)&d; // 危险：把 double 的内存当 int 解释
```

这类强制转换很容易破坏类型规则，除非你非常明确自己在做底层字节解析，否则不要随便转换指针类型。

## 验证方法

把文章里的代码保存为 `pointer_basic.c`，编译：

```bash
gcc -Wall -Wextra -g pointer_basic.c -o pointer_basic
./pointer_basic
```

如果想观察变量地址，可以用 GDB：

```bash
gdb ./pointer_basic
break main
run
print &a
print p
print *p
```

你会发现 `p` 的值和 `&a` 一样，而 `*p` 是 `a` 的值。

## 复盘

这篇文章最重要的结论只有三条：

- 指针变量也是变量，它保存的是地址。
- `*p` 是访问 `p` 指向的对象，不是访问 `p` 自己。
- 指针类型决定了解引用读多少字节，也决定了指针运算移动多少字节。

理解这三点后，后面的数组指针、二级指针、结构体指针、函数指针都会轻松很多。指针不是魔法，它只是 C 语言暴露出来的内存地址。
