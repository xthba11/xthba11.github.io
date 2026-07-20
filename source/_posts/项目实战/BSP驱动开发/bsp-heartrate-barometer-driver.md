---
title: EM7028 心率传感器与 BMP280 气压计驱动开发
date: 2025-12-30
categories:
  - 项目实战
  - BSP开发
tags:
  - BSP
  - EM7028
  - BMP280
  - 心率传感器
  - PPG
  - 气压计
  - I2C
  - Bicycle_Watch
description: EM7028 心率传感器与 BMP280 气压计驱动开发：PPG 光电容积脉搏波采样与滤波、心率 BPM 计算（峰值检测+滑动窗口）、BMP280 气压/温度寄存器读取、海拔换算公式（基于海平面气压）、骑行场景应用
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# EM7028 心率传感器与 BMP280 气压计驱动开发

## 1. EM7028 心率传感器

### 1.1 工作原理

EM7028 是 PPG（光电容积脉搏波）心率传感器。原理：LED 发射绿光穿透皮肤 → 血管随心跳扩张收缩 → 反射光强度变化 → 光电二极管转化为电流 → ADC 采样 → 波形分析 → 提取心率。

```
LED绿光 (525nm)
    │
    ▼
  皮肤表面
    │
    ▼
  血管 ← 心跳引起周期性扩张/收缩
    │
    ▼
  反射光强度随血管容积变化
    │
    ▼
  光电二极管 → I-V 转换 → ADC → PPG 波形
    │
    ▼
  算法: 峰值检测 → 计算峰间距 → BPM
```

### 1.2 驱动寄存器定义

```c
// bsp_em7028_reg.h — EM7028 寄存器

#define EM7028_I2C_ADDR_WRITE   0xB0  // 7-bit 0x58 << 1 | 0
#define EM7028_I2C_ADDR_READ    0xB1  // 7-bit 0x58 << 1 | 1

// 控制寄存器
#define EM7028_REG_MODE_CFG      0x02  // 模式配置
#define EM7028_REG_LED_CURRENT   0x03  // LED 驱动电流
#define EM7028_REG_SAMPLE_RATE   0x04  // 采样率
#define EM7028_REG_FIFO_CFG      0x05  // FIFO 配置

// 数据寄存器
#define EM7028_REG_FIFO_DATA     0x09  // FIFO 数据（3 字节/样本: IR + Red + Green）
#define EM7028_REG_FIFO_WR_PTR   0x06  // FIFO 写指针
#define EM7028_REG_FIFO_RD_PTR   0x07  // FIFO 读指针
#define EM7028_REG_FIFO_OVF_CNT  0x08  // FIFO 溢出计数
```

### 1.3 初始化配置

```c
// 心率传感器初始化 —— 配置采样率、LED 电流、FIFO

void em7028_init(bsp_em7028_driver_t *drv)
{
    uint8_t cfg;

    // ① 复位设备
    cfg = 0x40;  // SW_RESET
    i2c_write_reg(drv, EM7028_REG_MODE_CFG, &cfg, 1);
    delay_ms(10);

    // ② 配置 LED 电流：50mA（平衡信号质量和功耗）
    //    电流太小 → 信号弱，噪声大
    //    电流太大 → 功耗高，可能灼伤皮肤
    cfg = 0x3F;  // 约 50mA
    i2c_write_reg(drv, EM7028_REG_LED_CURRENT, &cfg, 1);

    // ③ 配置采样率：100Hz（心率计算需要较高采样率）
    cfg = 0x03;  // 100 SPS
    i2c_write_reg(drv, EM7028_REG_SAMPLE_RATE, &cfg, 1);

    // ④ 配置 FIFO：每来 32 个样本触发一次中断
    cfg = 0x20;  // FIFO threshold = 32
    i2c_write_reg(drv, EM7028_REG_FIFO_CFG, &cfg, 1);

    // ⑤ 启动连续测量模式
    cfg = 0x03;  // HR mode + PPG mode
    i2c_write_reg(drv, EM7028_REG_MODE_CFG, &cfg, 1);
}

// 读取 FIFO 数据（一次读一批样本）
void em7028_read_fifo(bsp_em7028_driver_t *drv,
                      uint8_t *buf, uint8_t len)
{
    i2c_read_reg(drv, EM7028_REG_FIFO_DATA, buf, len);
    // 每 3 字节 = 1 个样本（IR + Red + Green）
    // 一般读取 32 × 3 = 96 字节
}
```

