---
title: AHT21 温湿度传感器 I2C 驱动开发（Bicycle_Watch 实战）
date: 2026-07-20
categories:
  - 项目实战
  - BSP开发
tags:
  - BSP
  - AHT21
  - I2C
  - 温湿度传感器
  - CRC-8
  - 驱动开发
  - Bicycle_Watch
description: AHT21 温湿度传感器 I2C 驱动完整开发：I2C 读写时序（软件模拟 GPIO）、测量命令序列（0xAC+0x33+0x00）、80ms 等待+状态轮询、6 字节数据读取拼装、温湿度计算公式推导、CRC-8 校验实现
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# AHT21 温湿度传感器 I2C 驱动开发

## 1. AHT21 硬件特性

AHT21 是奥松电子推出的高精度温湿度传感器，Bicycle_Watch 用它来采集环境数据并显示在表盘上：

| 参数 | 规格 |
|------|------|
| 接口 | I2C（标准模式 100kHz / 快速模式 400kHz） |
| 供电 | 2.2V ~ 5.5V |
| 温度范围 | -40°C ~ +85°C |
| 温度精度 | ±0.3°C |
| 湿度范围 | 0% ~ 100% RH |
| 湿度精度 | ±2% RH |
| 测量时间 | 约 80ms |
| I2C 地址 | 0x38（7-bit，写 0x70，读 0x71） |
| 封装 | SMD（3×3mm） |

## 2. I2C 通信基础

### 2.1 AHT21 的 I2C 操作

Bicycle_Watch 使用**软件 I2C**（GPIO 模拟）与 AHT21 通信。每个 I2C 操作都是标准的起始→地址→数据→停止序列：

```
I2C 写操作（向 AHT21 发送测量命令）:
  START → 0x70(W) → ACK → 0xAC → ACK → 0x33 → ACK → 0x00 → ACK → STOP

I2C 读操作（从 AHT21 读取温湿度数据）:
  START → 0x71(R) → ACK → [Byte1] ACK → [Byte2] ACK → ... → [Byte6] NACK → STOP

I2C 状态读取:
  START → 0x71(R) → ACK → [STATUS] NACK → STOP
```

### 2.2 寄存器地址定义

```c
// bsp_aht21_reg.h — AHT21 寄存器定义

// I2C 7-bit 地址: 0x38
// 写地址 = (0x38 << 1) | 0 = 0x70
// 读地址 = (0x38 << 1) | 1 = 0x71
#define AHT21_REG_READ_ADDR          0x71
#define AHT21_REG_WRITE_ADDR         0x70

// 测量命令（触发一次温湿度转换）
#define AHT21_REG_MEASURE_CMD        0xAC
#define AHT21_REG_MEASURE_CMD_ARGS1  0x33
#define AHT21_REG_MEASURE_CMD_ARGS2  0x00

// 只有 3 个寄存器宏，整个驱动非常简单
```

## 3. 驱动实现：完整数据读取流程

### 3.1 测量触发序列

```c
// aht21_read_temp_humi() 的核心流程

static aht21_status_t aht21_read_temp_humi(
    bsp_aht21_driver_t *const p_aht21_instance,
    float *const temp,
    float *const humi)
{
    uint8_t byte_1~6;    // 6 字节传感器原始数据
    uint32_t retu_data;  // 中间计算变量

    // ====== 第 1 步：发送测量命令 ======
    // 进入临界区（软件 I2C 需要保护 GPIO 操作不被中断打断）
    p_aht21_instance->p_iic_driver_instance->pf_critical_enter();

    // I2C START
    p_aht21_instance->p_iic_driver_instance->pf_iic_start(NULL);

    // 发送写地址 0x70 → 等 ACK
    p_aht21_instance->p_iic_driver_instance->pf_iic_send_byte(
        NULL, AHT21_REG_WRITE_ADDR);
    p_aht21_instance->p_iic_driver_instance->pf_iic_wait_ack(NULL);

    // 发送测量命令 0xAC → 等 ACK
    p_aht21_instance->p_iic_driver_instance->pf_iic_send_byte(
        NULL, AHT21_REG_MEASURE_CMD);
    p_aht21_instance->p_iic_driver_instance->pf_iic_wait_ack(NULL);

    // 发送参数1 0x33 → 等 ACK
    p_aht21_instance->p_iic_driver_instance->pf_iic_send_byte(
        NULL, AHT21_REG_MEASURE_CMD_ARGS1);
    p_aht21_instance->p_iic_driver_instance->pf_iic_wait_ack(NULL);

    // 发送参数2 0x00 → 等 ACK
    p_aht21_instance->p_iic_driver_instance->pf_iic_send_byte(
        NULL, AHT21_REG_MEASURE_CMD_ARGS2);
    p_aht21_instance->p_iic_driver_instance->pf_iic_wait_ack(NULL);

    // I2C STOP
    p_aht21_instance->p_iic_driver_instance->pf_iic_stop(NULL);

    // 退出临界区
    p_aht21_instance->p_iic_driver_instance->pf_critical_exit();
```

