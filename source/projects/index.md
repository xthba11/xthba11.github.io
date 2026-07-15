---
title: 项目
date: 2026-04-28 00:00:00
type: projects
top_img: /img/embedded-lab-hero.png
---

## 项目方向

这里整理我计划持续完善的嵌入式与系统编程项目。每个项目都会尽量补齐需求背景、硬件连接、软件架构、核心代码、调试记录和后续优化。

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

### 计划文章

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

### 计划文章

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

### 计划文章

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
