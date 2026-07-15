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
&spi1 {
    status = "okay";

    demo_adc@0 {
        compatible = "xthba,demo-adc";
        reg = <0>;
        spi-max-frequency = <10000000>;
        spi-cpol;
        spi-cpha;
    };
};
```

`reg = <0>` 表示片选号 CS0。`spi-cpol/spi-cpha` 对应 SPI mode。

## 私有结构

```c
struct demo_spi {
    struct device *dev;
    struct spi_device *spi;
    struct mutex lock;
};
```

## 基础收发

```c
static int demo_spi_transfer(struct demo_spi *dspi,
                             const void *tx, void *rx, size_t len)
{
    struct spi_transfer xfer = {
        .tx_buf = tx,
        .rx_buf = rx,
        .len = len,
    };

    return spi_sync_transfer(dspi->spi, &xfer, 1);
}
```

`spi_sync_transfer()` 适合简单同步传输。

## 寄存器读写

很多 SPI 设备用最高位区分读写，例如 bit7=1 表示读。

```c
#define REG_READ_FLAG 0x80

static int demo_read_reg(struct demo_spi *dspi, u8 reg, u8 *val)
{
    u8 tx[2] = { reg | REG_READ_FLAG, 0xff };
    u8 rx[2] = { 0 };
    int ret;

    ret = demo_spi_transfer(dspi, tx, rx, sizeof(tx));
    if (ret)
        return ret;

    *val = rx[1];
    return 0;
}

static int demo_write_reg(struct demo_spi *dspi, u8 reg, u8 val)
{
    u8 tx[2] = { reg & ~REG_READ_FLAG, val };

    return demo_spi_transfer(dspi, tx, NULL, sizeof(tx));
}
```

具体协议要以芯片手册为准。

## probe 函数

```c
static int demo_spi_probe(struct spi_device *spi)
{
    struct demo_spi *dspi;
    u8 chip_id;
    int ret;

    dspi = devm_kzalloc(&spi->dev, sizeof(*dspi), GFP_KERNEL);
    if (!dspi)
        return -ENOMEM;

    dspi->dev = &spi->dev;
    dspi->spi = spi;
    mutex_init(&dspi->lock);
    spi_set_drvdata(spi, dspi);

    spi->mode = SPI_MODE_0;
    spi->max_speed_hz = 10000000;
    ret = spi_setup(spi);
    if (ret)
        return ret;

    ret = demo_read_reg(dspi, 0x00, &chip_id);
    if (ret)
        return dev_err_probe(&spi->dev, ret, "failed to read chip id\n");

    dev_info(&spi->dev, "chip id: 0x%02x\n", chip_id);
    return 0;
}
```

## 注册 spi_driver

```c
static const struct of_device_id demo_spi_of_match[] = {
    { .compatible = "xthba,demo-adc" },
    { }
};
MODULE_DEVICE_TABLE(of, demo_spi_of_match);

static struct spi_driver demo_spi_driver = {
    .driver = {
        .name = "demo-adc",
        .of_match_table = demo_spi_of_match,
    },
    .probe = demo_spi_probe,
};

module_spi_driver(demo_spi_driver);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("XTHBA");
MODULE_DESCRIPTION("Demo SPI device driver");
```

## 多段传输

有些设备要求先发命令，再收数据，中间片选保持有效。可以使用 `spi_message`。

```c
static int demo_read_fifo(struct demo_spi *dspi, u8 cmd, u8 *buf, size_t len)
{
    struct spi_message msg;
    struct spi_transfer xfers[2] = {0};

    xfers[0].tx_buf = &cmd;
    xfers[0].len = 1;
    xfers[1].rx_buf = buf;
    xfers[1].len = len;

    spi_message_init(&msg);
    spi_message_add_tail(&xfers[0], &msg);
    spi_message_add_tail(&xfers[1], &msg);

    return spi_sync(dspi->spi, &msg);
}
```

## 调试命令

```bash
ls /sys/bus/spi/devices/
dmesg -w
```

如果临时用 spidev：

```bash
ls /dev/spidev*
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
