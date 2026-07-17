---
title: RK3568 车载网关实验一：vcan 环境与 can-utils 验证
date: 2026-07-16 18:10:00
categories:
  - 技术笔记
  - Linux
  - RK3568
  - 车载网关
tags:
  - RK3568
  - Linux
  - SocketCAN
  - vcan
  - can-utils
description: 基于 RK3568 车载网关项目，搭建 Ubuntu PC 与 RK3568 板端的 vcan0/vcan1 测试环境，完成 CAN 报文收发、接口检查和基础问题定位。
cover: /img/covers/articles/rk3568-vehicle-gateway-vcan-setup.svg
top_img: /img/covers/articles/rk3568-vehicle-gateway-vcan-setup.svg
---

这篇文章是 RK3568 车载网关与轻量级车道偏离预警项目的第一篇实验记录。

在真正接入 USB-CAN、MCP2515 或真实车辆 CAN 总线之前，我先使用 Linux 的虚拟 CAN 设备 `vcan0` 和 `vcan1` 做软件闭环。这样可以在没有硬件 CAN 设备的情况下验证 SocketCAN 程序、报文解析、转发过滤、SQLite 记录和 Qt Dashboard 刷新。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS，x86_64。
- 目标板/芯片：RK3568 Linux 开发板。
- 内核/SDK/编译器版本：Ubuntu 5.x/6.x 内核，RK3568 厂商 Linux SDK，GCC/G++。
- 使用工具：`iproute2`、`can-utils`、`modprobe`、`candump`、`cansend`、`cangen`、`dmesg`。
- 项目目标：先在 PC 上完成 vcan 软件闭环，再迁移到 RK3568，后续替换为 `can0` 或 USB-CAN。

安装工具：

```bash
sudo apt update
sudo apt install -y can-utils iproute2
```

检查工具是否安装成功：

```bash
candump --help
cansend --help
cangen --help
```

## 问题背景

这个项目的 Linux 部分最终要完成这些能力：

```text
Python ECU 模拟器 / can0 实际 CAN 设备
  -> SocketCAN 接收 CAN 帧
  -> CAN 队列
  -> 信号解析
  -> 车辆状态管理
  -> 告警检测
  -> SQLite 存储
  -> Qt Dashboard 显示
```

如果一开始就接真实 CAN 设备，问题来源会很多：硬件连线、波特率、终端电阻、驱动加载、USB-CAN 适配、报文格式都有可能出错。`vcan` 的价值是把硬件问题先拿掉，只验证 Linux SocketCAN 软件链路。

我在这个阶段只关心三件事：

- 系统能创建 `vcan0` 和 `vcan1`。
- `cansend` 发送的报文能被 `candump` 收到。
- 后续程序可以把 `vcan0` 收到的报文转发到 `vcan1`。

## vcan 基础概念

`vcan` 是 Linux 的虚拟 CAN 网络设备。它没有真实物理总线，不需要设置波特率，也不需要接收发器。它适合做 SocketCAN 应用层开发和自动化测试。

真实 CAN 常见命令类似这样：

```bash
sudo ip link set can0 type can bitrate 500000
sudo ip link set up can0
```

而 `vcan` 不需要 bitrate：

```bash
sudo ip link add dev vcan0 type vcan
sudo ip link set up vcan0
```

对应用程序来说，`vcan0` 和 `can0` 都是 SocketCAN 网络接口。只要程序写得通用，后续把参数从 `vcan0` 改成 `can0` 即可。

## 创建 vcan0 和 vcan1

加载内核模块：

```bash
# 加载 CAN 协议栈内核模块
sudo modprobe can         # CAN 总线核心模块
sudo modprobe can_raw     # SocketCAN 原始套接字支持
sudo modprobe vcan        # 虚拟 CAN 设备驱动
```

创建两个虚拟 CAN 接口：

```bash
# 创建两个虚拟 CAN 接口（已存在则忽略错误）
sudo ip link add dev vcan0 type vcan 2>/dev/null || true
sudo ip link add dev vcan1 type vcan 2>/dev/null || true
# 启动虚拟 CAN 接口（vcan 不需要设置波特率）
sudo ip link set up vcan0
sudo ip link set up vcan1
```

检查状态：

```bash
# 检查接口详细信息（含状态标志）
ip -details link show vcan0
ip -details link show vcan1
```

期望能看到：

