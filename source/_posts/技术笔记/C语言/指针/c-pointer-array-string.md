---
title: C 语言指针第二篇：数组、字符串和指针运算
date: 2024-01-28 09:20:00
categories:
  - 技术笔记
  - C语言
  - 指针
tags:
  - C语言
  - 指针
  - 数组
  - 字符串
description: 讲清楚数组名、指针运算、字符串遍历、越界访问和嵌入式缓冲区处理中最常见的指针问题。
cover: /img/covers/articles/c-pointer-array-string.svg
top_img: /img/covers/articles/c-pointer-array-string.svg
---

学 C 语言指针绕不开数组和字符串。很多初学者会听到一句话：“数组名就是指针”。这句话有帮助，但也容易误导。

更准确地说：**在大多数表达式里，数组名会转换成指向首元素的指针，但数组本身不是指针变量。**

这篇文章就围绕这个区别展开。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS
- 编译器：GCC 11/12
- 编译命令：`gcc -Wall -Wextra -g pointer_array.c -o pointer_array`
- 适用场景：字符串处理、协议解析、串口缓冲区、网络收发缓冲区

## 问题背景

在嵌入式和 Linux C 开发里，经常会遇到这些代码：

```c
uint8_t rx_buf[128];
char line[64];
const char *cmd = "AT+RST";
parse_frame(buf, len);
```

它们背后都离不开数组和指针。

如果你不理解数组名、首元素地址、指针加法和边界长度，很容易写出：

- 越界访问。
- 字符串没有 `'\0'`。
- `sizeof` 得到的不是数组长度。
- 缓冲区解析错位。
- 函数里修改不到调用者的数据。

## 数组在内存中是什么样

先看一个整数数组：

```c
#include <stdio.h>

int main(void)
{
    int arr[4] = {10, 20, 30, 40};

    printf("arr[0] = %d\n", arr[0]);
    printf("arr[1] = %d\n", arr[1]);

    printf("&arr[0] = %p\n", (void *)&arr[0]);
    printf("&arr[1] = %p\n", (void *)&arr[1]);

    return 0;
}
```

数组元素在内存中连续排列：

```text
arr[0]    arr[1]    arr[2]    arr[3]
 10        20        30        40
```

如果 `int` 占 4 字节，那么 `&arr[1]` 通常比 `&arr[0]` 大 4。

## 数组名和首元素地址

```c
#include <stdio.h>

int main(void)
{
    int arr[4] = {10, 20, 30, 40};

    // 在表达式中，arr 通常会转换为 &arr[0]
    printf("arr     = %p\n", (void *)arr);
    printf("&arr[0] = %p\n", (void *)&arr[0]);

    // &arr 表示整个数组的地址，数值可能一样，但类型不同
    printf("&arr    = %p\n", (void *)&arr);

    return 0;
}
```

这三个打印出来的地址数值可能一样，但类型不一样：

- `arr`：大多数表达式里转换成 `int *`，指向第一个元素。
- `&arr[0]`：类型是 `int *`，指向第一个元素。
- `&arr`：类型是 `int (*)[4]`，指向整个数组。

类型不同会影响指针运算：

```c
#include <stdio.h>

int main(void)
{
    int arr[4] = {10, 20, 30, 40};

    printf("arr + 1  = %p\n", (void *)(arr + 1));
    printf("&arr + 1 = %p\n", (void *)(&arr + 1));

    return 0;
}
```

含义：

- `arr + 1`：跳过一个 `int`。
- `&arr + 1`：跳过整个 `int[4]` 数组。

这就是为什么“数组名就是指针”不够准确。

## 指针遍历数组

数组下标本质上也可以写成指针运算：

```c
arr[i] == *(arr + i)
```

示例：

```c
#include <stdio.h>

int main(void)
{
    int arr[4] = {10, 20, 30, 40};
    int *p = arr; // arr 转换为指向首元素的指针

    for (int i = 0; i < 4; i++) {
        // p + i 指向第 i 个元素
        printf("arr[%d] = %d\n", i, *(p + i));
    }

    return 0;
}
```

也可以移动指针：

```c
#include <stdio.h>

int main(void)
{
    int arr[4] = {10, 20, 30, 40};
    int *p = arr;

    while (p < arr + 4) {
        // *p 访问当前元素
        printf("%d\n", *p);

        // p++ 移动到下一个 int 元素
        p++;
    }

    return 0;
}
```

这种写法在解析缓冲区时很常见，但必须保证不越界。

## 函数参数里的数组会退化成指针

看这个例子：

```c
#include <stdio.h>

void print_size(int arr[])
{
    // 这里的 arr 实际上是 int *，不是原始数组
    printf("sizeof(arr) in function = %zu\n", sizeof(arr));
}

int main(void)
{
    int arr[4] = {10, 20, 30, 40};

    printf("sizeof(arr) in main = %zu\n", sizeof(arr));
    print_size(arr);

    return 0;
}
```

在 `main` 里，`sizeof(arr)` 是整个数组大小，通常是 16。

在函数里，`arr` 已经退化成 `int *`，`sizeof(arr)` 是指针大小，64 位系统通常是 8。

所以函数处理数组时必须显式传长度：