### 3.2 等待转换完成（80ms + 状态轮询）

```c
    // ====== 第 2 步：等待 AHT21 完成测量 ======

    // ① 首先等待至少 80ms（AHT21 数据手册规定的测量时间）
    //    使用 RTOS 的非阻塞延迟——释放 CPU 给其他任务
    p_aht21_instance->p_yield_instance->pf_rtos_yield(80);

    // ② 读取状态寄存器，检查 bit[7]（Busy 标志）
    //    如果 Busy = 1 → 传感器还在测量 → 再等 5ms → 重试
    //    最多重试 5 次（总超时 = 80 + 5×5 = 105ms）
    uint8_t cnt = 5;
    while ((0x80 == (aht21_read_status(p_aht21_instance) & 0x80)) && cnt) {
        p_aht21_instance->p_yield_instance->pf_rtos_yield(5);
        cnt--;
        if (0 == cnt) {
            return AHT21_ERRORTIMEOUT;  // 超时报错
        }
    }
```

### 3.3 读取 6 字节数据

```c
    // ====== 第 3 步：读取 6 字节温湿度数据 ======

    p_aht21_instance->p_iic_driver_instance->pf_critical_enter();

    // I2C START → 发送读地址 0x71
    p_aht21_instance->p_iic_driver_instance->pf_iic_start(NULL);
    p_aht21_instance->p_iic_driver_instance->pf_iic_send_byte(
        NULL, AHT21_REG_READ_ADDR);
    p_aht21_instance->p_iic_driver_instance->pf_iic_wait_ack(NULL);

    // ★ 连续读 6 字节，Master 每收一个字节回复 ACK
    //    最后一个字节回复 NACK（告知从机停止发送）
    p_aht21_instance->p_iic_driver_instance->pf_iic_receive_byte(
        NULL, &byte_1th);  p_aht21_instance->p_iic_driver_instance->pf_iic_send_ack(NULL);
    p_aht21_instance->p_iic_driver_instance->pf_iic_receive_byte(
        NULL, &byte_2th);  p_aht21_instance->p_iic_driver_instance->pf_iic_send_ack(NULL);
    p_aht21_instance->p_iic_driver_instance->pf_iic_receive_byte(
        NULL, &byte_3th);  p_aht21_instance->p_iic_driver_instance->pf_iic_send_ack(NULL);
    p_aht21_instance->p_iic_driver_instance->pf_iic_receive_byte(
        NULL, &byte_4th);  p_aht21_instance->p_iic_driver_instance->pf_iic_send_ack(NULL);
    p_aht21_instance->p_iic_driver_instance->pf_iic_receive_byte(
        NULL, &byte_5th);  p_aht21_instance->p_iic_driver_instance->pf_iic_send_ack(NULL);
    p_aht21_instance->p_iic_driver_instance->pf_iic_receive_byte(
        NULL, &byte_6th);  p_aht21_instance->p_iic_driver_instance->pf_iic_send_no_ack(NULL);

    // I2C STOP
    p_aht21_instance->p_iic_driver_instance->pf_iic_stop(NULL);
    p_aht21_instance->p_iic_driver_instance->pf_critical_exit();
```

