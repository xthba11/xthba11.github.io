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
cover: /img/covers/articles/linux-i2c-client-driver.svg
top_img: /img/covers/articles/linux-i2c-client-driver.svg
---

I2C 是嵌入式 Linux 中最常见的低速外设总线之一。温湿度传感器、RTC、触摸芯片、电源管理芯片、EEPROM 都经常挂在 I2C 上。

Linux I2C 驱动一般分为 adapter 驱动和 client 驱动。作为板级开发者，更多时候写的是 client 驱动。

## 设备树节点

```dts
&i2c1 {                          // 引用 I2C1 控制器节点
    status = "okay";             // 使能该 I2C 控制器

    demo_sensor@48 {             // 从设备节点，@后为 I2C 从地址
        compatible = "xthba,demo-sensor"; // 与驱动 of_match_table 匹配的字符串
        reg = <0x48>;            // 7-bit I2C 从设备地址
    };
};
```

`reg = <0x48>` 表示 I2C 从设备地址。

## 驱动匹配表

```c
// 设备树匹配表：内核根据 compatible 属性查找对应驱动
static const struct of_device_id demo_sensor_of_match[] = {
    { .compatible = "xthba,demo-sensor" }, // 匹配 dts 中的 compatible 字符串
    { }                                     // 哨兵条目，表示数组结束
};
MODULE_DEVICE_TABLE(of, demo_sensor_of_match); // 导出到用户空间，用于模块自动加载
```

I2C ID 表：

```c
// I2C 传统 ID 匹配表：用于非设备树场景（如板级文件中注册的 i2c_board_info）
static const struct i2c_device_id demo_sensor_id[] = {
    { "demo-sensor", 0 },  // "demo-sensor" 为设备名，0 为 driver_data
    { }                     // 哨兵条目
};
MODULE_DEVICE_TABLE(i2c, demo_sensor_id); // 导出 I2C 模块别名
```

## 私有结构

```c
// 驱动私有数据结构：保存设备运行期所需的所有信息
struct demo_sensor {
    struct device *dev;        // 内核设备对象指针
    struct i2c_client *client; // I2C 客户端句柄，用于后续读写操作
    struct mutex lock;         // 互斥锁，保护多线程并发访问
};
```

## 基础寄存器读写

```c
// 单字节寄存器读取：向设备发送 reg 地址，读回 1 字节数据
static int demo_read_reg(struct demo_sensor *sensor, u8 reg)
{
    // SMBus 字节读：先写寄存器地址，再读一字节数据
    return i2c_smbus_read_byte_data(sensor->client, reg);
}

// 单字节寄存器写入：向设备的 reg 地址写入 1 字节 val
static int demo_write_reg(struct demo_sensor *sensor, u8 reg, u8 val)
{
    // SMBus 字节写：写寄存器地址 + 数据，返回值 < 0 表示错误
    return i2c_smbus_write_byte_data(sensor->client, reg, val);
}
```

如果设备支持多字节读取：

```c
// 多字节寄存器块读取：从 reg 起始地址连续读取 len 字节到 buf
static int demo_read_block(struct demo_sensor *sensor, u8 reg, u8 *buf, int len)
{
    // I2C 块读：适用于连续寄存器（如 FIFO 或 multi-byte 传感器值）
    return i2c_smbus_read_i2c_block_data(sensor->client, reg, len, buf);
}
```

## probe 函数

