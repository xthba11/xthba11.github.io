---
title: 项目
date: 2026-04-28 00:00:00
type: projects
top_img: /img/embedded-lab-hero.png
---

## 项目档案

这里不只放项目名字，也尽量记录每个项目的来源、当前状态、代码结构、已经验证的功能、遇到的问题和下一步。已经有真实代码和调试记录的项目会放在前面；还在构思阶段的项目会明确标成实验计划。

## RidePulse：STM32 自行车码表

### 项目背景

RidePulse 是一个基于 STM32F411、FreeRTOS 和 LVGL 的自行车码表项目。它不是从空白工程开始，而是由我之前做的一套智能手表固件改造而来。

原工程已经具备 LVGL 显示、触摸交互、传感器采集、外部 Flash、LittleFS、OTA、低功耗和看门狗能力。因此这个项目的重点，是在已有穿戴设备工程基础上，补齐自行车码表真正需要的骑行数据链路：轮速采集、速度计算、里程累计、骑行状态机、码表 UI 和骑行记录保存。

### 当前状态

- 已完成：STM32F411 基础工程、FreeRTOS 任务框架、LVGL 显示任务、传感器服务、外部 Flash、LittleFS、OTA、低功耗、软件/硬件看门狗。
- 改造中：轮速霍尔传感器输入、RideTask、速度/里程计算、码表主页面。
- 计划补充：骑行历史记录页面、轮径设置、自动暂停/恢复、断电恢复、更多骑行数据统计。

### 代码结构

```text
ec_s100_watch_V2.2_T2469/
  01_APP/                       应用层、用户初始化、LVGL UI、显示任务
  02_BSP_Platform/              板级驱动、传感器适配、显示/触摸/Flash 封装
  02_Middleware_Platform/       LittleFS 移植
  04_Common_Utils/              步数算法、心率算法等通用模块
  05_Service/                   传感器服务、OTA、外部 Flash、低功耗、看门狗
  Core/                         STM32 HAL 初始化代码
  Middlewares/                  FreeRTOS、LVGL、Ymodem、公共组件
  MDK-ARM/                      Keil 工程
```

### 技术栈

| 模块 | 内容 |
|------|------|
| MCU | STM32F411 |
| RTOS | FreeRTOS |
| GUI | LVGL |
| 存储 | 外部 Flash + LittleFS |
| 升级 | USART + Ymodem OTA |
| 传感器 | 轮速霍尔、心率、气压、温湿度、MPU6050 |
| 可靠性 | 低功耗状态机、软件看门狗、硬件 IWDG |

### 已验证/已有证据

- `user_task_reso_config.c` 中已有显示、传感器、Flash、OTA、低功耗、看门狗等任务配置。
- `service_sensor.c` 中已有按 UI 页面切换采样策略的传感器服务。
- `lvgl_port.c` 中已有 UI 与业务层之间的数据同步接口。
- `service_externflash_manage.c` 中已有外部 Flash 与 LittleFS 挂载、读写测试。
- `service_ota_manager.c` 中已有 Ymodem OTA 状态机和 Flash 写入逻辑。
- `service_watchdog_monitor.c` 中已有任务注册、喂狗、超时复位和安全模式逻辑。

### 遇到的问题

- 原工程是智能手表方向，码表特有的轮速采集、速度/里程计算、骑行记录还需要补齐。
- 部分旧注释存在乱码，后续整理文章和代码时需要重写关键注释。
- 低功耗和看门狗需要继续梳理，骑行中不能误进入深度休眠。
- 外部 Flash 保存骑行记录时要避免频繁写入，也要考虑掉电恢复。

### 下一步

1. 新增 `bsp_wheel_speed`，用霍尔传感器或按键模拟轮速脉冲。
2. 新增 `RideTask`，完成速度、里程、骑行时间和自动暂停。
3. 新增 LVGL 码表主页面，显示速度、里程、时间、心率和电量。
4. 基于 LittleFS 保存一条骑行摘要记录。
5. 整理关键代码注释和串口调试日志，补到文章里。