## 4. 数据格式与计算公式

### 4.1 AHT21 6 字节数据格式

```
Byte 1: [STATUS]     状态寄存器（bit7=Busy）
Byte 2: [HUMI[19:12]] 湿度高 8 位
Byte 3: [HUMI[11:4]]  湿度中 8 位
Byte 4: [HUMI[3:0] | TEMP[19:16]] 湿度低 4 位 + 温度高 4 位
Byte 5: [TEMP[15:8]]  温度中 8 位
Byte 6: [TEMP[7:0]]   温度低 8 位

湿度原始值 = (Byte2 << 12) | (Byte3 << 4) | (Byte4 >> 4)
            = 20-bit 值
温度原始值 = ((Byte4 & 0x0F) << 16) | (Byte5 << 8) | Byte6
            = 20-bit 值
```

### 4.2 计算公式

```c
    // ====== 第 4 步：数据拼装与公式计算 ======

    // 湿度计算
    retu_data = 0;
    retu_data = (retu_data | byte_2th) << 8;   // 装入 Byte2
    retu_data = (retu_data | byte_3th) << 8;   // 装入 Byte3
    retu_data = (retu_data | byte_4th);         // 装入 Byte4
    retu_data = retu_data >> 4;                 // ★ 右移 4 位去掉温度低 4 位

    // 公式: RH(%) = (raw_humi × 1000 / 2^20) / 10
    //             = (raw_humi × 100) / 2^20
    //    → 先乘 1000 再用右移 20 位代替除法（效率优化）
    *humi = (retu_data * 1000 >> 20);
    *humi /= 10;
    // 示例: raw_humi = 524288 (50% RH 的理论中间值)
    //   = 524288 * 1000 / 1048576 = 500 → /10 → 50.0%

    // 温度计算
    retu_data = 0;
    retu_data = (retu_data | (byte_4th & 0x0f)) << 8;  // Byte4 低 4 位
    retu_data = (retu_data | byte_5th) << 8;            // 装入 Byte5
    retu_data = (retu_data | byte_6th);                  // 装入 Byte6
    retu_data = retu_data & 0xFFFFF;                     // 取 20-bit

    // 公式: T(°C) = (raw_temp × 200 / 2^20) - 50
    //    → 偏移 -50°C 是 AHT21 的特性（0 对应 -50°C → 满量程对应 +150°C）
    *temp = ((retu_data * 2000 >> 20) - 500);
    *temp /= 10;
    // 示例: raw_temp = 524288 (25°C 的理论中间值)
    //   = (524288 * 2000 / 1048576 - 500) / 10
    //   = (1000000 / 1048576 * 1000 - 500) / 10 ≈ 25.0°C

    return AHT21_OK;
}
```

### 4.3 公式图解

```
AHT21 数据 → 物理量的映射关系：

湿度:
  raw_humi = 0        → RH = 0%
  raw_humi = 524288   → RH = 50%
  raw_humi = 1048575  → RH = 100%

  RH(%) = raw_humi / 2^20 × 100%

温度:
  raw_temp = 0        → T = -50°C  (偏移)
  raw_temp = 524288   → T = 0°C
  raw_temp = 1048575  → T = +50°C

  T(°C) = raw_temp / 2^20 × 200 - 50

  为什么是 200？
    200°C = +150°C - (-50°C) = 满量程范围
    20-bit ADC = 2^20 = 1048576 个量化台阶
    每台阶 = 200°C / 1048576 ≈ 0.00019°C（远高于 ±0.3°C 精度）
```

## 5. CRC-8 校验（可选）

