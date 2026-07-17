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
cover: /img/covers/articles/linux-character-device-driver.svg
top_img: /img/covers/articles/linux-character-device-driver.svg
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
uname -a                           # 查看内核版本和架构信息
cat /proc/version                  # 确认内核编译信息
gcc --version                      # 确认编译器版本
ls /lib/modules/$(uname -r)/build  # 检查内核头文件是否存在（模块编译依赖）
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
# 交叉编译：指定 ARM64 架构和 RK3568 内核源码路径
make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- \
     KDIR=/path/to/rk3568/kernel
```

如果在 RK3568 板端原生编译，可以直接执行：

```bash
# 原生编译（在 RK3568 板端直接用板端内核头文件）
make KDIR=/lib/modules/$(uname -r)/build
```

第二步，加载模块并确认设备节点：

```bash
sudo insmod demo_chrdev.ko                  # 加载内核模块
dmesg | tail -n 20                          # 查看最近20条内核日志
ls -l /dev/demo_chrdev                      # 确认设备节点已自动创建
cat /proc/devices | grep demo_chrdev        # 查看已注册的设备号
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
gcc test_demo_chrdev.c -o test_demo_chrdev                          # 编译用户态测试程序
sudo ./test_demo_chrdev                                              # 以 root 权限运行（需要访问 /dev/）
sudo strace -e openat,read,write,ioctl,close ./test_demo_chrdev     # 追踪系统调用，验证内核通路
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
#include <linux/module.h>    // 内核模块基础头文件
#include <linux/fs.h>         // file_operations 结构体
#include <linux/cdev.h>       // cdev 字符设备相关 API
#include <linux/uaccess.h>    // copy_to_user / copy_from_user

#define DEV_NAME "demo_chrdev"  // 设备名称，出现在 /dev/ 下
#define BUF_SIZE 128            // 内核缓冲区大小

static dev_t devno;              // 设备号（主设备号 + 次设备号）
static struct cdev demo_cdev;    // 字符设备对象，关联 file_operations
static struct class *demo_class; // 设备类，用于自动创建 /dev 节点
static char kernel_buf[BUF_SIZE]; // 内核态数据缓冲区，用户态通过 read/write 访问
```

`dev_t` 保存主设备号和次设备号，`cdev` 表示字符设备对象。

## open 和 release

```c
// open：用户态 open("/dev/demo_chrdev") 时调用
// 可用于资源初始化、引用计数、互斥检查等
static int demo_open(struct inode *inode, struct file *file)
{
    pr_info("demo open\n");
    return 0;
}

// release：用户态 close(fd) 时调用
// 对应 open 中申请的资源在此释放
static int demo_release(struct inode *inode, struct file *file)
{
    pr_info("demo release\n");
    return 0;
}
```

实际项目中，`open` 可以做资源初始化、引用计数、互斥检查等。

## read 实现

```c
// read：用户态 read(fd, buf, count) 时调用
// 将内核缓冲区数据拷贝到用户态
static ssize_t demo_read(struct file *file, char __user *buf,
                         size_t count, loff_t *ppos)
{
    // 限制拷贝长度，不超过缓冲区大小
    size_t len = min(count, (size_t)BUF_SIZE);

    // copy_to_user：内核 → 用户态，绝不能直接访问 buf 指针
    if (copy_to_user(buf, kernel_buf, len))
        return -EFAULT;  // 拷贝失败返回错误

    return len;  // 返回实际拷贝字节数
}
```

注意 `copy_to_user()`，内核不能直接访问用户态指针。

## write 实现

```c
// write：用户态 write(fd, buf, count) 时调用
// 将用户态数据拷贝到内核缓冲区
static ssize_t demo_write(struct file *file, const char __user *buf,
                          size_t count, loff_t *ppos)
{
    // 限制长度，保留一个字节给 '\0' 防止溢出
    size_t len = min(count, (size_t)(BUF_SIZE - 1));

    memset(kernel_buf, 0, sizeof(kernel_buf));  // 清空旧数据

    // copy_from_user：用户态 → 内核，绝不能直接解引用 buf
    if (copy_from_user(kernel_buf, buf, len))
        return -EFAULT;

    pr_info("recv: %s\n", kernel_buf);
    return len;  // 返回实际写入字节数
}
```

实际驱动里，`write` 可以对应控制命令、数据下发、寄存器写入等。

## ioctl 设计

`ioctl` 适合处理不方便用 read/write 表达的控制命令。

```c
// ioctl 命令号定义：magic='d' 区分不同驱动，避免冲突
#define DEMO_IOC_MAGIC      'd'
#define DEMO_IOC_CLEAR      _IO(DEMO_IOC_MAGIC, 0)     // 无参数命令：清空缓冲区
#define DEMO_IOC_SET_VALUE  _IOW(DEMO_IOC_MAGIC, 1, int) // 写参数：设置内部值
#define DEMO_IOC_GET_VALUE  _IOR(DEMO_IOC_MAGIC, 2, int) // 读参数：获取内部值

static int demo_value;  // ioctl 操作的内部状态变量