```c
#include <stdio.h>

void print_array(const int *arr, size_t len)
{
    if (arr == NULL) {
        return;
    }

    for (size_t i = 0; i < len; i++) {
        printf("%d\n", arr[i]);
    }
}

int main(void)
{
    int arr[4] = {10, 20, 30, 40};

    // sizeof(arr) / sizeof(arr[0]) 只能在数组还没有退化前使用
    print_array(arr, sizeof(arr) / sizeof(arr[0]));

    return 0;
}
```

这是一条非常重要的工程规则：**指针加长度一起传**。

## 字符串和字符数组

C 字符串本质上是以 `'\0'` 结尾的字符数组。

```c
#include <stdio.h>

int main(void)
{
    char s1[] = "hello";
    const char *s2 = "hello";

    printf("s1 = %s\n", s1);
    printf("s2 = %s\n", s2);

    return 0;
}
```

`s1` 是数组：

```text
'h' 'e' 'l' 'l' 'o' '\0'
```

`s2` 是指针，指向字符串常量。

重要区别：

```c
char s1[] = "hello";
s1[0] = 'H'; // 可以修改数组里的内容

const char *s2 = "hello";
// s2[0] = 'H'; // 错误：字符串常量不应该修改
```

建议把字符串常量写成 `const char *`，这样编译器能帮你防止误修改。

## 手写 strlen

用指针理解字符串结束符：

```c
#include <stddef.h>
#include <stdio.h>

size_t my_strlen(const char *s)
{
    const char *p = s;

    if (s == NULL) {
        return 0;
    }

    // C 字符串以 '\0' 作为结束标志
    while (*p != '\0') {
        p++;
    }

    // 两个指针相减，得到中间有多少个 char 元素
    return (size_t)(p - s);
}

int main(void)
{
    printf("%zu\n", my_strlen("hello"));
    return 0;
}
```

这段代码体现了三个点：

- `p` 从字符串首字符开始。
- `*p` 访问当前字符。
- `p++` 移动到下一个字符。

## 缓冲区解析示例

嵌入式串口和网络协议里，经常要解析一段二进制数据。

假设一帧格式：

```text
Byte0: 帧头 0xAA
Byte1: 命令
Byte2: 数据长度 len
Byte3..: 数据
```

代码：

```c
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>

int parse_frame(const uint8_t *buf, size_t len)
{
    if (buf == NULL) {
        return -1;
    }

    // 最小长度至少需要帧头、命令、长度三个字节
    if (len < 3) {
        return -2;
    }

    if (buf[0] != 0xAA) {
        return -3;
    }

    uint8_t cmd = buf[1];
    uint8_t data_len = buf[2];

    // 检查声明的数据长度是否超过实际缓冲区
    if ((size_t)data_len > len - 3) {
        return -4;
    }

    const uint8_t *payload = buf + 3;

    printf("cmd=0x%02X, data_len=%u\n", cmd, data_len);

    for (uint8_t i = 0; i < data_len; i++) {
        printf("payload[%u]=0x%02X\n", i, payload[i]);
    }

    return 0;
}

int main(void)
{
    uint8_t frame[] = {0xAA, 0x01, 0x03, 0x11, 0x22, 0x33};

    parse_frame(frame, sizeof(frame));
    return 0;
}
```

这里最重要的是边界检查：

```c
if ((size_t)data_len > len - 3) {
    return -4;
}
```

没有这句，`payload[i]` 就可能越界读取。

## 常见坑

### 坑一：函数里用 sizeof 算数组长度

```c
void bad(int arr[])
{
    // 错误：这里 sizeof(arr) 是指针大小
    size_t len = sizeof(arr) / sizeof(arr[0]);
}
```

正确方式：

```c
void good(int *arr, size_t len)
{
    // 调用者负责传入真实长度
}
```

### 坑二：字符串没有结束符

```c
char buf[5] = {'h', 'e', 'l', 'l', 'o'};
printf("%s\n", buf); // 错误：没有 '\0'
```

正确：

```c
char buf[6] = {'h', 'e', 'l', 'l', 'o', '\0'};
```

### 坑三：越界写数组

```c
int arr[4];
arr[4] = 100; // 错误：合法下标是 0 到 3
```

C 语言不会自动检查越界，这类 bug 在嵌入式里可能表现为莫名其妙的变量被改、任务崩溃、HardFault。

## 验证方法

保存为 `pointer_array.c`：

```bash
gcc -Wall -Wextra -g pointer_array.c -o pointer_array
./pointer_array
```

如果想观察越界问题，可以开启 AddressSanitizer：

```bash
gcc -Wall -Wextra -g -fsanitize=address pointer_array.c -o pointer_array
./pointer_array
```

AddressSanitizer 在 Linux 用户态很好用，能帮你发现数组越界、use-after-free 等问题。

## 复盘

这篇文章的核心结论：

- 数组名在大多数表达式里会转换成首元素指针，但数组本身不是指针变量。
- 函数参数里的数组会退化成指针，所以必须额外传长度。
- 字符串是以 `'\0'` 结尾的字符数组。
- 解析缓冲区时永远把指针和长度放在一起考虑。

如果你写嵌入式串口协议、网络协议、CAN 报文解析，指针加长度的习惯会救你很多次。
