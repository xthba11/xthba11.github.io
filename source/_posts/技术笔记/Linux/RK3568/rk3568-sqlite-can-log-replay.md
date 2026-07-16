---
title: RK3568 车载网关实验五：SQLite 数据记录与 CAN 报文回放
date: 2026-07-16 18:50:00
categories:
  - 技术笔记
  - Linux
  - RK3568
  - 车载网关
tags:
  - RK3568
  - Linux
  - SQLite
  - CAN回放
  - 数据记录
description: 为 RK3568 车载网关设计 SQLite 数据表，保存 CAN 原始帧、车辆信号、车道检测状态和告警记录，并实现按时间间隔回放 CAN 报文用于故障复现。
top_img: /img/covers/linux-driver-cover.svg
---

前面几篇文章已经有了 CAN 输入、信号解析和车道线检测。接下来要做数据记录。

如果项目只能实时显示状态，演示结束后就没有证据。加入 SQLite 后，可以保存原始 CAN 帧、解析信号、车道检测状态和告警记录。更重要的是，历史 CAN 报文可以回放，用来复现水温过高、电压过低、车门打开、DTC 和车道偏离等场景。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS。
- 目标板/芯片：RK3568 Linux 开发板。
- 内核/SDK/编译器版本：SQLite3，C++11，Linux SocketCAN。
- 使用工具：`sqlite3`、`libsqlite3-dev`、`cansend`、`candump`、`cmake`、`g++`。
- 数据库文件：`gateway.db`。
- 关联模块：CAN 原始帧记录、车辆信号记录、车道状态记录、告警记录、报文回放。

安装依赖：

```bash
sudo apt install -y sqlite3 libsqlite3-dev
```

## 问题背景

RK3568 车载网关项目里有四类数据需要落盘：

- 原始 CAN 帧：用于复现和回放。
- 车辆信号：用于观察解析结果是否正确。
- 车道检测状态：用于分析视觉算法是否稳定。
- 告警记录：用于证明规则触发和恢复是否正常。

数据流：

```text
CanReceiver -> can_raw_log
SignalParser -> vehicle_signal_log
LaneDetector -> lane_status_log
AlarmManager -> alarm_log
```

存储模块不应该阻塞 CAN 接收线程。比较稳的做法是把记录写入存储队列，由 StorageThread 异步批量写 SQLite。

## 数据表设计

CAN 原始帧：

```sql
-- CAN 原始帧记录表：存储所有接收到的 CAN 报文，用于回放和故障复现
CREATE TABLE IF NOT EXISTS can_raw_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
    timestamp INTEGER,                     -- 接收时间戳（毫秒）
    can_if TEXT,                           -- 来源接口名（vcan0 / can0）
    can_id TEXT,                           -- CAN 帧 ID（十六进制字符串）
    dlc INTEGER,                           -- 数据长度（0~8）
    data TEXT                              -- 数据载荷（十六进制字符串，空格分隔）
);
```

车辆信号：

```sql
-- 车辆信号解析记录表：存储从 CAN 帧解析出的物理量
CREATE TABLE IF NOT EXISTS vehicle_signal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
    timestamp INTEGER,                     -- 解析时间戳（毫秒）
    signal_name TEXT,                      -- 信号名称（如 vehicle_speed, engine_rpm）
    value REAL,                            -- 解析后的物理值
    unit TEXT                              -- 物理单位（如 km/h, rpm, C, V）
);
```

车道检测：

```sql
-- 车道检测状态记录表：存储每帧车道线检测结果
CREATE TABLE IF NOT EXISTS lane_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
    timestamp INTEGER,                     -- 检测时间戳（毫秒）
    lane_detected INTEGER,                 -- 是否检测到车道线（0/1）
    left_lane_detected INTEGER,            -- 是否检测到左侧车道线（0/1）
    right_lane_detected INTEGER,           -- 是否检测到右侧车道线（0/1）
    lane_center_x REAL,                    -- 车道中心 X 坐标（像素）
    vehicle_center_x REAL,                 -- 车辆中心 X 坐标（像素）
    center_offset_px REAL,                 -- 车辆相对车道中心的偏移量（像素）
    lane_lost INTEGER,                     -- 是否丢失车道线（0/1）
    departure_warning INTEGER              -- 是否触发偏离预警（0/1）
);
```

告警记录：

```sql
-- 告警记录表：存储所有触发的告警及其生命周期
CREATE TABLE IF NOT EXISTS alarm_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
    timestamp INTEGER,                     -- 告警触发时间戳（毫秒）
    alarm_type TEXT,                       -- 告警类型（coolant_high / voltage_low / door_open_running / dtc）
    alarm_level TEXT,                      -- 告警级别（critical / warning）
    description TEXT,                      -- 告警描述信息
    status TEXT                            -- 告警状态（active / cleared）
);
```

## SQLite 初始化

封装一个简单的存储类：

