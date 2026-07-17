---
title: 用 LittleFS 保存骑行记录：外部 Flash 文件系统在 STM32 码表中的应用
date: 2026-07-16 11:10:00
categories:
  - 项目实战
  - RidePulse
  - 存储系统
tags:
  - LittleFS
  - 外部 Flash
  - STM32
  - 自行车码表
  - 骑行记录
description: 基于现有外部 Flash 和 LittleFS 移植，为 RidePulse 自行车码表设计骑行记录结构体、保存流程、历史记录读取和断电保护策略。
cover: /img/covers/articles/ridepulse-littlefs-ride-record.svg
top_img: /img/covers/articles/ridepulse-littlefs-ride-record.svg
---

码表如果只能显示当前速度和里程，它更像一个实时仪表。加入骑行记录后，项目才更像完整设备：每次骑行结束后，可以保存总里程、骑行时间、平均速度、最大速度、心率等摘要，后续在历史页面查看。

当前工程已经有外部 Flash 管理和 LittleFS 移植，因此 RidePulse 不需要从零实现文件系统。我们要做的是基于现有存储能力，设计一套适合码表的骑行记录保存流程。

## 当前存储基础

现有相关目录：

```text
05_Service/Service_ExternflashManage/service_externflash_manage.c
05_Service/Service_ExternflashManage/service_externflash_manage.h
02_Middleware_Platform/LittleFS/
02_BSP_Platform/Bsp_Drivers/ExternStorage_Flash/
```

`storage_manager_task()` 中已经有 LittleFS 测试逻辑：

```c
lfs_port_init();

int err = lfs_mount(&lfs, &lfs_w25q64_cfg);

if (err) {
    lfs_format(&lfs, &lfs_w25q64_cfg);
    lfs_mount(&lfs, &lfs_w25q64_cfg);
}

lfs_file_open(&lfs, &file, "boot_count", LFS_O_RDWR | LFS_O_CREAT);
```

这说明项目已经具备：

- 外部 Flash 端口初始化。
- LittleFS 配置。
- 文件挂载。
- 首次失败后格式化。
- 文件读写。

下一步是把测试用的 `boot_count` 改造成正式的骑行记录文件。

## 为什么用 LittleFS

外部 Flash 也可以按固定地址裸写，但我更建议用 LittleFS。

原因：

- 骑行记录是变长或多条记录，不适合手动管理裸地址。
- LittleFS 对掉电场景更友好。
- 文件名天然适合按时间组织。
- 后续做历史记录页面更方便。
- 可以同时保存配置、骑行记录、UI 资源等不同类型数据。

裸写适合 OTA 分区、资源区这类固定地址数据。骑行记录更适合文件系统。

## 记录内容设计

第一阶段不要保存完整轨迹，只保存摘要。因为当前还没有 GPS 轨迹数据，保存摘要已经足够展示存储能力。

建议结构体：

```c
#define RIDE_RECORD_MAGIC   0x52494445U  /* "RIDE" */
#define RIDE_RECORD_VERSION 1U

typedef struct {
    uint32_t magic;                /* 魔数 0x52494445 ("RIDE")，用于校验文件类型 */
    uint16_t version;              /* 结构体版本号，用于后续兼容性升级 */
    uint16_t size;                 /* 结构体总大小，读取时校验完整性 */

    uint32_t start_timestamp;      /* 骑行开始时间戳 (Unix 时间或系统 tick) */
    uint32_t end_timestamp;        /* 骑行结束时间戳 */
    uint32_t distance_m;           /* 本次骑行总里程，单位米 */
    uint32_t ride_time_s;          /* 本次骑行总时长，单位秒 */

    uint32_t avg_speed_x10_kmh;    /* 平均速度，km/h * 10（定点数） */
    uint32_t max_speed_x10_kmh;    /* 最高速度，km/h * 10（定点数） */

    uint16_t avg_heart_rate;       /* 平均心率 */
    uint16_t max_heart_rate;       /* 最高心率 */

    uint32_t checksum;             /* 简单校验和，保存前计算，读取后验证 */
} ride_record_t;
```