### 系列文章

- [项目总览：从智能手表固件到骑行终端](/2026/07/16/项目实战/RidePulse/ridepulse-project-overview/)
- [FreeRTOS 任务划分：显示、传感器、存储、OTA 与看门狗](/2026/07/16/项目实战/RidePulse/ridepulse-freertos-architecture/)
- [轮速采集：霍尔传感器、EXTI 中断与速度里程计算](/2026/07/16/项目实战/RidePulse/ridepulse-wheel-speed-distance/)
- [LVGL 码表主界面：速度大数字、骑行时间、里程和心率刷新](/2026/07/16/项目实战/RidePulse/ridepulse-lvgl-bike-ui/)
- [LittleFS 骑行记录：外部 Flash 文件系统在 STM32 码表中的应用](/2026/07/16/项目实战/RidePulse/ridepulse-littlefs-ride-record/)

## 后续实验计划

下面这些项目会作为后续专题实验推进。目前它们更偏学习路线和实验计划，等有源码、日志和复盘后再升级成完整项目档案。

## myTCP：轻量级 TCP 学习协议栈

### 项目定位

用 C 语言实现一个用于学习的轻量级 TCP 协议栈，重点理解 TCP 状态机、滑动窗口、重传、拥塞控制和定时器机制。

### 核心模块

| 模块 | 内容 |
|------|------|
| packet | IP/TCP 头部解析、校验和、序列号处理 |
| socket | 连接对象、状态机、收发缓冲区 |
| timer | 超时重传、TIME_WAIT、心跳检测 |
| congestion | 慢启动、拥塞避免、快速重传 |
| tools | pcap 回放、日志追踪、单元测试 |

### 下一步

- TCP 三次握手状态机实现
- 滑动窗口与 RingBuffer 设计
- 超时重传定时器设计
- 用 Wireshark 验证自定义协议栈行为

## led-driver：Linux GPIO 字符设备驱动

### 项目定位

实现一个基础但完整的 Linux GPIO LED 字符设备驱动，覆盖设备树、platform driver、字符设备注册、用户态控制和驱动调试。

### 核心能力

- 通过设备树描述 LED GPIO
- platform driver 匹配设备
- `open/read/write/ioctl` 控制 LED 状态
- 提供 sysfs 或 debugfs 状态观察入口
- 支持交叉编译和目标板部署

### 下一步

- 字符设备驱动最小闭环
- 设备树 GPIO 获取与错误处理
- ioctl 接口设计
- 驱动日志与崩溃定位

## rtos-demo：FreeRTOS 工程模板

### 项目定位

整理一个可复用的 FreeRTOS 工程模板，用于传感器采集、串口通信、按键事件、电机控制等小型 MCU 项目。

### 任务划分

| 任务 | 职责 |
|------|------|
| sensor_task | 周期采样、滤波、异常检测 |
| comm_task | 串口收发、协议解析、命令响应 |
| control_task | 状态机、电机/PWM 控制 |
| log_task | 异步日志输出，降低实时任务阻塞 |
| watchdog_task | 喂狗、任务心跳检查、故障恢复 |

### 下一步

- FreeRTOS 任务优先级设计
- 队列、事件组和任务通知怎么选
- 串口 DMA + 空闲中断接收框架
- 看门狗与任务心跳机制

## network-lab：Linux 网络调试实验

### 项目定位

搭建一组网络编程实验，用来验证 TCP 粘包、半包、Nagle、Keepalive、epoll、连接池和抓包分析。

### 实验清单

- echo server/client
- epoll 多连接服务端
- 长连接心跳与断线重连
- 自定义 TLV 协议解析
- tcpdump/Wireshark 抓包复盘

后续每个项目会逐步补上源码结构和文章链接。
