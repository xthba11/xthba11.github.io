---
title: 关于我
date: 2026-04-27 00:00:00
type: about
---

## 关于我

我是 XTHBA，目前主要在整理和实践嵌入式方向的项目：STM32 固件、FreeRTOS 任务设计、LVGL 显示、传感器驱动、外部 Flash、OTA、低功耗和 Linux/C 网络编程。

最近我在做一个比较完整的 STM32F411 智能穿戴设备工程，并准备把它改造成自行车码表项目 RidePulse。这个工程里已经有 FreeRTOS、LVGL、心率/气压/温湿度/运动传感器、外部 Flash、LittleFS、Ymodem OTA、低功耗和看门狗。后续我会把轮速采集、速度里程计算、骑行状态机和骑行记录一步步补进去。

我写博客不是为了把概念堆满，而是想把一个问题拆成可以验证的小模块：先让硬件和最小代码跑起来，再补日志、状态机、异常处理和边界条件。相比只追求“能跑”，我更在意一个系统是否容易调试、容易复现问题、容易长期维护。

## 我现在常用的环境

| 类型 | 工具/平台 |
|------|-----------|
| MCU | STM32F411、STM32CubeMX、STM32 HAL |
| RTOS/UI | FreeRTOS、LVGL |
| IDE/调试 | Keil MDK、J-Link/ST-Link、串口日志、RTT |
| 存储/升级 | W25Q 系列外部 Flash、LittleFS、Ymodem OTA |
| Linux 学习 | Ubuntu、GCC、Makefile、GDB、tcpdump、Wireshark |
| 代码管理 | Git、Markdown、Hexo |

## 技术方向

| 方向 | 关注内容 |
|------|----------|
| MCU 开发 | STM32、外设驱动、Bootloader、低功耗、传感器与电机控制 |
| RTOS | FreeRTOS、任务划分、队列/事件组、中断协作、实时性分析 |
| 图形界面 | LVGL 页面组织、显示刷新、触摸输入、UI 与业务解耦 |
| 存储升级 | 外部 Flash、LittleFS、Ymodem OTA、版本标志位、掉电风险 |
| Linux | 字符设备、设备树、GPIO/I2C/SPI 子系统、交叉编译、系统调试 |
| 网络编程 | TCP/UDP、epoll、协议解析、抓包分析、连接管理 |
| 工具链 | Makefile、GDB、J-Link、ST-Link、Wireshark、逻辑分析仪 |

## 这个博客会写什么

这里会沉淀几类内容：

- 项目实战：从需求、硬件接口、软件架构到调试记录
- 技术笔记：把 MCU、Linux、网络编程里的关键概念讲清楚
- 踩坑复盘：记录那些“看起来很小，但会卡一天”的问题，比如任务没喂狗、Flash 挂载失败、UI 刷新卡顿、传感器采样频率不合理
- 工具方法：调试器、抓包工具、日志系统、构建脚本的使用经验

## 我的工程偏好

- 接口清晰：模块之间少耦合，状态和错误码可追踪
- 日志可用：关键路径必须能定位输入、输出、耗时和失败原因
- 先验证再优化：先做最小闭环，再逐步补性能和边界
- 尊重硬件：时序、电平、供电、干扰和温度都可能是 bug 的一部分
- 不假装完成：项目还在改造中的地方会标出来，已经验证的地方会写清楚验证方法

## 联系方式

- GitHub: [xthba11](https://github.com/xthba11)
- Email: 112301306@fzu.edu.cn

欢迎交流 STM32、FreeRTOS、LVGL、传感器驱动、Linux 驱动、网络协议和工程调试经验。
