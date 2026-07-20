---
title: RK3568 车载网关实验三：Python ECU 模拟器与 CAN 信号解析
date: 2025-06-16 18:30:00
categories:
  - 技术笔记
  - Linux
  - RK3568
  - 车载网关
tags:
  - RK3568
  - Linux
  - SocketCAN
  - Python
  - CAN解析
description: 使用 Python 模拟 Engine ECU、Body ECU、BMS ECU 和 Diagnosis ECU 周期发送 CAN 报文，并在 C++ 网关中解析车速、转速、水温、电压、档位、车门、转向灯和故障码。
cover: /img/covers/articles/rk3568-can-ecu-simulator-signal-parser.svg
top_img: /img/covers/articles/rk3568-can-ecu-simulator-signal-parser.svg
---

前两篇文章完成了 `vcan` 环境和 SocketCAN 接收转发。这一篇开始让网关的数据变得像“车”。

如果 CAN 总线上只有随机字节，Qt Dashboard 很难展示项目价值。我们需要一套稳定、可控、可复现的车辆 ECU 模拟器，用它周期发送车速、转速、水温、电压、档位、车门、转向灯和 DTC 故障码。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS。
- 目标板/芯片：RK3568 Linux 开发板。
- 内核/SDK/编译器版本：Linux SocketCAN，Python 3，C++11。
- 使用工具：`python-can`、`can-utils`、`candump`、`cansend`、`cmake`、`g++`。
- 输入接口：`vcan0`。
- 关联模块：ECU 模拟器、CAN 信号解析、车辆状态管理、告警检测。

安装 Python 依赖：

```bash
sudo apt install -y python3 python3-pip can-utils
pip3 install python-can
```

## 问题背景

RK3568 车载网关项目需要演示的不只是“收到了 CAN 帧”，而是：

```text
0x100 -> 解析出转速、车速、水温
0x101 -> 解析出车门、档位、转向灯
0x102 -> 解析出电压、电池温度
0x200 -> 解析出 DTC 故障码
```

这样才能继续做：

- 行驶中车门打开告警。
- 水温过高告警。
- 电池电压低告警。
- DTC 故障告警。
- 车道偏离时结合转向灯判断是否告警。

真实车辆 CAN 矩阵一般来自 DBC 文件。这个项目第一版先手写一个简化信号矩阵，方便复现和写博客。

## 报文设计

第一版模拟四类 ECU：

| ECU | CAN ID | 周期 | 数据 |
| --- | --- | --- | --- |
| Engine ECU | `0x100` | 100ms | 转速、车速、水温 |
| Body ECU | `0x101` | 200ms | 车门、档位、转向灯 |
| BMS ECU | `0x102` | 500ms | 电压、电池温度 |
| Diagnosis ECU | `0x200` | 事件触发 | DTC 故障码 |

信号矩阵：

| CAN ID | 字节位置 | 信号 | 解析规则 | 单位 |
| --- | --- | --- | --- | --- |
| `0x100` | Byte0-1 | `engine_rpm` | `raw * 0.25` | rpm |
| `0x100` | Byte2 | `vehicle_speed` | `raw` | km/h |
| `0x100` | Byte3 | `coolant_temp` | `raw - 40` | C |
| `0x101` | Byte0 bit0 | `left_front_door` | 0 closed, 1 open | - |
| `0x101` | Byte0 bit1 | `right_front_door` | 0 closed, 1 open | - |
| `0x101` | Byte0 bit2 | `left_turn_signal` | 0 off, 1 on | - |
| `0x101` | Byte0 bit3 | `right_turn_signal` | 0 off, 1 on | - |
| `0x101` | Byte1 | `gear` | 0 P, 1 R, 2 N, 3 D | - |
| `0x102` | Byte0-1 | `battery_voltage` | `raw * 0.1` | V |
| `0x102` | Byte2 | `battery_temp` | `raw - 40` | C |
| `0x200` | Byte0-1 | `dtc_code` | raw to DTC | - |

## Python ECU 模拟器

目录建议：

```text
simulator/
├── ecu_engine.py
├── ecu_body.py
├── ecu_bms.py
├── ecu_diagnosis.py
├── fault_injector.py
└── run_all.py
```

Engine ECU 示例：