字段说明：

| 字段 | 说明 |
|---|---|
| `magic` | 判断文件是不是骑行记录 |
| `version` | 后续结构体升级时兼容 |
| `size` | 结构体大小 |
| `start_timestamp` | 骑行开始时间 |
| `end_timestamp` | 骑行结束时间 |
| `distance_m` | 总里程 |
| `ride_time_s` | 骑行时间 |
| `avg_speed_x10_kmh` | 平均速度，单位 km/h * 10 |
| `max_speed_x10_kmh` | 最大速度，单位 km/h * 10 |
| `avg_heart_rate` | 平均心率 |
| `max_heart_rate` | 最大心率 |
| `checksum` | 简单校验 |

`timestamp` 第一阶段可以先用 RTC 转换成 Unix 时间。如果暂时没有 Unix 时间接口，也可以先用系统 tick 或手动年月日组合。

## 文件组织

建议文件路径：

```text
/rides/
  ride_20260716_083000.dat
  ride_20260717_191500.dat
```

文件名中带开始时间，方便排序和调试。

如果 RTC 时间还没准备好，也可以先用序号：

```text
/rides/
  ride_000001.dat
  ride_000002.dat
```

序号可以保存在一个索引文件：

```text
/rides/index.dat
```

第一阶段建议先用序号，减少 RTC 格式化复杂度。等 RTC 时间稳定后，再换成时间文件名。

## 新增模块建议

新增：

```text
05_Service/Service_RideRecord/
  ride_record_storage.c
  ride_record_storage.h
```

或者放到 `05_Service/Service_Ride/` 下：

```text
05_Service/Service_Ride/
  ride_computer.c
  ride_computer.h
  ride_record_storage.c
  ride_record_storage.h
```

职责：

- 挂载 LittleFS。
- 创建 `/rides` 目录。
- 保存一条骑行记录。
- 读取最近记录。
- 删除旧记录。
- 校验记录合法性。

## 头文件设计

```c
#ifndef RIDE_RECORD_STORAGE_H
#define RIDE_RECORD_STORAGE_H

#include <stdint.h>
#include <stdbool.h>

#define RIDE_RECORD_MAGIC   0x52494445U  /* 魔数 "RIDE"，标记文件为骑行记录 */
#define RIDE_RECORD_VERSION 1U           /* 结构体版本 */

typedef struct {
    uint32_t magic;                /* 魔数 */
    uint16_t version;              /* 版本号 */
    uint16_t size;                 /* 结构体大小 */

    uint32_t start_timestamp;      /* 开始时间戳 */
    uint32_t end_timestamp;        /* 结束时间戳 */
    uint32_t distance_m;           /* 总里程 (米) */
    uint32_t ride_time_s;          /* 骑行时长 (秒) */

    uint32_t avg_speed_x10_kmh;    /* 平均速度 km/h * 10 */
    uint32_t max_speed_x10_kmh;    /* 最高速度 km/h * 10 */

    uint16_t avg_heart_rate;       /* 平均心率 */
    uint16_t max_heart_rate;       /* 最高心率 */

    uint32_t checksum;             /* 校验和 */
} ride_record_t;

int ride_record_storage_init(void);
int ride_record_save(const ride_record_t *record);
int ride_record_load_latest(ride_record_t *record);
int ride_record_load_by_index(uint32_t index, ride_record_t *record);
int ride_record_get_count(uint32_t *count);

#endif
```

## 校验函数

先用简单 checksum，不追求复杂：

```c
static uint32_t ride_record_checksum(const ride_record_t *record)
{
    /* 简单校验和：遍历结构体中除 checksum 字段外的所有字节，累加求和 */
    const uint8_t *p = (const uint8_t *)record;
    uint32_t sum = 0;
    uint32_t len = sizeof(ride_record_t) - sizeof(record->checksum);  /* 排除 checksum 自身 */

    for (uint32_t i = 0; i < len; i++) {
        sum += p[i];
    }

    return sum;
}
```