```c
// AHT21 支持 CRC-8 校验——第 7 个字节（Byte7）是 CRC 值
// Bicycle_Watch 的驱动实现了 CRC 计算但未强制校验
// 如果需要最高数据完整性，在读到 6 字节后再读第 7 字节做 CRC 比对

// CRC-8 多项式: x^8 + x^5 + x^4 + 1 → 0x31（或 0x131）

static uint8_t CheckCrc8(const uint8_t *p_data, const uint8_t length)
{
    uint8_t crc = 0xFF;  // 初始值

    for (uint8_t i = 0; i < length; i++) {
        crc ^= p_data[i];
        for (uint8_t j = 0; j < 8; j++) {
            if (crc & 0x80)
                crc = (crc << 1) ^ 0x31;
            else
                crc <<= 1;
        }
    }
    return crc;
}

// 对 Byte1-Byte6 计算 CRC → 与 Byte7 比较 → 不一致则丢弃
```

## 6. ID 校验与初始化

```c
// AHT21 初始化时读取设备 ID 以确认硬件连接正常

#define AHT21_ID  0x18   // AHT21 的 ID 掩码

static aht21_status_t __aht21read_id(bsp_aht21_driver_t *p_instance)
{
    uint8_t data = 0;

    p_instance->p_iic_driver_instance->pf_critical_enter();
    p_instance->p_iic_driver_instance->pf_iic_start(NULL);
    p_instance->p_iic_driver_instance->pf_iic_send_byte(
        NULL, AHT21_REG_READ_ADDR);

    if (AHT21_OK == p_instance->p_iic_driver_instance->pf_iic_wait_ack(NULL)) {
        p_instance->p_iic_driver_instance->pf_iic_receive_byte(NULL, &data);
    }
    p_instance->p_iic_driver_instance->pf_iic_stop(NULL);
    p_instance->p_iic_driver_instance->pf_critical_exit();

    // bit[3] 为 1 表示 AHT21（区别于 AHT20 等）
    if (AHT21_ID == (data & AHT21_ID)) {
        return AHT21_OK;
    }
    return AHT21_ERRORRESOURCE;  // 传感器不存在或型号不匹配
}
```

## 7. 完整调用时序

```
Service Layer (service_sensor.c)
    │ sensor_temp_humi() 每 10 秒调用一次
    ▼
bsp_aht21_driver_t::pf_read_temp_humi()
    │
    ├── ① 临界区进入
    ├── ② I2C START → 0x70(W) → ACK
    ├── ③ 0xAC → ACK → 0x33 → ACK → 0x00 → ACK
    ├── ④ I2C STOP
    ├── ⑤ 临界区退出
    ├── ⑥ RTOS 延迟 80ms（释放 CPU）
    ├── ⑦ 读状态寄存器 → Busy? → 等 5ms → 重试（最多 5 次）
    ├── ⑧ 临界区进入
    ├── ⑨ I2C START → 0x71(R) → ACK
    ├── ⑩ 连续读 6 字节（ACK...NACK）→ I2C STOP
    ├── ⑪ 临界区退出
    ├── ⑫ 数据拼装 + 公式计算
    └── 返回 temp, humi

总耗时: ~80ms + I2C 通信时间(约 2ms) ≈ 82ms
```

## 8. 常见问题与调试

| 问题 | 症状 | 原因 | 解法 |
|------|------|------|------|
| 读数始终为 0 | 温湿度显示 0.0 | I2C 地址错误 | 检查写地址 0x70 / 读地址 0x71 |
| 读数不变 | 温湿度不更新 | 测量命令未正确发送 | 逻辑分析仪抓 I2C 波形 |
| 读数为 -50°C | 温度恒为 -50 | 传感器未上电或地址线接错 | 万用表测 VDD 3.3V |
| 读数跳变 | 数值忽大忽小 | 电源纹波干扰 | VDD 加 100nF + 10μF 去耦电容 |
| ACK 超时 | `wait_ack` 一直失败 | SDA/SCL 接反或上拉电阻缺失 | 检查 SDA/SCL 各接 4.7kΩ 上拉 |
| CRC 不匹配 | 校验失败 | I2C 时序干扰 | 缩短 I2C 线长、降低速率到 100kHz |

## 下一步

下一篇将深入 **MPU6050 六轴传感器驱动开发**：硬件 I2C + DMA 加速读取、FIFO 批量数据获取、陀螺仪/加速度计量程配置、中断引脚的数据就绪通知、以及步数算法和卡尔曼滤波的姿态解算。