```c
// probe 函数：设备匹配成功后内核调用，负责初始化硬件和软件资源
static int demo_sensor_probe(struct i2c_client *client)
{
    struct demo_sensor *sensor;
    int id;

    // devm 托管内存分配：驱动卸载时自动释放，无需手动 kfree
    sensor = devm_kzalloc(&client->dev, sizeof(*sensor), GFP_KERNEL);
    if (!sensor)
        return -ENOMEM; // 内存不足

    sensor->dev = &client->dev;       // 保存 device 指针，方便后续 dev_xxx 打印
    sensor->client = client;           // 保存 I2C client，用于寄存器读写
    mutex_init(&sensor->lock);         // 初始化互斥锁

    // 将私有数据存入 client->dev->driver_data，供 remove / suspend 等回调取出
    i2c_set_clientdata(client, sensor);

    // 读取芯片 ID 寄存器（地址 0x00），验证设备是否存在
    id = demo_read_reg(sensor, 0x00);
    if (id < 0)
        // dev_err_probe：EPROBE_DEFER 时不打印错误，其他错误则打印日志并返回
        return dev_err_probe(&client->dev, id, "failed to read chip id\n");

    dev_info(&client->dev, "chip id: 0x%02x\n", id);
    return 0;
}
```

## remove 函数

```c
// remove 函数：设备卸载或驱动移除时调用，负责清理资源
static void demo_sensor_remove(struct i2c_client *client)
{
    // 从 client 中取回 probe 时保存的私有数据
    struct demo_sensor *sensor = i2c_get_clientdata(client);

    // devm 分配的内存和 regmap 会自动释放，这里仅做日志记录
    dev_info(sensor->dev, "demo sensor removed\n");
}
```

## 注册 i2c_driver

```c
// i2c_driver 结构体：将各个回调函数和匹配表注册到 I2C 子系统
static struct i2c_driver demo_sensor_driver = {
    .driver = {
        .name = "demo-sensor",                  // 驱动名称，出现在 /sys/bus/i2c/drivers/ 下
        .of_match_table = demo_sensor_of_match, // 设备树匹配表
    },
    .probe    = demo_sensor_probe,              // 设备匹配成功后的初始化函数
    .remove   = demo_sensor_remove,             // 设备移除时的清理函数
    .id_table = demo_sensor_id,                 // 传统 I2C ID 匹配表
};

// 便捷宏：展开为 module_init 和 module_exit，自动注册/注销 i2c_driver
module_i2c_driver(demo_sensor_driver);

MODULE_LICENSE("GPL");                           // 许可证类型
MODULE_AUTHOR("XTHBA");                          // 作者信息
MODULE_DESCRIPTION("Demo I2C sensor driver");    // 驱动描述
```

## 使用 regmap

复杂芯片建议用 regmap 管理寄存器。

```c
// regmap 配置：描述设备寄存器地址和数据的位宽
static const struct regmap_config demo_regmap_config = {
    .reg_bits = 8,  // 寄存器地址宽度 8-bit（最多 256 个寄存器）
    .val_bits = 8,  // 寄存器数据宽度 8-bit（每个寄存器 1 字节）
};
```

probe 中初始化：

```c
// devm 托管方式创建 regmap：基于 I2C 总线，驱动卸载时自动释放
sensor->regmap = devm_regmap_init_i2c(client, &demo_regmap_config);
if (IS_ERR(sensor->regmap))                  // 检查返回值是否为错误指针
    return PTR_ERR(sensor->regmap);          // 返回具体错误码
```

读取：

```c
// 使用 regmap 读寄存器：自动处理缓存、锁和总线传输
unsigned int val;
regmap_read(sensor->regmap, 0x00, &val); // 读寄存器 0x00，值存入 val
```

regmap 的好处是统一缓存、锁、调试和不同总线抽象。

## 调试命令

```bash
# 扫描 I2C-1 总线上的所有从设备，显示地址表（-y 跳过确认）
i2cdetect -y 1
# 导出 I2C-1 总线上 0x48 设备的所有寄存器内容
i2cdump -y 1 0x48
# 读取 I2C-1 总线上 0x48 设备的 0x00 寄存器
i2cget -y 1 0x48 0x00
# 向 I2C-1 总线上 0x48 设备的 0x01 寄存器写入 0x80
i2cset -y 1 0x48 0x01 0x80
```

查看设备：

```bash
# 列出所有已注册的 I2C 设备
ls /sys/bus/i2c/devices/
# 实时查看内核日志（含驱动 probe 输出）
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
