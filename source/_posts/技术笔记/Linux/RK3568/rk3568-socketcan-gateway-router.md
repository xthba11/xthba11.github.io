---
title: RK3568 车载网关实验二：SocketCAN 接收、队列与双 CAN 转发
date: 2026-07-16 18:20:00
categories:
  - 技术笔记
  - Linux
  - RK3568
  - 车载网关
tags:
  - RK3568
  - Linux
  - SocketCAN
  - C++
  - CAN网关
description: 使用 C++ 实现 RK3568 车载网关的 SocketCAN 接收模块，把 CAN 接收、线程安全队列、解析线程和 vcan0 到 vcan1 转发串成一个可验证闭环。
top_img: /img/covers/linux-driver-cover.svg
---

上一篇文章完成了 `vcan0/vcan1` 环境验证。这一篇开始写车载网关的核心模块：SocketCAN 接收和双 CAN 通道转发。

这个模块是整个 RK3568 车载网关项目的入口。后面的车辆状态解析、告警检测、SQLite 存储、Qt Dashboard 都依赖这里收到的原始 CAN 帧。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS，先用 PC 开发和验证。
- 目标板/芯片：RK3568 Linux 开发板。
- 内核/SDK/编译器版本：Linux SocketCAN，GCC/G++，C++11 或以上。
- 使用工具：`cmake`、`g++`、`candump`、`cansend`、`cangen`、`gdb`、`valgrind`。
- 输入接口：开发阶段使用 `vcan0`，实机阶段可切换为 `can0`。
- 输出接口：开发阶段使用 `vcan1` 验证转发。

依赖安装：

```bash
sudo apt install -y build-essential cmake can-utils
```

## 问题背景

传统的 CAN 采集 demo 往往只做一件事：`read()` 一帧，然后打印出来。但车载网关项目要处理更多事情：

- CAN 接收线程不能被解析、数据库或 UI 阻塞。
- 报文需要进入线程安全队列。
- 解析线程从队列消费数据，更新车辆状态。
- 一部分报文需要从 `vcan0` 转发到 `vcan1`。
- 转发需要支持白名单或黑名单。
- 系统需要统计 RX、TX、Drop 数量，方便压测。

因此我把模块拆成三个类：

```text
CanReceiver  -> 只负责打开接口和接收 CAN 帧
CanRouter    -> 只负责过滤规则和转发判断
CanSender    -> 只负责向输出接口发送 CAN 帧
```

数据流如下：

```text
vcan0/can0
  -> CanReceiver Thread
  -> BlockingQueue<CanFrame>
  -> Parser Thread
  -> VehicleState

CanReceiver Thread
  -> CanRouter
  -> CanSender
  -> vcan1/can1
```

## 核心数据结构

项目里不要直接把 Linux 的 `struct can_frame` 传得到处都是。建议转成自己的结构：

```cpp
struct CanFrame {
    std::string ifname;
    std::uint32_t can_id = 0;
    std::uint8_t dlc = 0;
    std::uint8_t data[8] = {0};
    std::uint64_t timestamp_ms = 0;
};
```

这样做有几个好处：

- 后续支持 `can0`、`vcan0`、`vcan1` 时能知道报文来源。
- 日志和 SQLite 可以直接保存 `timestamp_ms`。
- 上层不依赖 Linux 内核头文件。
- 单元测试里可以手动构造 `CanFrame`。

## 打开 SocketCAN 接口

核心流程：

```text
socket(PF_CAN, SOCK_RAW, CAN_RAW)
  -> ioctl(SIOCGIFINDEX)
  -> bind()
  -> read(struct can_frame)
```

示例代码：

```cpp
bool CanReceiver::open(const std::string& ifname)
{
    fd_ = socket(PF_CAN, SOCK_RAW, CAN_RAW);
    if (fd_ < 0) {
        perror("socket");
        return false;
    }

    struct ifreq ifr {};
    std::snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname.c_str());

    if (ioctl(fd_, SIOCGIFINDEX, &ifr) < 0) {
        perror("ioctl SIOCGIFINDEX");
        ::close(fd_);
        fd_ = -1;
        return false;
    }

    struct sockaddr_can addr {};
    addr.can_family = AF_CAN;
    addr.can_ifindex = ifr.ifr_ifindex;

    if (bind(fd_, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        perror("bind");
        ::close(fd_);
        fd_ = -1;
        return false;
    }

    ifname_ = ifname;
    return true;
}
```

## 接收线程

接收线程只做轻量工作：读帧、转成 `CanFrame`、投递队列、按规则转发。