保存前：

```c
ride_record_t rec = *record;

rec.magic = RIDE_RECORD_MAGIC;
rec.version = RIDE_RECORD_VERSION;
rec.size = sizeof(ride_record_t);
rec.checksum = ride_record_checksum(&rec);
```

读取后：

```c
if (rec.magic != RIDE_RECORD_MAGIC) {
    return -1;
}

if (rec.size != sizeof(ride_record_t)) {
    return -1;
}

if (rec.checksum != ride_record_checksum(&rec)) {
    return -1;
}
```

## 挂载文件系统

当前工程的 `storage_manager_task()` 已经做过挂载。后续要注意：不要多个任务同时挂载/卸载同一个 LittleFS。

比较推荐的做法：

- `ExtFlashTask` 启动时挂载一次。
- 系统运行期间保持挂载。
- 所有文件操作通过存储服务完成。

初始化示例：

```c
int ride_record_storage_init(void)
{
    int err;

    lfs_port_init();  /* 初始化外部 Flash 端口驱动 */

    /* 尝试挂载 LittleFS，首次启动或文件系统损坏时自动格式化 */
    err = lfs_mount(&lfs, &lfs_w25q64_cfg);
    if (err) {
        err = lfs_format(&lfs, &lfs_w25q64_cfg);  /* 格式化文件系统 */
        if (err) {
            return err;
        }

        err = lfs_mount(&lfs, &lfs_w25q64_cfg);   /* 格式化后重新挂载 */
        if (err) {
            return err;
        }
    }

    /* 创建 rides 目录，已存在则忽略 LFS_ERR_EXIST 错误 */
    err = lfs_mkdir(&lfs, "rides");
    if (err && err != LFS_ERR_EXIST) {
        return err;
    }

    return 0;
}
```

注意：

- `lfs_mkdir()` 如果目录已存在，会返回 `LFS_ERR_EXIST`，这不算错误。
- 第一阶段可以继续沿用现有全局 `lfs` 对象。
- 后续要清理测试用的 `boot_count` 逻辑，避免每次启动都格式化或干扰正式数据。

## 记录序号管理

用序号文件保存下一条记录编号：

```text
rides/index.dat
```

结构：

```c
typedef struct {
    uint32_t next_index;
    uint32_t record_count;
    uint32_t checksum;
} ride_record_index_t;
```

第一阶段也可以简化：保存时扫描目录，找到最大编号再加 1。但扫描目录代码稍微复杂。

更简单的序号读取：

```c
static int ride_record_read_index(uint32_t *next_index)
{
    lfs_file_t file;
    int err;
    uint32_t value = 1;

    /* 尝试打开序号文件，如果不存在则从 1 开始 */
    err = lfs_file_open(&lfs, &file, "rides/index.dat", LFS_O_RDONLY);
    if (err) {
        *next_index = 1;
        return 0;
    }

    lfs_file_read(&lfs, &file, &value, sizeof(value));
    lfs_file_close(&lfs, &file);

    if (value == 0) {
        value = 1;  /* 防止序号为 0，导致文件名为 ride_000000.dat */
    }

    *next_index = value;
    return 0;
}
```

写回：

```c
static int ride_record_write_index(uint32_t next_index)
{
    lfs_file_t file;
    int err;

    /* 以覆盖写方式打开序号文件，保存下一条记录的编号 */
    err = lfs_file_open(&lfs, &file, "rides/index.dat",
                        LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC);
    if (err) {
        return err;
    }

    lfs_file_write(&lfs, &file, &next_index, sizeof(next_index));
    lfs_file_close(&lfs, &file);

    return 0;
}
```

## 保存一条骑行记录

