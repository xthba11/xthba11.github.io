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
struct demo_event_dev {
    struct device *dev;
    int irq;
    wait_queue_head_t waitq;
    atomic_t event_pending;
    spinlock_t lock;
};
```

`event_pending` 表示是否有事件等待用户态读取。

## 申请中断

```c
ret = devm_request_irq(dev, demo->irq,
                       demo_irq_handler,
                       IRQF_TRIGGER_RISING,
                       "demo-event", demo);
if (ret)
    return ret;
```

中断号可以来自设备树，也可以由 GPIO 转换得到。

## 中断处理函数

```c
static irqreturn_t demo_irq_handler(int irq, void *data)
{
    struct demo_event_dev *demo = data;

    atomic_set(&demo->event_pending, 1);
    wake_up_interruptible(&demo->waitq);

    return IRQ_HANDLED;
}
```

中断里只做最小工作：记录事件，唤醒等待者。

## 阻塞 read

```c
static ssize_t demo_read(struct file *file, char __user *buf,
                         size_t count, loff_t *ppos)
{
    struct demo_event_dev *demo = file->private_data;
    uint32_t event = 1;
    int ret;

    ret = wait_event_interruptible(
        demo->waitq,
        atomic_read(&demo->event_pending)
    );
    if (ret)
        return ret;

    atomic_set(&demo->event_pending, 0);

    if (copy_to_user(buf, &event, sizeof(event)))
        return -EFAULT;

    return sizeof(event);
}
```

如果没有事件，`read()` 会睡眠；有中断后被唤醒。

## 非阻塞 read

用户态可能用 `O_NONBLOCK` 打开设备。驱动要处理这种情况。

```c
if (!atomic_read(&demo->event_pending)) {
    if (file->f_flags & O_NONBLOCK)
        return -EAGAIN;

    ret = wait_event_interruptible(demo->waitq,
                                   atomic_read(&demo->event_pending));
    if (ret)
        return ret;
}
```

## poll 实现

```c
static __poll_t demo_poll(struct file *file, poll_table *wait)
{
    struct demo_event_dev *demo = file->private_data;
    __poll_t mask = 0;

    poll_wait(file, &demo->waitq, wait);

    if (atomic_read(&demo->event_pending))
        mask |= POLLIN | POLLRDNORM;

    return mask;
}
```

注册到 `file_operations`：

```c
static const struct file_operations demo_fops = {
    .owner = THIS_MODULE,
    .open = demo_open,
    .read = demo_read,
    .poll = demo_poll,
    .release = demo_release,
};
```

## 用户态 select 测试

```c
int fd = open("/dev/demo_event", O_RDONLY);
fd_set rfds;

while (1) {
    FD_ZERO(&rfds);
    FD_SET(fd, &rfds);

    ret = select(fd + 1, &rfds, NULL, NULL, NULL);
    if (ret > 0 && FD_ISSET(fd, &rfds)) {
        uint32_t event;
        read(fd, &event, sizeof(event));
        printf("event: %u\n", event);
    }
}
```

## 用户态 poll 测试

```c
struct pollfd pfd;

pfd.fd = fd;
pfd.events = POLLIN;

while (1) {
    ret = poll(&pfd, 1, -1);
    if (ret > 0 && (pfd.revents & POLLIN)) {
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
ret = devm_request_threaded_irq(dev, irq,
                                demo_irq_top,
                                demo_irq_thread,
                                IRQF_ONESHOT,
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
