---
title: Linux 驱动开发：GPIO 子系统与 LED/按键驱动
date: 2026-05-09
categories:
  - 技术笔记
  - Linux
  - 驱动开发
tags:
  - Linux
  - GPIO
  - LED驱动
  - 按键驱动
  - C语言
description: Linux GPIO 子系统学习：gpiod API、LED 控制、按键输入、中断和消抖处理。
top_img: /img/embedded-lab-hero.png
---

GPIO 是嵌入式 Linux 驱动开发中最常接触的资源。LED、按键、复位脚、片选脚、电源使能脚，本质上都离不开 GPIO。

新内核推荐使用 descriptor-based GPIO API，也就是 `gpiod_*` 系列接口。

## 设备树示例

```dts
demo-gpio {
    compatible = "xthba,demo-gpio";
    led-gpios = <&gpio1 3 GPIO_ACTIVE_LOW>;
    key-gpios = <&gpio1 4 GPIO_ACTIVE_LOW>;
    status = "okay";
};
```

驱动中使用 `"led"` 获取 `led-gpios`，使用 `"key"` 获取 `key-gpios`。

## 私有结构

```c
struct demo_gpio {
    struct device *dev;
    struct gpio_desc *led;
    struct gpio_desc *key;
    int key_irq;
    struct timer_list debounce_timer;
};
```

## 获取 GPIO

```c
static int demo_gpio_probe(struct platform_device *pdev)
{
    struct demo_gpio *dgpio;

    dgpio = devm_kzalloc(&pdev->dev, sizeof(*dgpio), GFP_KERNEL);
    if (!dgpio)
        return -ENOMEM;

    dgpio->dev = &pdev->dev;

    dgpio->led = devm_gpiod_get(&pdev->dev, "led", GPIOD_OUT_LOW);
    if (IS_ERR(dgpio->led))
        return dev_err_probe(&pdev->dev, PTR_ERR(dgpio->led),
                             "failed to get led gpio\n");

    dgpio->key = devm_gpiod_get(&pdev->dev, "key", GPIOD_IN);
    if (IS_ERR(dgpio->key))
        return dev_err_probe(&pdev->dev, PTR_ERR(dgpio->key),
                             "failed to get key gpio\n");

    platform_set_drvdata(pdev, dgpio);
    return 0;
}
```

## LED 控制

```c
static void demo_led_set(struct demo_gpio *dgpio, bool on)
{
    gpiod_set_value(dgpio->led, on ? 1 : 0);
}
```

使用 `GPIO_ACTIVE_LOW` 后，逻辑值和实际电平会由 GPIO 子系统处理，驱动里可以按“1 表示亮”理解。

## 按键读取

```c
static int demo_key_read(struct demo_gpio *dgpio)
{
    return gpiod_get_value(dgpio->key);
}
```

如果只是低频读取，轮询也能工作。但按键通常更适合中断。

## GPIO 转中断

```c
dgpio->key_irq = gpiod_to_irq(dgpio->key);
if (dgpio->key_irq < 0)
    return dgpio->key_irq;
```

申请中断：

```c
ret = devm_request_irq(&pdev->dev, dgpio->key_irq,
                       demo_key_irq,
                       IRQF_TRIGGER_RISING | IRQF_TRIGGER_FALLING,
                       "demo-key", dgpio);
if (ret)
    return ret;
```

## 中断处理

中断里不要做复杂逻辑。按键还需要消抖，可以用 timer 延迟确认。

```c
static irqreturn_t demo_key_irq(int irq, void *data)
{
    struct demo_gpio *dgpio = data;

    mod_timer(&dgpio->debounce_timer, jiffies + msecs_to_jiffies(20));
    return IRQ_HANDLED;
}
```

## 定时器消抖

```c
static void demo_debounce_timer(struct timer_list *t)
{
    struct demo_gpio *dgpio = from_timer(dgpio, t, debounce_timer);
    int pressed = gpiod_get_value(dgpio->key);

    dev_info(dgpio->dev, "key %s\n", pressed ? "pressed" : "released");
}
```

初始化 timer：

```c
timer_setup(&dgpio->debounce_timer, demo_debounce_timer, 0);
```

remove 时删除：

```c
del_timer_sync(&dgpio->debounce_timer);
```

## 和 input 子系统结合

如果是按键设备，最好接入 input 子系统，而不是自己造字符设备。

```c
input_report_key(input, KEY_ENTER, pressed);
input_sync(input);
```

这样用户态可以通过标准输入事件读取按键。

## 调试命令

```bash
cat /sys/kernel/debug/gpio
dmesg -w
cat /proc/interrupts
```

如果开启了 libgpiod 工具：

```bash
gpioinfo
gpioget gpiochip1 4
gpioset gpiochip1 3=1
```

## 常见坑

- 旧 API `gpio_request/gpio_direction_*` 和新 API 混用
- 忘记设备树 GPIO 极性，导致逻辑反了
- 中断触发边沿设置不对
- 按键不消抖，出现一次按下多次触发
- 中断里直接打印太多日志

## 小结

GPIO 驱动看似简单，但它包含了设备树、资源获取、中断、定时器、input 子系统等很多驱动开发基础能力。把 LED 和按键写扎实，后续做更复杂的外设驱动会轻松很多。