## 2. 心率计算算法

### 2.1 从 PPG 波形到 BPM

```c
// service_sensor.c — sensor_heartrate()
// 用 EM7028 的原始数据计算心率 BPM

// 算法流程：
//   ① 读取 FIFO 中的多组 PPG 样本
//   ② 对 Green 通道做滑动窗口平均滤波（去除 50Hz 工频干扰）
//   ③ 峰值检测：找到波形中的波峰
//   ④ 计算相邻波峰的时间间隔 → IBI (Inter-Beat Interval)
//   ⑤ BPM = 60000 / IBI_avg

static float calculate_bpm(uint32_t *green_samples, uint8_t count)
{
    // ----- 滑动窗口滤波 -----
    // 5 点移动平均：去除高频噪声
    static uint32_t filtered[32];
    for (int i = 2; i < count - 2; i++) {
        filtered[i] = (green_samples[i-2] + green_samples[i-1] +
                       green_samples[i]   + green_samples[i+1] +
                       green_samples[i+2]) / 5;
    }

    // ----- 峰值检测 -----
    static uint32_t peak_times[4];   // 最近 4 个峰值的时间戳
    static uint8_t  peak_idx = 0;
    static uint32_t prev_value = 0;
    static bool     rising = false;

    for (int i = 1; i < count - 2; i++) {
        // 检测上升沿（当前值 > 前一个值）
        if (filtered[i] > prev_value && !rising) {
            rising = true;
        }
        // 检测峰值（过了最高点开始下降）
        if (rising && filtered[i] < prev_value) {
            // 确认峰值，且幅度超过阈值（避免噪声误检）
            if (prev_value > 50000) {  // 信号强度阈值
                peak_times[peak_idx] = HAL_GetTick();
                peak_idx = (peak_idx + 1) % 4;
            }
            rising = false;
        }
        prev_value = filtered[i];
    }

    // ----- 计算 BPM -----
    // 需要至少 2 个峰值才能计算
    if (peak_idx < 2 && peak_times[3] == 0) {
        return 0.0f;  // 数据不够
    }

    // 计算最近 3 个 IBI 的平均值
    float ibi_sum = 0;
    uint8_t ibi_count = 0;
    for (int i = 1; i < 4; i++) {
        int prev = (peak_idx - i + 4) % 4;
        int curr = (peak_idx - i + 1 + 4) % 4;
        if (peak_times[curr] > 0 && peak_times[prev] > 0) {
            ibi_sum += peak_times[curr] - peak_times[prev];
            ibi_count++;
        }
    }

    if (ibi_count == 0) return 0.0f;
    float ibi_avg = ibi_sum / ibi_count;  // 平均心跳间隔 (ms)
    return 60000.0f / ibi_avg;            // BPM = 60000ms / IBI
}
```

### 2.2 心率数据稳定性增强

```c
// 使用 4 阶 BPM 缓冲做平滑处理
static float bpm_buffer[4];  // 最近 4 次 BPM 计算结果

void update_bpm_buffer(float new_bpm)
{
    // 滑动窗口：丢掉最旧的，加入最新的
    for (int i = 0; i < 3; i++) {
        bpm_buffer[i] = bpm_buffer[i + 1];
    }
    bpm_buffer[3] = new_bpm;

    // 计算平均值（丢弃异常值）
    float sum = 0;
    for (int i = 0; i < 4; i++) {
        sum += bpm_buffer[i];
    }
    current_bpm = sum / 4.0f;
}
```

## 3. BMP280 气压计

### 3.1 工作原理

BMP280 是 Bosch 的气压传感器，Bicycle_Watch 用它来测量海拔高度变化（爬升/下降）：

