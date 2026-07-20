---
title: 嵌入式 C 第十篇：常见 bug 复盘合集
date: 2024-06-26 11:40:00
categories:
  - 技术笔记
  - C语言
  - 嵌入式C
tags:
  - C语言
  - 嵌入式
  - 调试
  - bug复盘
description: 汇总嵌入式 C 中最常见的指针、数组、volatile、栈、状态机和协议解析问题，并给出防御性写法。
cover: /img/covers/articles/embedded-c-bug-review.svg
top_img: /img/covers/articles/embedded-c-bug-review.svg
---

嵌入式 C 的很多 bug 都不是“不会语法”，而是边界、生命周期、并发和硬件行为没想清楚。这篇文章整理一组高频问题，作为写代码前后的检查清单。

## 1. 未初始化变量

错误：

```c
int flag;

if (flag) {
    // flag 值不确定
}
```

正确：

```c
int flag = 0;
```

工程习惯：变量定义时尽量初始化。

## 2. 野指针

错误：

```c
int *p;
*p = 10;
```

正确：

```c
int *p = NULL;

if (p != NULL) {
    *p = 10;
}
```

指针不确定时就置 `NULL`。

## 3. 数组越界

错误：

```c
uint8_t buf[8];
for (int i = 0; i <= 8; i++) {
    buf[i] = 0; // i=8 越界
}
```

正确：

```c
for (int i = 0; i < 8; i++) {
    buf[i] = 0;
}
```

更好的写法：

```c
for (size_t i = 0; i < sizeof(buf); i++) {
    buf[i] = 0;
}
```

## 4. 字符串没有结束符

错误：

```c
char name[4] = {'t', 'e', 's', 't'};
printf("%s\n", name);
```

正确：

```c
char name[5] = {'t', 'e', 's', 't', '\0'};
```

或者：

```c
char name[] = "test";
```

## 5. 中断共享变量没加 volatile

错误：

```c
uint8_t rx_done = 0;

void USART_IRQHandler(void)
{
    rx_done = 1;
}
```

正确：

```c
volatile uint8_t rx_done = 0;
```

但要记住：`volatile` 不等于线程安全。

## 6. 中断里做太多事

错误：

```c
void USART_IRQHandler(void)
{
    printf("rx\n");
    parse_protocol();
    write_flash();
}
```

正确：

```c
void USART_IRQHandler(void)
{
    uint8_t byte = UART_READ_DATA_REGISTER();

    // 中断里只搬运数据和设置标志
    rb_push(&g_rx_rb, byte);
}
```

复杂逻辑放到主循环或任务。

## 7. 大数组放栈上

错误：

```c
void task(void)
{
    uint8_t frame_buf[8192];
}
```

可能直接栈溢出。

更稳：

```c
static uint8_t frame_buf[8192];
```

但它会占 `.bss`，需要看 map 文件确认 RAM 足够。

## 8. 错误路径没释放资源

错误：

```c
int init(void)
{
    uint8_t *a = malloc(128);
    uint8_t *b = malloc(128);

    if (b == NULL) {
        return -1; // a 泄漏
    }

    return 0;
}
```

正确：

```c
int init(void)
{
    uint8_t *a = malloc(128);
    uint8_t *b = NULL;

    if (a == NULL) {
        return -1;
    }

    b = malloc(128);
    if (b == NULL) {
        free(a);
        return -2;
    }

    free(b);
    free(a);
    return 0;
}
```

## 9. 协议长度没检查

错误：

```c
uint8_t len = buf[2];
memcpy(payload, &buf[3], len);
```

正确：

```c
if (buf_len < 3) {
    return -1;
}

uint8_t len = buf[2];

if ((size_t)len > buf_len - 3) {
    return -2;
}

memcpy(payload, &buf[3], len);
```

协议解析必须先检查长度，再访问字段。

## 10. 状态机没有超时

错误：协议解析等 payload，结果永远卡在某个状态。

改进：

```c
if (now_ms - parser->state_tick > PARSE_TIMEOUT_MS) {
    parser->state = PARSE_WAIT_HEADER;
}
```

任何等待外部输入的状态都应该有超时恢复。

## 11. 函数返回局部变量地址

错误：

```c
int *get_value(void)
{
    int value = 10;
    return &value;
}
```

正确：

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

## 12. 头文件里定义变量

错误：

```c
// app.h
int g_mode = 0;
```

正确：

```c
// app.h
extern int g_mode;
```

```c
// app.c
int g_mode = 0;
```

更推荐用函数封装，不直接暴露全局变量。

## 调试清单

遇到异常时，按这个顺序查：

1. 最近改了哪些指针和数组。
2. 是否有越界写。
3. 是否有局部大数组。
4. 中断和主循环是否共享变量。
5. 是否忘记 `volatile` 或临界区。
6. 协议长度是否检查。
7. 错误路径是否释放资源。
8. map 文件里 RAM 是否够。
9. FreeRTOS 栈高水位是否安全。
10. HardFault 的 PC 落在哪个函数。

## 防御性模板

```c
int module_do(uint8_t *out, size_t out_size, const uint8_t *in, size_t in_len)
{
    if (out == NULL || in == NULL) {
        return -1;
    }

    if (out_size == 0 || in_len == 0) {
        return -2;
    }

    if (in_len > out_size) {
        return -3;
    }

    for (size_t i = 0; i < in_len; i++) {
        out[i] = in[i];
    }

    return 0;
}
```

参数判空、长度检查、错误码返回，是底层 C 代码的基本安全线。

## 复盘

嵌入式 C 的 bug 很多都可以归到四类：

- 指针生命周期。
- 缓冲区边界。
- 中断/任务并发。
- 资源释放路径。

写代码时多问一句“这个地址还有效吗”“这个长度够吗”“这个变量会不会被中断改”“失败后资源释放了吗”，能少踩很多坑。