```python
import time
import can

# 创建 SocketCAN 接口，连接到 vcan0
bus = can.interface.Bus(channel="vcan0", interface="socketcan")

def build_engine_frame(rpm, speed, coolant):
    """构造 Engine ECU CAN 帧 (ID=0x100)，将物理值编码为字节数组"""
    # 转速编码：rpm = raw * 0.25，所以 raw = rpm / 0.25
    raw_rpm = int(rpm / 0.25)
    # 水温编码：coolant = raw - 40，所以 raw = coolant + 40
    raw_coolant = int(coolant + 40)

    # 数据布局：Byte0-1=转速(低字节在前)，Byte2=车速，Byte3=水温，剩余填充0
    data = [
        raw_rpm & 0xFF,          # 转速低字节
        (raw_rpm >> 8) & 0xFF,   # 转速高字节
        int(speed) & 0xFF,       # 车速（1 字节，范围 0~255 km/h）
        raw_coolant & 0xFF,      # 水温（偏移后）
        0, 0, 0, 0,              # 填充字节
    ]

    # 构造标准帧（非扩展帧），仲裁 ID = 0x100
    return can.Message(arbitration_id=0x100, data=data, is_extended_id=False)

# 周期发送：每 100ms 发送一帧
while True:
    msg = build_engine_frame(rpm=1600, speed=60, coolant=46)
    bus.send(msg)
    time.sleep(0.1)
```

注意字节序要和解析代码保持一致。这里 Byte0 是低字节，Byte1 是高字节，所以 `0x0640` 会编码成 `40 06`。

Body ECU 示例：

```python
def build_body_frame(door_l=False, door_r=False, left_turn=False, right_turn=False, gear=3):
    """构造 Body ECU CAN 帧 (ID=0x101)，将开关量和档位编码为字节数组"""
    # 使用位掩码将 4 个开关量打包到 Byte0
    flags = 0
    flags |= int(door_l) << 0       # bit0：左前门（0=关, 1=开）
    flags |= int(door_r) << 1       # bit1：右前门（0=关, 1=开）
    flags |= int(left_turn) << 2    # bit2：左转向灯（0=关, 1=开）
    flags |= int(right_turn) << 3   # bit3：右转向灯（0=关, 1=开）
    # 数据布局：Byte0=开关量标志位，Byte1=档位(0=P,1=R,2=N,3=D)，剩余填充0
    return can.Message(arbitration_id=0x101, data=[flags, gear, 0, 0, 0, 0, 0, 0], is_extended_id=False)
```

## C++ 信号解析

解析函数尽量保持纯函数形式，方便测试：

```cpp
// 解析后的信号值结构
struct SignalValue {
    std::string name;      // 信号名称
    double value = 0.0;    // 物理值
    std::string unit;      // 物理单位
};

// 根据 CAN ID 将原始字节解析为物理信号值
std::vector<SignalValue> SignalParser::parse(const CanFrame& frame)
{
    std::vector<SignalValue> out;

    switch (frame.can_id) {
    case 0x100: {  // Engine ECU：转速、车速、水温
        // 转速：Byte0 低字节 + Byte1 高字节，因子 0.25
        std::uint16_t raw_rpm = frame.data[0] | (frame.data[1] << 8);
        double rpm = raw_rpm * 0.25;
        double speed = frame.data[2];           // 车速：直接取值
        double coolant = frame.data[3] - 40;    // 水温：偏移 -40

        out.push_back({"engine_rpm", rpm, "rpm"});
        out.push_back({"vehicle_speed", speed, "km/h"});
        out.push_back({"coolant_temp", coolant, "C"});
        break;
    }
    case 0x101: {  // Body ECU：车门、转向灯、档位
        std::uint8_t flags = frame.data[0];
        // 按位提取开关量（bit0~bit3）
        out.push_back({"left_front_door", double((flags >> 0) & 1), ""});
        out.push_back({"right_front_door", double((flags >> 1) & 1), ""});
        out.push_back({"left_turn_signal", double((flags >> 2) & 1), ""});
        out.push_back({"right_turn_signal", double((flags >> 3) & 1), ""});
        out.push_back({"gear", double(frame.data[1]), ""});  // Byte1：档位
        break;
    }
    case 0x102: {  // BMS ECU：电池电压、电池温度
        // 电压：Byte0 低字节 + Byte1 高字节，因子 0.1
        std::uint16_t raw_voltage = frame.data[0] | (frame.data[1] << 8);
        out.push_back({"battery_voltage", raw_voltage * 0.1, "V"});
        out.push_back({"battery_temp", double(frame.data[2] - 40), "C"});
        break;
    }
    case 0x200: {  // Diagnosis ECU：DTC 故障码
        std::uint16_t dtc = frame.data[0] | (frame.data[1] << 8);
        out.push_back({"dtc_code", double(dtc), ""});
        break;
    }
    default:
        break;  // 未识别的 CAN ID，忽略
    }

    return out;
}
```