// unlocked_ioctl：处理用户态 ioctl(fd, cmd, arg) 请求
static long demo_ioctl(struct file *file, unsigned int cmd, unsigned long arg)
{
    int value;

    switch (cmd) {
    case DEMO_IOC_CLEAR:
        memset(kernel_buf, 0, sizeof(kernel_buf));
        return 0;

    case DEMO_IOC_SET_VALUE:
        // arg 是用户态指针，必须用 copy_from_user
        if (copy_from_user(&value, (int __user *)arg, sizeof(value)))
            return -EFAULT;
        demo_value = value;
        return 0;

    case DEMO_IOC_GET_VALUE:
        // 将内核变量拷贝回用户态
        if (copy_to_user((int __user *)arg, &demo_value, sizeof(demo_value)))
            return -EFAULT;
        return 0;

    default:
        return -EINVAL;  // 未知命令，返回无效参数错误
    }
}
```

命令号要保持稳定，否则用户态程序和驱动会不兼容。

## 注册 file_operations

```c
// file_operations：字符设备的核心，将用户态系统调用映射到驱动函数
static const struct file_operations demo_fops = {
    .owner = THIS_MODULE,       // 模块引用计数，防止使用时卸载模块
    .open = demo_open,          // open() 系统调用 → demo_open()
    .release = demo_release,    // close() 系统调用 → demo_release()
    .read = demo_read,          // read() 系统调用 → demo_read()
    .write = demo_write,        // write() 系统调用 → demo_write()
    .unlocked_ioctl = demo_ioctl, // ioctl() 系统调用 → demo_ioctl()
};
```

## 模块初始化

```c
// __init：模块初始化函数，insmod 时自动调用
// 按顺序申请资源：设备号 → cdev → class → device 节点
static int __init demo_init(void)
{
    int ret;

    // 1. 动态分配设备号（主设备号 + 次设备号）
    ret = alloc_chrdev_region(&devno, 0, 1, DEV_NAME);
    if (ret)
        return ret;

    // 2. 初始化 cdev 并绑定 file_operations
    cdev_init(&demo_cdev, &demo_fops);
    demo_cdev.owner = THIS_MODULE;  // 模块所有者

    // 3. 向内核注册 cdev
    ret = cdev_add(&demo_cdev, devno, 1);
    if (ret)
        goto err_unregister;  // 失败则跳转释放设备号

    // 4. 创建设备类（/sys/class/ 下可见）
    demo_class = class_create(DEV_NAME);
    if (IS_ERR(demo_class)) {
        ret = PTR_ERR(demo_class);
        goto err_cdev;  // 失败则跳转删除 cdev
    }

    // 5. 自动创建设备节点 /dev/demo_chrdev
    device_create(demo_class, NULL, devno, NULL, DEV_NAME);
    pr_info("demo_chrdev loaded\n");
    return 0;

err_cdev:
    cdev_del(&demo_cdev);                  // 回滚第3步
err_unregister:
    unregister_chrdev_region(devno, 1);    // 回滚第1步
    return ret;
}
```

## 模块退出

```c
// __exit：模块卸载函数，rmmod 时自动调用
// 释放顺序与 init 相反（后申请的先释放）
static void __exit demo_exit(void)
{
    device_destroy(demo_class, devno);          // 5. 删除设备节点
    class_destroy(demo_class);                  // 4. 销毁设备类
    cdev_del(&demo_cdev);                       // 3. 注销 cdev
    unregister_chrdev_region(devno, 1);         // 1. 释放设备号
    pr_info("demo_chrdev unloaded\n");
}

module_init(demo_init);   // 指定模块入口函数
module_exit(demo_exit);   // 指定模块出口函数

MODULE_LICENSE("GPL");
MODULE_AUTHOR("XTHBA");
MODULE_DESCRIPTION("Demo character device driver");
```

## 用户态测试

```c
#include <stdio.h>
#include <fcntl.h>      // open() 的 O_RDWR 等标志
#include <unistd.h>     // read() / write() / close()
#include <string.h>

// 用户态测试程序：验证字符设备驱动的最小闭环
int main(void)
{
    char buf[128] = {0};
    int fd = open("/dev/demo_chrdev", O_RDWR);  // 触发 demo_open()

    if (fd < 0) {
        perror("open");
        return -1;
    }

    write(fd, "hello driver", strlen("hello driver")); // 触发 demo_write()
    read(fd, buf, sizeof(buf));                         // 触发 demo_read()
    printf("read: %s\n", buf);

    close(fd);  // 触发 demo_release()
    return 0;
}
```

## 调试命令

```bash
make                                  # 编译内核模块
sudo insmod demo_chrdev.ko            # 插入模块（触发 demo_init）
dmesg -w                              # 实时查看内核日志
ls -l /dev/demo_chrdev                # 确认设备节点已创建
sudo ./test_app                       # 运行用户态测试程序
sudo rmmod demo_chrdev                # 卸载模块（触发 demo_exit）
```

## 常见坑

- 忘记 `copy_to_user/copy_from_user`，直接解引用用户态指针
- 错误路径没有释放已申请资源
- `class_create/device_create` 失败后没有清理 `cdev`
- ioctl 命令号用户态和内核态不一致
- 多进程访问时没有加锁

## 小结

字符设备驱动最重要的是建立用户态到内核态的通道。掌握这个闭环后，再去看 GPIO、I2C、SPI、platform driver，会更容易理解它们最终如何暴露给应用层。
