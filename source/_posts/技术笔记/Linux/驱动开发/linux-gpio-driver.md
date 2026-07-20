---
title: Linux 驱动开发：GPIO 子系统与 LED/按键驱动
date: 2025-02-05
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
cover: /img/covers/articles/linux-gpio-driver.svg
top_img: /img/covers/articles/linux-gpio-driver.svg
---

GPIO 是嵌入式 Linux 驱动开发中最常接触的资源。LED、按键、复位脚、片选脚、电源使能脚，本质上都离不开 GPIO。

新内核推荐使用 descriptor-based GPIO API，也就是 `gpiod_*` 系列接口。

## 设备树示例

```dts
demo-gpio {
    compatible = "xthba,demo-gpio";     // 用于匹配驱动的 compatible 字符串
    led-gpios = <&gpio1 3 GPIO_ACTIVE_LOW>;   // LED GPIO: gpio1 控制器, 引脚3, 低电平有效
    key-gpios = <&gpio1 4 GPIO_ACTIVE_LOW>;   // 按键 GPIO: gpio1 控制器, 引脚4, 低电平有效
    status = "okay";                    // 启用该设备节点
};
```

驱动中使用 `"led"` 获取 `led-gpios`，使用 `"key"` 获取 `key-gpios`。

## 私有结构

```c
struct demo_gpio {
    struct device *dev;                 // 指向 platform_device 中的 device, 用于 devm_* 资源管理
    struct gpio_desc *led;              // LED 对应的 GPIO 描述符
    struct gpio_desc *key;              // 按键对应的 GPIO 描述符
    int key_irq;                        // 按键 GPIO 转换后的中断号
    struct timer_list debounce_timer;   // 按键消抖定时器
};
```

## 获取 GPIO

```c
// 驱动 probe 函数: 设备与驱动匹配后调用, 负责获取 GPIO 资源并初始化
static int demo_gpio_probe(struct platform_device *pdev)
{
    struct demo_gpio *dgpio;

    // 使用设备管理的 kzalloc, 驱动卸载时自动释放内存
    dgpio = devm_kzalloc(&pdev->dev, sizeof(*dgpio), GFP_KERNEL);
    if (!dgpio)
        return -ENOMEM;

    dgpio->dev = &pdev->dev;

    // 获取 LED GPIO 描述符, 初始化为输出低电平
    dgpio->led = devm_gpiod_get(&pdev->dev, "led", GPIOD_OUT_LOW);
    if (IS_ERR(dgpio->led))
        return dev_err_probe(&pdev->dev, PTR_ERR(dgpio->led),
                             "failed to get led gpio\n");

    // 获取按键 GPIO 描述符, 初始化为输入
    dgpio->key = devm_gpiod_get(&pdev->dev, "key", GPIOD_IN);
    if (IS_ERR(dgpio->key))
        return dev_err_probe(&pdev->dev, PTR_ERR(dgpio->key),
                             "failed to get key gpio\n");

    // 将私有数据存入 platform_device, 供后续 remove / suspend 等函数使用
    platform_set_drvdata(pdev, dgpio);
    return 0;
}
```

## LED 控制

```c
// 设置 LED 亮灭: on 为 true 点亮, false 熄灭
// 注意: 使用了 GPIO_ACTIVE_LOW 后, 逻辑值 1 即代表"点亮", 内核自动处理电平翻转
static void demo_led_set(struct demo_gpio *dgpio, bool on)
{
    gpiod_set_value(dgpio->led, on ? 1 : 0);
}
```

使用 `GPIO_ACTIVE_LOW` 后，逻辑值和实际电平会由 GPIO 子系统处理，驱动里可以按“1 表示亮”理解。

## 按键读取

```c
// 读取按键当前电平: 返回 1 表示按下, 0 表示释放 (已考虑 ACTIVE_LOW 极性)
static int demo_key_read(struct demo_gpio *dgpio)
{
    return gpiod_get_value(dgpio->key);
}
```

如果只是低频读取，轮询也能工作。但按键通常更适合中断。

## GPIO 转中断

```c
// 将 GPIO 描述符转换为中断号, 负数表示转换失败
dgpio->key_irq = gpiod_to_irq(dgpio->key);
if (dgpio->key_irq < 0)
    return dgpio->key_irq;
```

申请中断：

```c
// 申请中断: 上升沿和下降沿都触发, 设备管理版本, 驱动卸载时自动释放
ret = devm_request_irq(&pdev->dev, dgpio->key_irq,
                       demo_key_irq,                        // 中断处理函数
                       IRQF_TRIGGER_RISING | IRQF_TRIGGER_FALLING,  // 双边沿触发, 捕获按下和释放
                       "demo-key", dgpio);                  // 中断名称 / 传递给处理函数的私有数据
if (ret)
    return ret;
```

## 中断处理

中断里不要做复杂逻辑。按键还需要消抖，可以用 timer 延迟确认。

```c
// 按键中断处理函数: 中断上下文, 不能做耗时操作, 仅启动消抖定时器
static irqreturn_t demo_key_irq(int irq, void *data)
{
    struct demo_gpio *dgpio = data;

    // 修改定时器超时时间为当前时刻 + 20ms, 实现消抖延迟
    mod_timer(&dgpio->debounce_timer, jiffies + msecs_to_jiffies(20));
    return IRQ_HANDLED;
}
```

## 定时器消抖

```c
// 消抖定时器回调: 中断 20ms 后执行, 此时按键电平已稳定, 读取最终状态
static void demo_debounce_timer(struct timer_list *t)
{
    // 通过 timer_list 指针反推包含它的 demo_gpio 结构体
    struct demo_gpio *dgpio = from_timer(dgpio, t, debounce_timer);
    int pressed = gpiod_get_value(dgpio->key);  // 读取稳定后的按键电平

    // 实际产品中应调用 input_report_key 上报给 input 子系统
    dev_info(dgpio->dev, "key %s\n", pressed ? "pressed" : "released");
}
```

初始化 timer：

```c
// 初始化消抖定时器, 绑定回调函数, 第三个参数 0 表示 flags (通常为 0)
timer_setup(&dgpio->debounce_timer, demo_debounce_timer, 0);
```

remove 时删除：

```c
// 同步删除定时器: 保证返回时定时器不再运行 (不能在中断上下文中调用)
del_timer_sync(&dgpio->debounce_timer);
```

## 和 input 子系统结合

如果是按键设备，最好接入 input 子系统，而不是自己造字符设备。

```c
// 向 input 子系统上报按键事件, 用户态通过 /dev/input/event* 即可读取
input_report_key(input, KEY_ENTER, pressed);  // 上报按键状态 (按下/释放)
input_sync(input);                             // 同步事件, 通知内核该帧事件结束
```

这样用户态可以通过标准输入事件读取按键。

## 调试命令

```bash
# 查看所有 GPIO 占用情况 (需要 debugfs 挂载)
cat /sys/kernel/debug/gpio
# 实时查看内核日志 (观察驱动打印)
dmesg -w
# 查看中断统计, 确认按键中断是否正常触发
cat /proc/interrupts
```

如果开启了 libgpiod 工具：

```bash
# 列出所有 GPIO 芯片及其引脚信息 (替代 cat /sys/kernel/debug/gpio)
gpioinfo
# 读取 gpiochip1 第 4 号引脚的当前电平
gpioget gpiochip1 4
# 将 gpiochip1 第 3 号引脚设置为高电平
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