## 手算验证

发送报文：

```bash
cansend vcan0 100#40063C560C000000
```

手算：

```text
Byte0-1 = 0x0640 = 1600
engine_rpm = 1600 * 0.25 = 400 rpm
Byte2 = 0x3C = 60
vehicle_speed = 60 km/h
Byte3 = 0x56 = 86
coolant_temp = 86 - 40 = 46 C
```

期望网关输出：

```text
[CAN RX] if=vcan0 id=0x100 dlc=8 data=40 06 3C 56 0C 00 00 00
[SIGNAL] engine_rpm=400 rpm
[SIGNAL] vehicle_speed=60 km/h
[SIGNAL] coolant_temp=46 C
```

## 故障注入

为了验证告警模块，可以准备一个 `fault_injector.py`：

```bash
python3 simulator/fault_injector.py --type coolant_high
python3 simulator/fault_injector.py --type voltage_low
python3 simulator/fault_injector.py --type door_open_running
python3 simulator/fault_injector.py --type dtc
```

期望网关输出：

```text
[ALARM][CRITICAL] coolant temperature too high
[ALARM][WARNING] battery voltage too low
[ALARM][CRITICAL] door open while vehicle is running
[ALARM][CRITICAL] DTC detected
```

## ECU 在线检测

每类 ECU 的报文都有周期。状态管理模块可以记录最后一次收到该 ECU 报文的时间：

```cpp
// ECU 在线状态跟踪
struct EcuStatus {
    bool online = false;                  // 当前是否在线
    std::uint64_t last_seen_ms = 0;       // 最后一次收到该 ECU 报文的时间戳
    std::uint64_t timeout_ms = 1000;      // 超时阈值（毫秒），超过此时间未收到报文视为离线
};
```

判断逻辑：

```cpp
// 定时检查：超过超时时间未收到报文则标记该 ECU 离线
if (now_ms - engine.last_seen_ms > engine.timeout_ms) {
    engine.online = false;
}
```

验证：

```text
启动 simulator/run_all.py
  -> Engine ECU online
停止 ecu_engine.py 超过 1 秒
  -> Engine ECU offline
```

## 验证方法

完整验证流程：

```bash
bash scripts/setup_vcan.sh

# 终端 1
./vehicle_gateway --can-in vcan0

# 终端 2
python3 simulator/run_all.py

# 终端 3
candump vcan0
```

期望网关周期性打印：

```text
speed=60 km/h, rpm=400 rpm, coolant=46 C, voltage=12.4 V, gear=D
Engine ECU online, Body ECU online, BMS ECU online
```

再做单条报文验证：

```bash
cansend vcan0 100#40063C560C000000
```

确认解析值与手算一致。

## 复盘

这篇实验最容易踩三个坑。

第一是字节序。发送端和解析端必须约定 Byte0 是低字节还是高字节，否则 `0x0640` 会被解析成 `0x4006`。

第二是信号归属。Engine ECU 只能更新转速、车速、水温；Body ECU 只能更新车门、档位、转向灯。不要让一个 CAN ID 随便改所有车辆状态，否则后面调试 ECU 离线和故障注入会乱。

第三是模拟器要稳定。项目演示时最好让模拟器输出固定且可控的数据，再通过 `fault_injector.py` 注入异常。这样博客里写出的复现步骤别人也能照着跑。

后续 Qt Dashboard 里显示的车速、水温、电压和告警，其实都来自这一层解析结果。这一层越扎实，后面的视觉融合和告警逻辑越容易解释清楚。
