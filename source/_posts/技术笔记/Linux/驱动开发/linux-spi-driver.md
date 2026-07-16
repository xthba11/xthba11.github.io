---
title: Linux 驱动开发：SPI 设备驱动与同步传输
date: 2026-05-11
categories:
  - 技术笔记
  - Linux
  - 驱动开发
tags:
  - Linux
  - SPI
  - 设备驱动
  - 传感器驱动
  - C语言
description: SPI 设备驱动学习：设备树、spi_driver、spi_sync、片选、mode、speed 和寄存器读写。
top_img: /img/embedded-lab-hero.png
---

SPI 常用于高速或中速外设，例如 Flash、ADC、显示屏、无线模块和部分传感器。相比 I2C，SPI 没有设备地址，依赖片选信号区分设备。

Linux 下 SPI 设备驱动通常实现为 `spi_driver`。

## 设备树示例

```dts
// SPI从设备节点：挂接在spi1控制器上，片选CS0
&spi1 {
    status = "okay";  // 使能SPI控制器

    demo_adc@0 {
        compatible = "xthba,demo-adc";         // 驱动匹配关键字
        reg = <0>;                             // 片选号CS0
        spi-max-frequency = <10000000>;        // 最大SPI时钟频率，10MHz
        spi-cpol;                              // 时钟极性：空闲时为高（CPOL=1）
        spi-cpha;                              // 时钟相位：第二个边沿采样（CPHA=1）
    };
};
```

`reg = <0>` 表示片选号 CS0。`spi-cpol/spi-cpha` 对应 SPI mode。

## 私有结构

```c
// 驱动私有数据结构：保存SPI设备句柄和同步锁
struct demo_spi {
    struct device *dev;        // 指向设备结构体，方便打印日志
    struct spi_device *spi;    // SPI从设备，用于收发操作
    struct mutex lock;         // 互斥锁，保护SPI传输的原子性
};
```

## 基础收发

```c
// SPI底层传输函数：封装spi_sync_transfer，简化单次半双工传输
static int demo_spi_transfer(struct demo_spi *dspi,
                             const void *tx, void *rx, size_t len)
{
    // spi_transfer描述单次SPI传输：同时指定发送和接收缓冲区
    struct spi_transfer xfer = {
        .tx_buf = tx,   // 发送缓冲区（可为NULL表示只收不发）
        .rx_buf = rx,   // 接收缓冲区（可为NULL表示只发不收）
        .len = len,     // 传输字节数
    };

    // 同步传输：阻塞直到传输完成，片选在传输期间保持有效
    return spi_sync_transfer(dspi->spi, &xfer, 1);
}
```

`spi_sync_transfer()` 适合简单同步传输。

## 寄存器读写

很多 SPI 设备用最高位区分读写，例如 bit7=1 表示读。

```c
#define REG_READ_FLAG 0x80   // 寄存器读写标志位：bit7=1表示读，=0表示写

// 读单个寄存器：发送（寄存器地址|读标志），再接收从机返回的寄存器值
static int demo_read_reg(struct demo_spi *dspi, u8 reg, u8 *val)
{
    // tx[0]为命令字节（bit7置1表示读），tx[1]为dummy字节供从机返回数据
    u8 tx[2] = { reg | REG_READ_FLAG, 0xff };
    u8 rx[2] = { 0 };
    int ret;

    // 全双工传输：同时收发2字节
    ret = demo_spi_transfer(dspi, tx, rx, sizeof(tx));
    if (ret)
        return ret;

    *val = rx[1];  // 第二个字节为从机返回的寄存器值
    return 0;
}

// 写单个寄存器：发送（寄存器地址|写标志）和数据
static int demo_write_reg(struct demo_spi *dspi, u8 reg, u8 val)
{
    // tx[0]为命令字节（bit7清零表示写），tx[1]为要写入的数据
    u8 tx[2] = { reg & ~REG_READ_FLAG, val };

    // 只发不收，rx设为NULL
    return demo_spi_transfer(dspi, tx, NULL, sizeof(tx));
}
```

具体协议要以芯片手册为准。

## probe 函数