```cpp
void CanReceiver::receiveLoop()
{
    while (running_) {
        struct can_frame raw {};
        ssize_t n = read(fd_, &raw, sizeof(raw));

        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("read can");
            break;
        }

        if (n != sizeof(raw)) {
            stats_.drop++;
            continue;
        }

        CanFrame frame;
        frame.ifname = ifname_;
        frame.can_id = raw.can_id & CAN_SFF_MASK;
        frame.dlc = raw.can_dlc;
        std::memcpy(frame.data, raw.data, raw.can_dlc);
        frame.timestamp_ms = nowMs();

        queue_.push(frame);
        stats_.rx++;

        if (router_ && router_->shouldForward(frame.can_id)) {
            if (router_->route(frame)) {
                stats_.tx++;
            } else {
                stats_.drop++;
            }
        }
    }
}
```

注意这里没有做车辆信号解析，也没有写 SQLite。接收线程越干净，压测时越容易稳定。

## 转发规则

第一版可以使用简单白名单：

```json
{
  "forward": {
    "mode": "whitelist",
    "ids": ["0x100", "0x101", "0x102"]
  }
}
```

含义：

- `0x100`：Engine ECU，车速、转速、水温。
- `0x101`：Body ECU，车门、档位、转向灯。
- `0x102`：BMS ECU，电压、电池温度。
- `0x200`：诊断故障码，第一版可以选择不转发。

转发判断：

```cpp
bool CanRouter::shouldForward(std::uint32_t can_id) const
{
    bool hit = rule_ids_.count(can_id) > 0;
    if (mode_ == "whitelist") {
        return hit;
    }
    if (mode_ == "blacklist") {
        return !hit;
    }
    return false;
}
```

## 验证方法

启动环境：

```bash
bash scripts/setup_vcan.sh
```

终端 1 监听转发输出：

```bash
candump vcan1
```

终端 2 启动网关：

```bash
./vehicle_gateway --can-in vcan0 --can-out vcan1 --forward config/forward_rules.json
```

终端 3 发送白名单报文：

```bash
cansend vcan0 100#40063C560C000000
```

期望网关日志：

```text
[CAN RX] if=vcan0 id=0x100 dlc=8 data=40 06 3C 56 0C 00 00 00
[CAN TX] if=vcan1 id=0x100 dlc=8
[STAT] rx=1 tx=1 drop=0 queue=0
```

期望 `candump vcan1` 输出：

```text
vcan1  100   [8]  40 06 3C 56 0C 00 00 00
```

发送黑名单或非白名单报文：

```bash
cansend vcan0 200#0301000000000000
```

如果配置不转发 `0x200`，则 `vcan1` 不应该显示这条报文。网关可以打印：

```text
[CAN DROP] id=0x200 reason=forward_rule
```

## 压力测试

连续发送 1000 条报文：

```bash
cangen vcan0 -g 1 -I 100 -L 8
```

观察统计：

```text
[STAT] rx=1000 tx=1000 drop=0 queue=0
```

如果 `queue` 不断增大，说明解析线程或后续处理速度跟不上；如果 `drop` 增加，要区分是过滤丢弃还是程序异常丢帧。

## 退出处理

项目早期很容易忽略 Ctrl+C 退出。建议处理信号：

```cpp
static std::atomic<bool> g_running{true};

static void onSignal(int)
{
    g_running = false;
}
```

主线程退出时按顺序停止：

```text
停止接收线程
唤醒队列
等待解析线程退出
关闭 CAN fd
flush 日志和 SQLite
```

否则程序可能卡在阻塞队列或 `read()` 上，影响调试体验。

## 复盘

这篇实验最关键的设计点是“接收和业务解耦”。

我不建议在 SocketCAN 接收线程里直接做以下事情：

- CAN 信号解析。
- SQLite 写入。
- OpenCV 处理。
- Qt UI 刷新。
- 复杂告警规则。

这些动作都可能耗时或加锁。一旦接收线程被拖慢，高频 CAN 报文就会堆积，问题会表现成状态延迟、告警滞后甚至丢帧。

比较稳的做法是：

```text
接收线程只保证原始帧可靠进入队列
解析线程负责把原始帧变成车辆信号
状态管理模块负责维护当前状态快照
存储线程异步写 SQLite
Dashboard 只读状态快照或通过 TCP 接收 JSON
```

这样后面即使把输入从 `vcan0` 换成 RK3568 上的真实 `can0`，整体结构也不需要大改。
