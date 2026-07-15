---
title: Linux 驱动开发：platform driver 与设备树入门
date: 2026-05-08
categories:
  - 技术笔记
  - Linux
  - 驱动开发
tags:
  - Linux
  - 驱动开发
  - platform driver
  - 设备树
  - C语言
description: platform driver 和设备树的最小闭环：compatible 匹配、probe/remove、资源获取和驱动调试。
top_img: /img/embedded-lab-hero.png
---

在嵌入式 Linux 中，很多片上外设都不是通过 USB/PCI 这类可枚举总线发现的，而是由板级描述告诉内核：这里有一个设备、寄存器地址是多少、中断号是多少、GPIO 接在哪里。

这个板级描述通常就是设备树，驱动侧常见模型就是 platform driver。

## platform driver 解决什么

platform driver 主要用于描述 SoC 内部或板级固定设备，例如：

- GPIO LED
- 按键
- PWM 蜂鸣器
- 自定义寄存器外设
- FPGA 映射寄存器
- 片上控制器

它的核心是匹配：

```text
设备树节点 compatible
        |
        v
platform_driver.of_match_table
        |
        v
probe()
```

## 设备树节点示例

```dts
demo_led: demo-led {
    compatible = "xthba,demo-led";
    led-gpios = <&gpio1 3 GPIO_ACTIVE_LOW>;
    status = "okay";
};
```

这里最重要的是 `compatible`。驱动会用它判断是否匹配这个设备。

## 驱动匹配表

```c
static const struct of_device_id demo_led_of_match[] = {
    { .compatible = "xthba,demo-led" },
    { }
};
MODULE_DEVICE_TABLE(of, demo_led_of_match);
```

## 私有数据结构

```c
struct demo_led {
    struct device *dev;
    struct gpio_desc *led_gpio;
};
```

驱动里建议把设备相关资源放到私有结构中，再通过 `platform_set_drvdata()` 保存。

## probe 函数

```c
static int demo_led_probe(struct platform_device *pdev)
{
    struct demo_led *led;

    led = devm_kzalloc(&pdev->dev, sizeof(*led), GFP_KERNEL);
    if (!led)
        return -ENOMEM;

    led->dev = &pdev->dev;

    led->led_gpio = devm_gpiod_get(&pdev->dev, "led", GPIOD_OUT_LOW);
    if (IS_ERR(led->led_gpio))
        return dev_err_probe(&pdev->dev, PTR_ERR(led->led_gpio),
                             "failed to get led gpio\n");

    platform_set_drvdata(pdev, led);
    dev_info(&pdev->dev, "demo led probed\n");
    return 0;
}
```

`devm_` 系列 API 的好处是设备释放时资源会自动清理，错误路径更简单。

## remove 函数

```c
static int demo_led_remove(struct platform_device *pdev)
{
    struct demo_led *led = platform_get_drvdata(pdev);

    gpiod_set_value(led->led_gpio, 0);
    dev_info(&pdev->dev, "demo led removed\n");
    return 0;
}
```

## 注册 platform_driver

```c
static struct platform_driver demo_led_driver = {
    .probe = demo_led_probe,
    .remove = demo_led_remove,
    .driver = {
        .name = "demo-led",
        .of_match_table = demo_led_of_match,
    },
};

module_platform_driver(demo_led_driver);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("XTHBA");
MODULE_DESCRIPTION("Demo platform driver with device tree");
```

## 常见资源获取

### 获取 GPIO

```c
struct gpio_desc *reset_gpio;

reset_gpio = devm_gpiod_get_optional(&pdev->dev, "reset", GPIOD_OUT_LOW);
if (IS_ERR(reset_gpio))
    return PTR_ERR(reset_gpio);
```

设备树中对应属性名是 `reset-gpios`。

### 获取中断

```c
int irq;

irq = platform_get_irq(pdev, 0);
if (irq < 0)
    return irq;
```

### 获取寄存器资源

```c
void __iomem *base;

base = devm_platform_ioremap_resource(pdev, 0);
if (IS_ERR(base))
    return PTR_ERR(base);
```

设备树中对应 `reg` 属性。

## 调试方法

查看设备树节点：

```bash
ls /proc/device-tree/
find /proc/device-tree -name '*demo*'
```

查看驱动绑定：

```bash
ls /sys/bus/platform/drivers/
ls /sys/bus/platform/devices/
```

查看内核日志：

```bash
dmesg -w
```

## 常见坑

- `compatible` 字符串设备树和驱动不一致
- 设备树属性名写错，比如驱动取 `led`，节点却写成 `led_gpio`
- GPIO 极性没有用 `GPIO_ACTIVE_LOW/HIGH` 表达清楚
- probe 失败但日志不详细
- 没有开启对应内核配置

## 小结

platform driver 和设备树是嵌入式 Linux 驱动开发的入口。先把 `compatible -> probe -> 获取资源 -> 控制硬件` 这个闭环跑通，再去扩展字符设备、sysfs、input、I2C、SPI 等框架会更顺。