```c
// probe函数：SPI设备匹配后调用，初始化硬件并验证芯片存在
static int demo_spi_probe(struct spi_device *spi)
{
    struct demo_spi *dspi;
    u8 chip_id;
    int ret;

    // 分配私有数据结构（devm版本，设备释放时自动回收）
    dspi = devm_kzalloc(&spi->dev, sizeof(*dspi), GFP_KERNEL);
    if (!dspi)
        return -ENOMEM;

    dspi->dev = &spi->dev;
    dspi->spi = spi;
    mutex_init(&dspi->lock);        // 初始化互斥锁
    spi_set_drvdata(spi, dspi);     // 保存私有数据到spi_device，供后续取出

    // 配置SPI模式和最大速度（可被设备树属性覆盖）
    spi->mode = SPI_MODE_0;         // CPOL=0, CPHA=0
    spi->max_speed_hz = 10000000;   // 10MHz
    ret = spi_setup(spi);           // 应用配置到SPI控制器
    if (ret)
        return ret;

    // 读取芯片ID寄存器（地址0x00），验证硬件通信正常
    ret = demo_read_reg(dspi, 0x00, &chip_id);
    if (ret)
        return dev_err_probe(&spi->dev, ret, "failed to read chip id\n");

    dev_info(&spi->dev, "chip id: 0x%02x\n", chip_id);
    return 0;
}
```

## 注册 spi_driver

```c
// 设备树匹配表：告诉内核此驱动能处理哪些compatible的设备
static const struct of_device_id demo_spi_of_match[] = {
    { .compatible = "xthba,demo-adc" },  // 与设备树compatible精确匹配
    { }  // 哨兵项，必须保留
};
MODULE_DEVICE_TABLE(of, demo_spi_of_match);  // 导出到用户空间，使modprobe能自动加载

// spi_driver结构体：将probe和of_match_table绑定在一起
static struct spi_driver demo_spi_driver = {
    .driver = {
        .name = "demo-adc",                  // 驱动名称
        .of_match_table = demo_spi_of_match, // 指向匹配表
    },
    .probe = demo_spi_probe,  // 设备匹配成功后的回调
};

// 封装module_spi_register/unregister，自动处理模块的注册与注销
module_spi_driver(demo_spi_driver);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("XTHBA");
MODULE_DESCRIPTION("Demo SPI device driver");
```

## 多段传输

有些设备要求先发命令，再收数据，中间片选保持有效。可以使用 `spi_message`。

```c
// 多段SPI传输：先发命令再收数据，片选在整条message期间保持有效
static int demo_read_fifo(struct demo_spi *dspi, u8 cmd, u8 *buf, size_t len)
{
    struct spi_message msg;
    struct spi_transfer xfers[2] = {0};

    // 第一阶段：发送命令字节
    xfers[0].tx_buf = &cmd;
    xfers[0].len = 1;
    // 第二阶段：接收数据
    xfers[1].rx_buf = buf;
    xfers[1].len = len;

    // 构建spi_message，将两个transfer按顺序串联
    spi_message_init(&msg);
    spi_message_add_tail(&xfers[0], &msg);  // 最先执行：发命令
    spi_message_add_tail(&xfers[1], &msg);  // 然后执行：收数据

    // 同步发送整条message，CS在两段传输之间保持选中
    return spi_sync(dspi->spi, &msg);
}
```

## 调试命令

```bash
# 查看已注册的SPI设备列表
ls /sys/bus/spi/devices/
# 实时查看内核日志
dmesg -w
```

如果临时用 spidev：

```bash
# 查看spidev字符设备节点（用户态SPI测试接口）
ls /dev/spidev*
# 使用spidev_test工具测试SPI通信：设备/dev/spidev1.0，速度1MHz
spidev_test -D /dev/spidev1.0 -s 1000000
```

逻辑分析仪对 SPI 调试非常有用，可以直接看 CPOL/CPHA、CS、MOSI、MISO 是否符合预期。

## 常见坑

- SPI mode 配错，导致数据整体错位
- max speed 过高，波形质量差
- CS 极性不对
- 命令和数据阶段片选没有保持
- tx/rx buffer 生命周期不正确
- 多线程访问没有加锁

## 小结

SPI 驱动的关键是把设备手册里的时序转换成 `spi_transfer`。先用低速、单字节读 chip id 建立最小闭环，再逐步加入批量读写、中断和上层接口。
