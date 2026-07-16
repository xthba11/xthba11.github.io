---
title: Linux 驱动开发：中断、等待队列与 poll/select
date: 2026-05-12
categories:
  - 技术笔记
  - Linux
  - 驱动开发
tags:
  - Linux
  - 中断
  - 等待队列
  - poll
  - C语言
description: Linux 驱动中断和阻塞 IO 学习：request_irq、wait_event、poll/select 和用户态事件通知。
top_img: /img/embedded-lab-hero.png
---

很多驱动都需要把硬件事件通知给用户态，例如按键按下、传感器数据 ready、DMA 完成、FPGA 中断触发。

这类场景通常会用到中断、等待队列和 `poll/select/epoll`。

## 事件通知模型

```text
硬件中断
  |
  v
ISR 设置事件标志
  |
  v
wake_up_interruptible()
  |
  v
用户态 read/poll 返回
```

## 私有结构

```c
// 驱动私有数据结构：管理中断事件和等待队列
struct demo_event_dev {
    struct device *dev;              // 指向设备结构体
    int irq;                         // 中断号
    wait_queue_head_t waitq;         // 等待队列头，用于阻塞读和poll
    atomic_t event_pending;          // 事件标志，原子操作保证中断与进程上下文同步安全
    spinlock_t lock;                 // 自旋锁，保护临界区
};
```

`event_pending` 表示是否有事件等待用户态读取。

## 申请中断

```c
// devm_request_irq：申请中断，devm版本在设备释放时自动释放中断
ret = devm_request_irq(dev, demo->irq,
                       demo_irq_handler,       // 中断处理函数（顶半部）
                       IRQF_TRIGGER_RISING,    // 触发方式：上升沿触发
                       "demo-event", demo);    // 中断名称（cat /proc/interrupts可见）和设备私有数据
if (ret)
    return ret;
```

中断号可以来自设备树，也可以由 GPIO 转换得到。

## 中断处理函数

```c
// 中断处理函数（顶半部）：在中断上下文中执行，只做最小工作
static irqreturn_t demo_irq_handler(int irq, void *data)
{
    struct demo_event_dev *demo = data;

    // 设置事件待处理标志（原子操作，与read上下文同步）
    atomic_set(&demo->event_pending, 1);
    // 唤醒等待队列上所有可中断睡眠的进程
    wake_up_interruptible(&demo->waitq);

    return IRQ_HANDLED;  // 告知内核中断已成功处理
}
```

中断里只做最小工作：记录事件，唤醒等待者。

## 阻塞 read

```c
// read函数：阻塞等待硬件事件，事件到来后返回给用户态
static ssize_t demo_read(struct file *file, char __user *buf,
                         size_t count, loff_t *ppos)
{
    struct demo_event_dev *demo = file->private_data;
    uint32_t event = 1;
    int ret;

    // 等待事件标志为真，否则进程在此进入可中断睡眠
    ret = wait_event_interruptible(
        demo->waitq,
        atomic_read(&demo->event_pending)
    );
    if (ret)
        return ret;  // 可能是被信号唤醒，返回 -ERESTARTSYS

    // 清除事件标志，准备接收下一个事件
    atomic_set(&demo->event_pending, 0);

    // 将事件数据复制到用户空间缓冲区
    if (copy_to_user(buf, &event, sizeof(event)))
        return -EFAULT;

    return sizeof(event);
}
```

如果没有事件，`read()` 会睡眠；有中断后被唤醒。

## 非阻塞 read

用户态可能用 `O_NONBLOCK` 打开设备。驱动要处理这种情况。

```c
// 检查是否有事件待处理
if (!atomic_read(&demo->event_pending)) {
    // 如果用户以非阻塞模式打开，直接返回 -EAGAIN 而不是睡眠
    if (file->f_flags & O_NONBLOCK)
        return -EAGAIN;

    // 阻塞模式下等待事件到来
    ret = wait_event_interruptible(demo->waitq,
                                   atomic_read(&demo->event_pending));
    if (ret)
        return ret;
}
```

## poll 实现

```c
// poll实现：让用户态能使用select/poll/epoll监听此设备
static __poll_t demo_poll(struct file *file, poll_table *wait)
{
    struct demo_event_dev *demo = file->private_data;
    __poll_t mask = 0;

    // 将当前进程加入等待队列，poll框架在wake_up时会检查并唤醒
    poll_wait(file, &demo->waitq, wait);

    // 如果有事件待处理，报告可读
    if (atomic_read(&demo->event_pending))
        mask |= POLLIN | POLLRDNORM;  // 有普通数据可读

    return mask;
}
```

注册到 `file_operations`：

```c
// 文件操作函数表：将驱动函数注册到对应的系统调用
static const struct file_operations demo_fops = {
    .owner = THIS_MODULE,    // 模块引用计数，防止模块在使用中被卸载
    .open = demo_open,       // open() 系统调用
    .read = demo_read,       // read() 系统调用
    .poll = demo_poll,       // poll/select/epoll 系统调用
    .release = demo_release, // close() 系统调用
};
```

## 用户态 select 测试

```c
// 用户态select测试：阻塞等待设备可读
int fd = open("/dev/demo_event", O_RDONLY);
fd_set rfds;  // 读事件文件描述符集合

while (1) {
    FD_ZERO(&rfds);     // 清空文件描述符集合
    FD_SET(fd, &rfds);  // 将设备fd加入读集合

    // select阻塞等待，直到fd可读（timeout=NULL表示无限等待）
    ret = select(fd + 1, &rfds, NULL, NULL, NULL);
    if (ret > 0 && FD_ISSET(fd, &rfds)) {  // 检查fd是否可读
        uint32_t event;
        read(fd, &event, sizeof(event));
        printf("event: %u\n", event);
    }
}
```

## 用户态 poll 测试

```c
// 用户态poll测试：与select类似，但没有文件描述符数量限制
struct pollfd pfd;

pfd.fd = fd;
pfd.events = POLLIN;  // 监听可读事件

while (1) {
    // poll阻塞等待，timeout=-1表示无限等待
    ret = poll(&pfd, 1, -1);
    if (ret > 0 && (pfd.revents & POLLIN)) {  // revents由内核设置，指示实际发生的事件
        uint32_t event;
        read(fd, &event, sizeof(event));
        printf("event: %u\n", event);
    }
}
```

## 中断下半部

如果中断后需要做较多工作，可以使用下半部：

- threaded irq
- tasklet
- workqueue

现在更常用 threaded irq 或 workqueue。

```c
// 申请线程化中断：将处理分为硬中断顶半部和线程化底半部
ret = devm_request_threaded_irq(dev, irq,
                                demo_irq_top,        // 顶半部（硬中断上下文，只做快速确认）
                                demo_irq_thread,     // 线程化底半部（进程上下文，可睡眠、可做耗时操作）
                                IRQF_ONESHOT,        // 确保顶半部和底半部串行执行，防止重入
                                "demo-event", demo);
```

top half 快速确认中断，threaded handler 做较慢处理。

## 常见坑

- 中断里做耗时操作
- 忘记 `wake_up_interruptible`
- `poll_wait` 调用位置不对
- 事件标志清除太早导致丢事件
- 没处理 `O_NONBLOCK`
- 多个事件只用一个 bool，导致事件合并丢失

## 小结

中断、等待队列和 poll/select 是驱动向用户态报告事件的基础机制。理解这条链路后，就能实现按键、数据 ready、DMA 完成、FPGA 中断等典型事件驱动型设备。
