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

本文以一个简单的 `demo_chrdev` 为例，建立最小闭环。

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