```c
int ride_record_save(const ride_record_t *record)
{
    lfs_file_t file;
    ride_record_t rec;
    uint32_t next_index;
    char path[32];
    int err;

    if (record == NULL) {
        return -1;
    }

    /* 读取当前序号，生成文件名 rides/ride_xxxxxx.dat */
    err = ride_record_read_index(&next_index);
    if (err) {
        return err;
    }

    snprintf(path, sizeof(path), "rides/ride_%06lu.dat", next_index);

    /* 拷贝记录并填入头部元信息与校验和 */
    rec = *record;
    rec.magic = RIDE_RECORD_MAGIC;
    rec.version = RIDE_RECORD_VERSION;
    rec.size = sizeof(ride_record_t);
    rec.checksum = 0;                              /* 先清零再计算 */
    rec.checksum = ride_record_checksum(&rec);     /* 计算除 checksum 外所有字段的校验和 */

    /* 创建新文件并写入结构体 */
    err = lfs_file_open(&lfs, &file, path,
                        LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC);
    if (err) {
        return err;
    }

    err = lfs_file_write(&lfs, &file, &rec, sizeof(rec));
    if (err < 0) {
        lfs_file_close(&lfs, &file);
        return err;
    }

    lfs_file_sync(&lfs, &file);   /* 强制将缓存刷入 Flash，降低掉电丢数据风险 */
    lfs_file_close(&lfs, &file);

    ride_record_write_index(next_index + 1U);  /* 更新序号文件，为下一条记录准备 */

    DEBUG_OUT("ride save ok path=%s distance=%lu time=%lu",
              path, rec.distance_m, rec.ride_time_s);

    return 0;
}
```

`lfs_file_sync()` 很重要，它会尽量把缓存写入 Flash，降低掉电丢数据风险。

## RideTask 结束时生成记录

在 `ride_computer.c` 中：

```c
static void ride_build_record(ride_record_t *record)
{
    /* 从 RideService 内部结构体组装骑行记录，用于保存到 Flash */
    memset(record, 0, sizeof(*record));

    record->start_timestamp = s_ride.start_timestamp;
    record->end_timestamp = rtc_get_unix_timestamp();  /* 如果 RTC 接口未就绪，可改用系统 tick */
    record->distance_m = s_ride.distance_m;
    record->ride_time_s = s_ride.ride_time_s;
    record->avg_speed_x10_kmh = s_ride.avg_speed_x10_kmh;
    record->max_speed_x10_kmh = s_ride.max_speed_x10_kmh;
    record->avg_heart_rate = s_ride.avg_heart_rate;
    record->max_heart_rate = s_ride.max_heart_rate;
}

void ride_stop_and_save(void)
{
    ride_record_t record;

    s_ride.state = RIDE_STATE_SAVING;    /* 进入保存状态，UI 可显示 "SAVING" */
    ride_build_record(&record);          /* 组装记录结构体 */

    if (ride_record_save(&record) == 0) {
        DEBUG_OUT("ride record saved");
    } else {
        DEBUG_OUT("ride record save failed");
    }

    s_ride.state = RIDE_STATE_IDLE;      /* 保存完成后回到空闲状态 */
}
```

如果暂时没有 `rtc_get_unix_timestamp()`，可以先这样：

```c
record->start_timestamp = s_ride.start_tick_ms / 1000U;
record->end_timestamp = osal_task_get_tick_count() / 1000U;
```

后续再替换成真实 RTC。

## 读取最新记录

如果用 `index.dat` 保存下一条编号，则最新记录编号是 `next_index - 1`。

```c
int ride_record_load_latest(ride_record_t *record)
{
    uint32_t next_index;

    if (record == NULL) {
        return -1;
    }

    if (ride_record_read_index(&next_index) != 0) {
        return -1;
    }

    if (next_index <= 1) {
        return -1;
    }

    return ride_record_load_by_index(next_index - 1U, record);
}
```

按编号读取：