```cpp
class StorageManager {
public:
    // 打开数据库文件并初始化表结构
    bool open(const std::string& path);
    // 创建全部数据表（can_raw_log, vehicle_signal_log, lane_status_log, alarm_log）
    bool initTables();
    // 插入原始 CAN 帧记录
    bool insertCanRaw(const CanFrame& frame);
    // 插入解析后的车辆信号值
    bool insertSignal(const SignalValue& signal, std::uint64_t timestamp_ms);
    // 插入车道检测状态
    bool insertLaneStatus(const LaneStatus& status);
    // 插入告警记录
    bool insertAlarm(const Alarm& alarm);
    // 关闭数据库连接
    void close();

private:
    sqlite3* db_ = nullptr;  // SQLite3 数据库句柄
};
```

打开数据库：

```cpp
bool StorageManager::open(const std::string& path)
{
    // 打开（或创建）SQLite 数据库文件
    if (sqlite3_open(path.c_str(), &db_) != SQLITE_OK) {
        std::cerr << "[DB] open failed: " << sqlite3_errmsg(db_) << "\n";
        return false;
    }
    // 自动建表，确保数据库结构就绪
    return initTables();
}
```

## 验证方法

启动网关和模拟器：

```bash
bash scripts/setup_vcan.sh
./vehicle_gateway --can-in vcan0 --db gateway.db
python3 simulator/run_all.py
```

查询数据库：

```bash
sqlite3 gateway.db
```

执行：

```sql
.tables                                           -- 列出所有数据表
select * from can_raw_log limit 10;               -- 查看最近10条CAN原始帧
select * from vehicle_signal_log limit 10;        -- 查看最近10条车辆信号
select * from lane_status_log limit 10;           -- 查看最近10条车道状态
select * from alarm_log limit 10;                 -- 查看最近10条告警记录
```

期望能看到：

```text
can_raw_log:
1|1721111111000|vcan0|0x100|8|40 06 3C 56 0C 00 00 00

vehicle_signal_log:
1|1721111111000|vehicle_speed|60.0|km/h
2|1721111111000|engine_rpm|400.0|rpm
3|1721111111000|coolant_temp|46.0|C
```

注入故障：

```bash
python3 simulator/fault_injector.py --type coolant_high
```

查询告警：

```sql
-- 查询最近5条告警记录，按时间倒序排列
select timestamp, alarm_type, alarm_level, description, status
from alarm_log
order by id desc
limit 5;
```

期望：

```text
coolant_high|critical|coolant temperature too high|active
```

## CAN 报文回放

回放模块的目标是复现历史故障场景。

流程：

```text
从 can_raw_log 按 timestamp 排序读取报文
  -> 根据相邻 timestamp 计算延时
  -> 按 1x/2x/5x 倍速 sleep
  -> 使用 SocketCAN 重新发送到 vcan0/can0
  -> 网关重新解析并触发相同状态和告警
```

回放命令设计：

```bash
# 1x 倍速回放：按原始时间间隔依次重放 CAN 报文
./can_replay --db gateway.db --if vcan0 --speed 1
# 5x 倍速回放：加速5倍，用于快速复现故障场景
./can_replay --db gateway.db --if vcan0 --speed 5
```

验收流程：

```text
1. 启动模拟器。
2. 注入水温过高故障。
3. 确认 CAN 原始帧和告警入库。
4. 停止模拟器。
5. 启动回放。
6. 系统再次出现相同车辆状态和告警。
```

## 性能注意点

SQLite 写入如果每条都单独提交，性能会比较差。可以做几个优化：

- 使用 prepared statement。
- 批量事务提交。
- 存储线程异步写入。
- 对常用查询字段建立索引。

示例索引：

```sql
-- 为常用查询字段建立索引以加速回放和检索
CREATE INDEX IF NOT EXISTS idx_can_raw_timestamp ON can_raw_log(timestamp);  -- 按时间排序回放
CREATE INDEX IF NOT EXISTS idx_alarm_timestamp ON alarm_log(timestamp);       -- 按时间检索告警
CREATE INDEX IF NOT EXISTS idx_alarm_type ON alarm_log(alarm_type);           -- 按类型筛选告警
```

如果 CAN 帧率较高，建议每 100 条或每 500ms 提交一次事务：

```sql
BEGIN TRANSACTION;   -- 开始批量事务，减少磁盘 I/O
-- insert many rows  -- 在此之间执行多条 INSERT 语句
COMMIT;              -- 提交事务，所有插入一次性写入磁盘
```

## 复盘

SQLite 模块不是为了“项目显得复杂”，而是让项目具备可证明性。

有了数据库后，我可以在文章和演示里拿出具体证据：

- 某条 CAN 原始帧是什么。
- 这条帧解析出了什么信号。
- 当时车道偏移是多少。
- 告警是什么时间触发的。
- 回放后是否能复现同样告警。

这会让 RK3568 车载网关项目更像一个完整系统，而不是几个 demo 拼在一起。

后续我会把数据库查询结果整理进 `docs/测试记录/`，例如：

```text
coolant_high_test.md
door_open_running_test.md
lane_departure_test.md
can_replay_test.md
```

每个测试记录都包含输入报文、期望信号、实际日志、数据库查询和复盘。这样博客、README 和面试讲解都能互相支撑。