| 参数 | 规格 |
|------|------|
| 气压范围 | 300 ~ 1100 hPa |
| 气压精度 | ±1 hPa |
| 温度范围 | -40°C ~ +85°C |
| 接口 | I2C / SPI |
| I2C 地址 | 0x76（SDO=0）/ 0x77（SDO=1） |
| 功耗 | 2.7μA @ 1Hz 采样 |

### 3.2 寄存器读取

```c
// BMP280 读取气压和温度（需要读取校准系数 + 原始值）

// 校准系数（存储在 BMP280 的 NVM 中，上电后读取一次）
typedef struct {
    uint16_t dig_T1;
    int16_t  dig_T2;
    int16_t  dig_T3;
    uint16_t dig_P1;
    int16_t  dig_P2;
    int16_t  dig_P3;
    int16_t  dig_P4;
    int16_t  dig_P5;
    int16_t  dig_P6;
    int16_t  dig_P7;
    int16_t  dig_P8;
    int16_t  dig_P9;
} bmp280_calib_t;

// 读取校准数据
void bmp280_read_calibration(bmp280_calib_t *calib)
{
    uint8_t buf[24];
    i2c_read_reg(BMP280_REG_CALIB00, buf, 24);

    calib->dig_T1 = (buf[1]  << 8) | buf[0];
    calib->dig_T2 = (buf[3]  << 8) | buf[2];
    calib->dig_T3 = (buf[5]  << 8) | buf[4];
    calib->dig_P1 = (buf[7]  << 8) | buf[6];
    // ... 继续解析剩余系数
}

// 读取原始气压和温度（3 字节 + 3 字节）
void bmp280_read_raw(int32_t *raw_temp, int32_t *raw_press)
{
    uint8_t buf[6];
    i2c_read_reg(BMP280_REG_PRESS_MSB, buf, 6);

    *raw_press = ((uint32_t)buf[0] << 12) |
                 ((uint32_t)buf[1] << 4)  |
                 ((uint32_t)buf[2] >> 4);
    *raw_temp  = ((uint32_t)buf[3] << 12) |
                 ((uint32_t)buf[4] << 4)  |
                 ((uint32_t)buf[5] >> 4);
}
```

### 3.3 温度补偿与气压计算（Bosch 数据手册公式）

```c
// BMP280 温度补偿（返回 T/100 °C）
int32_t bmp280_compensate_T(int32_t raw_temp, bmp280_calib_t *calib)
{
    int32_t var1, var2, T;

    var1 = ((((raw_temp >> 3) - ((int32_t)calib->dig_T1 << 1)))
            * (int32_t)calib->dig_T2) >> 11;
    var2 = (((((raw_temp >> 4) - (int32_t)calib->dig_T1)
            * ((raw_temp >> 4) - (int32_t)calib->dig_T1)) >> 12)
            * (int32_t)calib->dig_T3) >> 14;

    T = var1 + var2;
    return T;  // T/100 °C，例如 2345 = 23.45°C
}

// BMP280 气压补偿（返回 Pa，需先完成温度补偿）
uint32_t bmp280_compensate_P(int32_t raw_press, int32_t t_fine,
                              bmp280_calib_t *calib)
{
    int64_t var1, var2, p;

    var1 = (int64_t)t_fine - 128000;
    var2 = var1 * var1 * (int64_t)calib->dig_P6;
    var2 = var2 + ((var1 * (int64_t)calib->dig_P5) << 17);
    var2 = var2 + (((int64_t)calib->dig_P4) << 35);
    var1 = ((var1 * var1 * (int64_t)calib->dig_P3) >> 8)
         + ((var1 * (int64_t)calib->dig_P2) << 12);
    var1 = ((((int64_t)1 << 47) + var1)) * (int64_t)calib->dig_P1 >> 33;

    if (var1 == 0) return 0;  // 除零保护

    p = 1048576 - raw_press;
    p = (((p << 31) - var2) * 3125) / var1;
    var1 = ((int64_t)calib->dig_P9 * (p >> 13) * (p >> 13)) >> 25;
    var2 = ((int64_t)calib->dig_P8 * p) >> 19;
    p = ((p + var1 + var2) >> 8) + ((int64_t)calib->dig_P7 << 4);

    return (uint32_t)p;  // 单位 Pa
}
```

### 3.4 海拔换算

