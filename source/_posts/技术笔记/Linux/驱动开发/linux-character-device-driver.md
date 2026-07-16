---
title: Linux 字符设备驱动入门：从 open 到 ioctl
date: 2026-05-01
categories:
  - 技术笔记
  - Linux
  - 驱动开发
tags:
  - Linux
  - 驱动开发
  - 字符设备
  - ioctl
  - 内核模块
description: Linux 字符设备驱动的最小闭环：设备号、cdev、file_operations、read/write/ioctl 和用户态测试。
top_img: /img/embedded-lab-hero.png
---

字符设备驱动是 Linux 驱动开发最适合入门的切入点。它能覆盖设备号、文件操作接口、内核态和用户态交互等核心概念。

本文以一个简单的 `demo_chrdev` 为例，建立最小闭环。这个实验不是单纯为了写一个 hello driver，而是给后面的 RK3568 车载网关项目做准备：网关主程序运行在用户态，但板端可能会接入按键、蜂鸣器、状态灯、外部告警输入或者自定义硬件状态节点，这些硬件最终都需要通过驱动暴露给用户态程序。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS，x86_64，用于编译和初步验证内核模块代码。
- 目标板/芯片：RK3568 Linux 开发板，车载网关与车道偏离预警实验平台。
- 内核/SDK/编译器版本：RK3568 厂商 Linux SDK，内核版本以板端 `uname -r` 为准；交叉编译器使用 SDK 内置 `aarch64-linux-gnu-gcc` 或板端原生 `gcc`。
- 使用工具：`make`、`insmod`、`rmmod`、`dmesg`、`lsmod`、`mknod`、`strace`、`gdb`。
- 关联项目：RK3568 车载 CAN 网关与轻量级车道偏离预警系统，用户态包含 SocketCAN、OpenCV、SQLite 和 Qt Dashboard。

板端确认命令：

```bash
uname -a
cat /proc/version
gcc --version
ls /lib/modules/$(uname -r)/build
```

如果 `/lib/modules/$(uname -r)/build` 不存在，说明板端没有准备内核头文件，建议在 Ubuntu 主机上使用 RK3568 SDK 里的内核源码交叉编译模块。

## 问题背景

RK3568 车载网关主程序主要运行在用户态：`vehicle_gateway` 负责 SocketCAN 接收和 CAN 报文解析，OpenCV 线程负责车道线检测，Qt Dashboard 负责显示车辆状态和告警。用户态程序已经能完成大部分业务，但项目想继续往“真实车载终端”靠近，就会遇到几个内核到用户态的接口需求：

- 通过 GPIO 按键触发告警确认、界面切换或者日志打点。
- 控制蜂鸣器、状态灯、继电器等简单外设。
- 暴露一个调试节点，方便用户态读取驱动内部状态。
- 后续接入 MCP2515 SPI-CAN、外部中断输入时，先理解字符设备的基本闭环。

所以这篇文章的目标是先做一个最小字符设备：用户态可以 `open()`、`write()`、`read()` 和 `ioctl()`，内核态能收到数据、保存状态并把状态返回给应用层。

## 验证方法

本实验分三步验证。

第一步，在开发环境编译模块：

```bash
make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- \
     KDIR=/path/to/rk3568/kernel
```

如果在 RK3568 板端原生编译，可以直接执行：

```bash
make KDIR=/lib/modules/$(uname -r)/build
```

第二步，加载模块并确认设备节点：

```bash
sudo insmod demo_chrdev.ko
dmesg | tail -n 20
ls -l /dev/demo_chrdev
cat /proc/devices | grep demo_chrdev
```

期望看到类似日志：

```text
demo_chrdev loaded
demo open
recv: hello driver
demo release
```

第三步，运行用户态测试程序：

```bash
gcc test_demo_chrdev.c -o test_demo_chrdev
sudo ./test_demo_chrdev
sudo strace -e openat,read,write,ioctl,close ./test_demo_chrdev
```

如果 `strace` 中能看到 `/dev/demo_chrdev` 被打开，并且 `write/read/ioctl` 返回值正常，就说明用户态到内核态的最小通路已经打通。

## 复盘

这类实验最容易出问题的地方不是 `file_operations` 本身，而是环境和错误路径。

- 内核版本必须匹配。模块用哪个内核源码编出来，就应该加载到对应版本的 RK3568 系统里，否则容易出现 `invalid module format`。
- 用户态指针不能直接在内核态解引用。所有用户态数据拷贝都必须走 `copy_from_user()` 或 `copy_to_user()`。
- `device_create()` 成功之前，不一定会出现 `/dev/demo_chrdev`。如果没有自动创建设备节点，需要检查 `udev/mdev`，或者手动 `mknod`。
- 错误路径必须反向释放资源。`alloc_chrdev_region()`、`cdev_add()`、`class_create()`、`device_create()` 任何一步失败，都要释放前面已经申请的资源。
- 多进程同时访问时需要加锁。本文为了保持最小闭环使用全局缓冲区，真实项目里至少要加 `mutex` 或者为每个打开的文件维护私有上下文。

我后面在 RK3568 车载项目里会把这个模型映射成更实际的接口，例如 `/dev/vehicle_alarm` 或 `/dev/gateway_gpio`：用户态网关通过 `ioctl()` 设置蜂鸣器状态，通过 `read()` 获取按键事件，Qt Dashboard 不直接碰硬件，只调用网关进程提供的状态。

## 字符设备是什么

在 Linux 中，很多设备都可以抽象成文件。用户态通过 `open/read/write/ioctl/close` 访问设备，内核驱动负责实现这些操作。