```c
int ride_record_load_by_index(uint32_t index, ride_record_t *record)
{
    lfs_file_t file;
    ride_record_t rec;
    char path[32];
    int err;

    if (record == NULL || index == 0) {
        return -1;
    }

    snprintf(path, sizeof(path), "rides/ride_%06lu.dat", index);

    /* 以只读方式打开骑行记录文件 */
    err = lfs_file_open(&lfs, &file, path, LFS_O_RDONLY);
    if (err) {
        return err;
    }

    err = lfs_file_read(&lfs, &file, &rec, sizeof(rec));
    lfs_file_close(&lfs, &file);

    if (err != sizeof(rec)) {
        return -1;  /* 读取长度不匹配，文件可能损坏或格式不一致 */
    }

    /* 三重校验：魔数、结构体大小、校验和，任意一项不通过则拒绝 */
    if (rec.magic != RIDE_RECORD_MAGIC) {
        return -1;
    }

    if (rec.size != sizeof(ride_record_t)) {
        return -1;
    }

    if (rec.checksum != ride_record_checksum(&rec)) {
        return -1;
    }

    *record = rec;
    return 0;
}
```

## 历史记录页面的数据来源

LVGL 的 `RideHistory` 页面不要直接操作 LittleFS。建议：

```text
RideHistory 页面
  -> lvgl_history_request()
  -> RideRecordService 读取最近 N 条
  -> 写入 lvgl_port 的 history cache
  -> LVGLTask 显示
```

第一阶段可以简单一点：

- 页面加载时读取最新一条记录。
- 显示距离、时间、平均速度。

示例 UI 文案：

```text
Last Ride
12.34 km
00:38:21
Avg 19.3 km/h
Max 32.8 km/h
```

## 保存策略

不要每秒都写 Flash。Flash 有擦写寿命，LittleFS 虽然有磨损均衡，但也不应该高频写。

推荐：

- 骑行中只在 RAM 中累计。
- 用户结束骑行时保存一次摘要。
- 如果担心异常断电，每 1 分钟保存一次临时记录。
- 正式记录和临时记录分开。

临时记录路径：

```text
rides/current.tmp
```

结束骑行后：

```text
current.tmp -> ride_000123.dat
```

第一阶段可以不做临时记录，先完成结束保存。

## 断电保护思路

如果要做得更稳，可以这样：

1. 骑行开始时创建 `rides/current.tmp`。
2. 骑行中每 60 秒更新一次。
3. 骑行结束时写正式文件。
4. 正式文件写成功后删除 `current.tmp`。
5. 下次开机如果发现 `current.tmp`，提示恢复未完成骑行。

流程：

```text
start ride
  -> write current.tmp
every 60s
  -> update current.tmp
stop ride
  -> write ride_xxxxxx.dat
  -> delete current.tmp
boot
  -> if current.tmp exists, recover
```

这部分可以作为后续优化文章。

## Flash 写入与任务阻塞

当前可以直接在 `ride_stop_and_save()` 中调用 `ride_record_save()`，方便跑通。

但更合理的设计是：

```text
RideTask
  -> RideRecordQueue
  -> ExtFlashTask
  -> LittleFS write
```

原因：

- Flash 写入可能耗时。
- LittleFS 操作可能等待擦除。
- RideTask 不应该长期阻塞。

后续可以新增事件：

```c
#define EVENT_RIDE_RECORD  (1U << 3)
```

在 `storage_manager_task()` 里处理：

```c
case EVENT_RIDE_RECORD:
    ride_record_save_from_queue();
    break;
```

第一阶段先直接保存，第二阶段再异步化。

## 调试日志

建议加这些日志：

```text
LittleFS mount ok
rides dir ready
ride save ok path=rides/ride_000001.dat distance=12340 time=2301
ride load latest ok distance=12340 avg=19.3
ride record checksum error
```

不要高频打印 Flash 写入过程，只打印关键结果。

## 测试方法

### 1. 启动挂载测试

期望日志：

```text
LittleFS mount ok
rides dir ready
```

如果是第一次启动：

```text
LittleFS mount failed, format
LittleFS mount ok
```

### 2. 保存假记录

写一个测试函数：