```c
// 气压换算海拔（国际标准大气压公式 ISA）
// 适用高度：0 ~ 11000m

float pressure_to_altitude(float pressure_pa, float sea_level_pa)
{
    // p/p0 = (1 - 0.0065*h/T0)^5.255
    // => h = (1 - (p/p0)^(1/5.255)) * T0 / 0.0065
    // T0 = 288.15K (15°C @ sea level)

    float ratio = pressure_pa / sea_level_pa;
    float altitude = (1.0f - powf(ratio, 1.0f / 5.255f))
                     * 288.15f / 0.0065f;
    return altitude;  // 单位 米
}

// 实际使用示例：
//   海平面气压 = 101325 Pa（标准值，或从气象站获取）
//   当前气压 = 98700 Pa
//   → 海拔 ≈ (1 - (98700/101325)^0.1903) * 288.15 / 0.0065
//   → 海拔 ≈ 215m

// Bicycle_Watch 中的使用：
//   骑行开始时记录初始海拔
//   骑行过程中累积爬升 = sum(每段正海拔变化)
//   显示在 LVGL 气压页面上
```

## 4. 两种传感器的应用场景

### 4.1 EM7028 在 Bicycle_Watch 中的角色

```
┌──────────────────────────────────────────────────┐
│ EM7028 心率数据流向：                              │
│                                                  │
│ EM7028 (I2C) → FIFO 读取 → PPG 波形              │
│     │                                            │
│     ▼                                            │
│ 峰值检测算法 → BPM 计算 → 4 阶缓冲平滑             │
│     │                                            │
│     ▼                                            │
│ lvgl_heart_rate_get_data(hr)                     │
│     │                                            │
│     ▼                                            │
│ LVGL 表盘显示 "72" bpm                           │
│ 心率详情页显示波形曲线                             │
│                                                  │
│ 如果 nRF52840 BLE 连接：                          │
│   → HRS 服务 Notification 推送到手机 App          │
└──────────────────────────────────────────────────┘
```

### 4.2 BMP280 在 Bicycle_Watch 中的应用

```
┌──────────────────────────────────────────────────┐
│ BMP280 气压数据流向：                              │
│                                                  │
│ BMP280 (I2C/SPI) → 原始气压+温度                 │
│     │                                            │
│     ▼                                            │
│ Bosch 补偿算法 → 精确气压 (Pa) → 海拔 (m)          │
│     │                                            │
│     ▼                                            │
│ lvgl_pressure_get_data(pressure)                  │
│     │                                            │
│     ▼                                            │
│ LVGL 表盘显示气压值 "304" (hPa/10)                │
│ 气压详情页显示海拔变化曲线                          │
│                                                  │
│ 骑行场景应用：                                     │
│   • 累计爬升/下降统计                              │
│   • 海拔高度显示                                   │
│   • 气压趋势预测天气变化                            │
└──────────────────────────────────────────────────┘
```

## 5. 常见的 I2C 传感器调试技巧

```text
① 逻辑分析仪抓波形：
   Saleae 或 DSLogic → 接 SDA/SCL/GND → 看 START/ADDR/DATA/ACK/STOP
   问题一望可知：地址错误、ACK 缺、SCL 频率不对

② WHO_AM_I 寄存器验证：
   每个 I2C 传感器通常有一个只读的 WHO_AM_I 寄存器（地址 0x00 或 0x75）
   读出来对比数据手册 → 确认 I2C 通信正常

③ 逐寄存器调试：
   先只读 WHO_AM_I → 确认通信 OK
   再写 MODE 寄存器 → 确认传感器被使能
   最后读数据寄存器 → 确认传感器在工作

④ 检查上拉电阻：
   I2C 需要 SDA/SCL 各接 4.7kΩ 上拉到 VDD
   用万用表量：SCL/SDA 空闲电平应为 VDD（3.3V）
```

## 下一步

最后一篇将介绍 **Sensor Service 传感器服务层与多传感器调度**：service_sensor 任务中的统一调度框架、按 LVGL 页面动态启停传感器采样、各传感器的采样频率与数据分发策略、以及与 LVGL 显示层的数据对接。
