---
title: Linux 驱动开发：I2C Client 驱动框架
date: 2026-05-10
categories:
  - 技术笔记
  - Linux
  - 驱动开发
tags:
  - Linux
  - I2C
  - 传感器驱动
  - regmap
  - C语言
description: I2C client 驱动学习：设备树描述、probe、寄存器读写、regmap 和传感器数据读取。
top_img: /img/embedded-lab-hero.png
---

I2C 是嵌入式 Linux 中最常见的低速外设总线之一。温湿度传感器、RTC、触摸芯片、电源管理芯片、EEPROM 都经常挂在 I2C 上。

Linux I2C 驱动一般分为 adapter 驱动和 client 驱动。作为板级开发者，更多时候写的是 client 驱动。

## 设备树节点

```dts
&i2c1 {
    status = "okay";

    demo_sensor@48 {
        compatible = "xthba,demo-sensor";
        reg = <0x48>;
    };
};
```

`reg = <0x48>` 表示 I2C 从设备地址。

## 驱动匹配表

```c
static const struct of_device_id demo_sensor_of_match[] = {
    { .compatible = "xthba,demo-sensor" },
    { }
};
MODULE_DEVICE_TABLE(of, demo_sensor_of_match);
```

I2C ID 表：

```c
static const struct i2c_device_id demo_sensor_id[] = {
    { "demo-sensor", 0 },
    { }
};
MODULE_DEVICE_TABLE(i2c, demo_sensor_id);
```

## 私有结构

```c
struct demo_sensor {
    struct device *dev;
    struct i2c_client *client;
    struct mutex lock;
};
```

## 基础寄存器读写

```c
static int demo_read_reg(struct demo_sensor *sensor, u8 reg)
{
    return i2c_smbus_read_byte_data(sensor->client, reg);
}

static int demo_write_reg(struct demo_sensor *sensor, u8 reg, u8 val)
{
    return i2c_smbus_write_byte_data(sensor->client, reg, val);
}
```

如果设备支持多字节读取：

```c
static int demo_read_block(struct demo_sensor *sensor, u8 reg, u8 *buf, int len)
{
    return i2c_smbus_read_i2c_block_data(sensor->client, reg, len, buf);
}
```

## probe 函数

```c
static int demo_sensor_probe(struct i2c_client *client)
{
    struct demo_sensor *sensor;
    int id;

    sensor = devm_kzalloc(&client->dev, sizeof(*sensor), GFP_KERNEL);
    if (!sensor)
        return -ENOMEM;

    sensor->dev = &client->dev;
    sensor->client = client;
    mutex_init(&sensor->lock);

    i2c_set_clientdata(client, sensor);

    id = demo_read_reg(sensor, 0x00);
    if (id < 0)
        return dev_err_probe(&client->dev, id, "failed to read chip id\n");

    dev_info(&client->dev, "chip id: 0x%02x\n", id);
    return 0;
}
```

## remove 函数

```c
static void demo_sensor_remove(struct i2c_client *client)
{
    struct demo_sensor *sensor = i2c_get_clientdata(client);

    dev_info(sensor->dev, "demo sensor removed\n");
}
```

## 注册 i2c_driver

```c
static struct i2c_driver demo_sensor_driver = {
    .driver = {
        .name = "demo-sensor",
        .of_match_table = demo_sensor_of_match,
    },
    .probe = demo_sensor_probe,
    .remove = demo_sensor_remove,
    .id_table = demo_sensor_id,
};

module_i2c_driver(demo_sensor_driver);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("XTHBA");
MODULE_DESCRIPTION("Demo I2C sensor driver");
```

## 使用 regmap

复杂芯片建议用 regmap 管理寄存器。

```c
static const struct regmap_config demo_regmap_config = {
    .reg_bits = 8,
    .val_bits = 8,
};
```

probe 中初始化：

```c
sensor->regmap = devm_regmap_init_i2c(client, &demo_regmap_config);
if (IS_ERR(sensor->regmap))
    return PTR_ERR(sensor->regmap);
```

读取：

```c
unsigned int val;
regmap_read(sensor->regmap, 0x00, &val);
```

regmap 的好处是统一缓存、锁、调试和不同总线抽象。

## 调试命令

```bash
i2cdetect -y 1
i2cdump -y 1 0x48
i2cget -y 1 0x48 0x00
i2cset -y 1 0x48 0x01 0x80
```

查看设备：

```bash
ls /sys/bus/i2c/devices/
dmesg -w
```

## 常见坑

- 设备树挂错 I2C 控制器
- `reg` 地址写错，7-bit 地址和 8-bit 地址混淆
- 上拉电阻缺失或电平不匹配
- 读写时序不符合芯片手册
- probe 中没有检查 chip id
- 多线程读写寄存器没有加锁

## 小结

I2C client 驱动的关键路径是：设备树描述地址，probe 中初始化私有数据，封装寄存器读写，再向上暴露传感器数据或控制接口。掌握这个框架后，移植大多数 I2C 外设都会有清晰套路。