```text
用户程序
  |
  | open/read/write/ioctl
  v
/dev/demo_chrdev
  |
  v
file_operations
  |
  v
驱动内部数据 / 硬件寄存器 / GPIO / I2C / SPI
```

## 核心数据结构

```c
#include <linux/module.h>
#include <linux/fs.h>
#include <linux/cdev.h>
#include <linux/uaccess.h>

#define DEV_NAME "demo_chrdev"
#define BUF_SIZE 128

static dev_t devno;
static struct cdev demo_cdev;
static struct class *demo_class;
static char kernel_buf[BUF_SIZE];
```

`dev_t` 保存主设备号和次设备号，`cdev` 表示字符设备对象。

## open 和 release

```c
static int demo_open(struct inode *inode, struct file *file)
{
    pr_info("demo open\n");
    return 0;
}

static int demo_release(struct inode *inode, struct file *file)
{
    pr_info("demo release\n");
    return 0;
}
```

实际项目中，`open` 可以做资源初始化、引用计数、互斥检查等。

## read 实现

```c
static ssize_t demo_read(struct file *file, char __user *buf,
                         size_t count, loff_t *ppos)
{
    size_t len = min(count, (size_t)BUF_SIZE);

    if (copy_to_user(buf, kernel_buf, len))
        return -EFAULT;

    return len;
}
```

注意 `copy_to_user()`，内核不能直接访问用户态指针。

## write 实现

```c
static ssize_t demo_write(struct file *file, const char __user *buf,
                          size_t count, loff_t *ppos)
{
    size_t len = min(count, (size_t)(BUF_SIZE - 1));

    memset(kernel_buf, 0, sizeof(kernel_buf));

    if (copy_from_user(kernel_buf, buf, len))
        return -EFAULT;

    pr_info("recv: %s\n", kernel_buf);
    return len;
}
```

实际驱动里，`write` 可以对应控制命令、数据下发、寄存器写入等。

## ioctl 设计

`ioctl` 适合处理不方便用 read/write 表达的控制命令。

```c
#define DEMO_IOC_MAGIC      'd'
#define DEMO_IOC_CLEAR      _IO(DEMO_IOC_MAGIC, 0)
#define DEMO_IOC_SET_VALUE  _IOW(DEMO_IOC_MAGIC, 1, int)
#define DEMO_IOC_GET_VALUE  _IOR(DEMO_IOC_MAGIC, 2, int)

static int demo_value;

static long demo_ioctl(struct file *file, unsigned int cmd, unsigned long arg)
{
    int value;

    switch (cmd) {
    case DEMO_IOC_CLEAR:
        memset(kernel_buf, 0, sizeof(kernel_buf));
        return 0;

    case DEMO_IOC_SET_VALUE:
        if (copy_from_user(&value, (int __user *)arg, sizeof(value)))
            return -EFAULT;
        demo_value = value;
        return 0;

    case DEMO_IOC_GET_VALUE:
        if (copy_to_user((int __user *)arg, &demo_value, sizeof(demo_value)))
            return -EFAULT;
        return 0;

    default:
        return -EINVAL;
    }
}
```

命令号要保持稳定，否则用户态程序和驱动会不兼容。

## 注册 file_operations

```c
static const struct file_operations demo_fops = {
    .owner = THIS_MODULE,
    .open = demo_open,
    .release = demo_release,
    .read = demo_read,
    .write = demo_write,
    .unlocked_ioctl = demo_ioctl,
};
```

## 模块初始化

```c
static int __init demo_init(void)
{
    int ret;

    ret = alloc_chrdev_region(&devno, 0, 1, DEV_NAME);
    if (ret)
        return ret;

    cdev_init(&demo_cdev, &demo_fops);
    demo_cdev.owner = THIS_MODULE;

    ret = cdev_add(&demo_cdev, devno, 1);
    if (ret)
        goto err_unregister;

    demo_class = class_create(DEV_NAME);
    if (IS_ERR(demo_class)) {
        ret = PTR_ERR(demo_class);
        goto err_cdev;
    }

    device_create(demo_class, NULL, devno, NULL, DEV_NAME);
    pr_info("demo_chrdev loaded\n");
    return 0;

err_cdev:
    cdev_del(&demo_cdev);
err_unregister:
    unregister_chrdev_region(devno, 1);
    return ret;
}
```

## 模块退出

```c
static void __exit demo_exit(void)
{
    device_destroy(demo_class, devno);
    class_destroy(demo_class);
    cdev_del(&demo_cdev);
    unregister_chrdev_region(devno, 1);
    pr_info("demo_chrdev unloaded\n");
}

module_init(demo_init);
module_exit(demo_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("XTHBA");
MODULE_DESCRIPTION("Demo character device driver");
```

## 用户态测试

```c
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>

int main(void)
{
    char buf[128] = {0};
    int fd = open("/dev/demo_chrdev", O_RDWR);

    if (fd < 0) {
        perror("open");
        return -1;
    }

    write(fd, "hello driver", strlen("hello driver"));
    read(fd, buf, sizeof(buf));
    printf("read: %s\n", buf);

    close(fd);
    return 0;
}
```

## 调试命令

```bash
make
sudo insmod demo_chrdev.ko
dmesg -w
ls -l /dev/demo_chrdev
sudo ./test_app
sudo rmmod demo_chrdev
```

## 常见坑

- 忘记 `copy_to_user/copy_from_user`，直接解引用用户态指针
- 错误路径没有释放已申请资源
- `class_create/device_create` 失败后没有清理 `cdev`
- ioctl 命令号用户态和内核态不一致
- 多进程访问时没有加锁

## 小结

字符设备驱动最重要的是建立用户态到内核态的通道。掌握这个闭环后，再去看 GPIO、I2C、SPI、platform driver，会更容易理解它们最终如何暴露给应用层。