```c
void ride_record_test_save(void)
{
    ride_record_t rec;

    memset(&rec, 0, sizeof(rec));
    rec.start_timestamp = 1000;
    rec.end_timestamp = 2000;
    rec.distance_m = 12340;
    rec.ride_time_s = 2301;
    rec.avg_speed_x10_kmh = 193;
    rec.max_speed_x10_kmh = 328;
    rec.avg_heart_rate = 142;
    rec.max_heart_rate = 171;

    ride_record_save(&rec);
}
```

期望：

```text
ride save ok path=rides/ride_000001.dat distance=12340 time=2301
```

### 3. 读取最新记录

```c
void ride_record_test_load(void)
{
    ride_record_t rec;

    if (ride_record_load_latest(&rec) == 0) {
        DEBUG_OUT("latest ride distance=%lu time=%lu avg=%lu.%lu",
                  rec.distance_m,
                  rec.ride_time_s,
                  rec.avg_speed_x10_kmh / 10U,
                  rec.avg_speed_x10_kmh % 10U);
    }
}
```

期望：

```text
latest ride distance=12340 time=2301 avg=19.3
```

### 4. 断电测试

第一阶段可以简单测试：

- 保存记录后立即复位。
- 重启后读取最新记录。
- 确认记录还在。

如果记录偶尔丢失，检查：

- 是否调用 `lfs_file_sync()`。
- 是否正确 `lfs_file_close()`。
- Flash 驱动是否真的写入成功。
- 是否启动时错误格式化了文件系统。

## 常见问题

### 每次开机记录都没了

最可能原因：

- 启动时每次都调用 `lfs_format()`。
- mount 失败处理逻辑太粗暴。

正确做法：

```c
err = lfs_mount(&lfs, &lfs_w25q64_cfg);
if (err) {
    /* 只有首次或文件系统损坏时才 format */
    lfs_format(&lfs, &lfs_w25q64_cfg);
    lfs_mount(&lfs, &lfs_w25q64_cfg);
}
```

调试时要确认 mount 失败的原因，不要无脑格式化。

### 保存很慢

可能原因：

- Flash 擦除耗时。
- LittleFS 需要分配新块。
- 任务优先级不合理。

解决：

- 骑行结束后再保存，不要骑行中频繁保存。
- 后续改成异步保存。
- 保存时 UI 显示 `SAVING`。

### 校验失败

可能原因：

- `checksum` 计算前没有先置 0。
- 结构体对齐变化。
- 读取长度不等于结构体长度。
- 文件内容不是骑行记录。

保存前一定要：

```c
rec.checksum = 0;
rec.checksum = ride_record_checksum(&rec);
```

### 文件越来越多

后续需要做记录数量限制，例如只保留最近 100 条：

```text
ride_000001.dat
...
ride_000100.dat
```

超过后删除最旧记录，或循环覆盖。

第一阶段可以先不做删除。

## 与项目页面的展示方式

博客里展示 LittleFS 骑行记录时，建议贴这些内容：

- 文件系统挂载日志。
- `ride_record_t` 结构体。
- 保存记录代码。
- 读取最新记录代码。
- 一段真实串口输出。

这样读者能看到你不是只写概念，而是真的把外部 Flash 跑起来了。

## 小结

这一篇把 RidePulse 从“实时码表”推进到“可记录设备”：

- 使用 LittleFS 保存骑行摘要。
- 设计 `ride_record_t` 结构体。
- 使用 `/rides/ride_xxxxxx.dat` 管理历史记录。
- 保存前写 magic、version、size、checksum。
- 读取时校验记录合法性。
- 第一阶段结束时保存一次，后续再做断电恢复和异步写入。

到这里，RidePulse 的核心链路已经比较完整：

```text
轮速传感器
  -> RideTask 计算速度/里程
  -> LVGL 显示
  -> LittleFS 保存骑行记录
```

后续可以继续完善 GPS、历史记录页面、低功耗骑行策略和 OTA 升级流程。