```text
vcan0: <NOARP,UP,LOWER_UP>
vcan1: <NOARP,UP,LOWER_UP>
```

如果没有看到 `UP`，说明接口没有启动。

## 单通道收发验证

终端 1 监听 `vcan0`：

```bash
candump vcan0
```

终端 2 发送一条 CAN 标准帧：

```bash
cansend vcan0 100#1122334455667788
```

终端 1 期望输出：

```text
vcan0  100   [8]  11 22 33 44 55 66 77 88
```

这一步说明 can-utils 和 SocketCAN 基础环境是正常的。

## 双通道准备

后面的网关转发实验需要 `vcan0 -> vcan1`。

先在终端 1 监听 `vcan1`：

```bash
candump vcan1
```

此时如果直接向 `vcan0` 发送：

```bash
cansend vcan0 100#40063C560C000000
```

`vcan1` 不应该有输出。因为 Linux 不会自动把两个 CAN 接口桥接起来，转发逻辑要由我们的网关程序完成。

这个现象反而是正确的：它说明后续 `vcan1` 是否出现报文，完全取决于 `vehicle_gateway` 的转发代码。

## 验证方法

我给这个实验写了一个最小验收清单。

第一，接口存在：

```bash
ip link show vcan0
ip link show vcan1
```

第二，单通道可收发：

```bash
candump vcan0
cansend vcan0 100#1122334455667788
```

第三，压力报文能生成：

```bash
# 压力测试：每10ms发送一条CAN帧，固定ID=0x100，数据长度8字节
cangen vcan0 -g 10 -I 100 -L 8
```

参数含义：

- `-g 10`：每 10ms 发送一帧。
- `-I 100`：固定 CAN ID 为 `0x100`。
- `-L 8`：数据长度为 8 字节。

第四，RK3568 板端也能执行同样流程：

```bash
uname -a                                              # 确认内核版本
ls /proc/net/can                                      # 检查内核 CAN 子系统是否已启用
sudo modprobe vcan                                    # 加载 vcan 模块
sudo ip link add dev vcan0 type vcan 2>/dev/null || true  # 创建 vcan0
sudo ip link set up vcan0                             # 启动 vcan0
candump vcan0                                         # 监听验证
```

如果板端没有 `can-utils`，可以先交叉编译或用包管理器安装。项目早期也可以先在 Ubuntu PC 上完成软件逻辑，再迁移到板端。

## 常见问题

### RTNETLINK answers: File exists

说明 `vcan0` 已经创建过了。可以忽略，或者先删除：

```bash
# 先删除已有接口再重新创建
sudo ip link delete vcan0
```

### Cannot find device "vcan0"

说明接口还没创建，或者 `vcan` 模块没加载。先执行：

```bash
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
```

### cansend 没输出

`cansend` 本身成功时一般不会打印内容，要看 `candump` 终端是否收到。

### candump 没收到

按顺序检查：

```bash
ip link show vcan0    # 检查接口是否存在且已启动
lsmod | grep vcan      # 检查 vcan 模块是否已加载
dmesg | tail -n 20     # 查看内核日志排查底层错误
```

最常见原因是接口没 `set up`。

## 复盘

这个实验看起来简单，但它是后面所有模块的地基。

我会把 vcan 环境脚本化，避免每次手动敲命令：

```bash
#!/usr/bin/env bash
# setup_vcan.sh - 一键创建 vcan0/vcan1 虚拟 CAN 测试环境
set -e  # 任何命令失败时立即退出

# 加载 CAN 协议栈内核模块
sudo modprobe can
sudo modprobe can_raw
sudo modprobe vcan

# 创建虚拟 CAN 接口（已存在则忽略）
sudo ip link add dev vcan0 type vcan 2>/dev/null || true
sudo ip link add dev vcan1 type vcan 2>/dev/null || true
# 启动虚拟 CAN 接口
sudo ip link set up vcan0
sudo ip link set up vcan1

# 确认接口状态
ip link show vcan0
ip link show vcan1
```

后续文章里的 SocketCAN 接收、双 CAN 转发、Python ECU 模拟、SQLite 记录和回放，都默认这一步已经完成。

真正迁移到 RK3568 时，我会保留 `vcan0` 作为开发模式，同时预留 `can0` 作为真实硬件模式。这样项目可以在 PC、RK3568 vcan、RK3568 can0 三种环境下复现，博客和简历里也更像一个完整工程，而不是只在某台机器上偶然跑通。
