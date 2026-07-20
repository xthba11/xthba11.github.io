---
title: Sensor Service 传感器服务层与多传感器调度策略
date: 2026-03-08
categories:
  - 项目实战
  - BSP开发
tags:
  - BSP
  - 传感器服务
  - FreeRTOS
  - 采样调度
  - 数据分发
  - 低功耗
  - Bicycle_Watch
description: Sensor Service 传感器服务层架构：统一的 sensor_polling_task 调度框架、采样频率矩阵（温湿度 10s/IMU 10ms/心率 1s/气压 5s）、按 LVGL 页面动态启停传感器（省电）、数据分发到 LVGL 显示层与 BLE 推送
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# Sensor Service 传感器服务层与多传感器调度

## 1. 为什么需要 Sensor Service

Bicycle_Watch 有 4 种传感器，它们的采样频率、数据格式、功耗特性各不相同。如果让每个传感器的驱动代码直接与 LVGL 和 BLE 模块交互，代码将难以维护。

Sensor Service 的作用是 **集中管理所有传感器**——像一个"班组长"，协调各传感器的采样时机、缓存数据、按需分发。

```
┌──────────────────────────────────────────────────┐
│                 Sensor Service 层                 │
│  sensor_polling_task（FreeRTOS 任务）              │
│                                                  │
│  职责：                                           │
│    ① 定时采集各传感器数据                           │
│    ② 运行本地算法（步数、心率 BPM）                 │
│    ③ 按 LVGL 页面动态调整采样策略                   │
│    ④ 写数据到全局结构体（供 LVGL 读取）              │
│    ⑤ 调用算法库（heartRate / step_algo）           │
│    ⑥ 管理传感器休眠/唤醒（低功耗）                   │
└──────────────────────────────────────────────────┘
```

## 2. 任务架构：sensor_polling_task

```c
// service_sensor.c — 传感器轮询任务（核心调度器）

// 传感器状态管理结构体
static struct {
    uint32_t active_sensors;
    uint32_t temp_sample_rate;           // 温湿度采样周期 (ms)
    uint32_t motion_sample_rate;         // IMU 采样周期 (ms)
    uint32_t airpressure_sample_rate;    // 气压采样周期 (ms)
    uint32_t heartrate_sample_rate;      // 心率采样周期 (ms)
    uint32_t last_temp_sample;
    uint32_t last_motion_sample;
    uint32_t last_airpressure_sample;
    uint32_t last_heartrate_sample;
    bool temp_sampling_enabled;
    bool motion_sampling_enabled;
    bool airpressure_sampling_enabled;
    bool heartrate_sampling_enabled;
} sensor_state = {
    .temp_sample_rate = 10000,     // 温度: 10 秒（变化极慢）
    .motion_sample_rate = 100,     // IMU: 100ms（步数检测需要）
    .airpressure_sample_rate = 5000, // 气压: 5 秒（海拔变化慢）
    .heartrate_sample_rate = 1000,   // 心率: 1 秒
};

void sensor_polling_task(void *argument)
{
    watchdog_register(osal_task_get_current_handle(),
                      5000, "SensorTask");

    for (;;) {
        watchdog_feed(osal_task_get_current_handle());

        uint32_t now = osal_task_get_tick_count();

        // ====== ① 温湿度采样（10s 周期） ======
        if (sensor_state.temp_sampling_enabled &&
            (now - sensor_state.last_temp_sample)
                >= sensor_state.temp_sample_rate) {

            sensor_temp_humi();  // 读 AHT21 → 更新 g_lvgl_data
            sensor_state.last_temp_sample = now;
        }

        // ====== ② IMU 采样（100ms 周期） ======
        if (sensor_state.motion_sampling_enabled &&
            (now - sensor_state.last_motion_sample)
                >= sensor_state.motion_sample_rate) {

            sensor_motion();  // 读 MPU6050 → 步数检测 → 更新 g_lvgl_data
            sensor_state.last_motion_sample = now;
        }

        // ====== ③ 气压采样（5s 周期） ======
        if (sensor_state.airpressure_sampling_enabled &&
            (now - sensor_state.last_airpressure_sample)
                >= sensor_state.airpressure_sample_rate) {

            sensor_airpressure();  // 读 BMP280 → 更新 g_lvgl_data
            sensor_state.last_airpressure_sample = now;
        }

        // ====== ④ 心率采样（1s 周期） ======
        if (sensor_state.heartrate_sampling_enabled &&
            (now - sensor_state.last_heartrate_sample)
                >= sensor_state.heartrate_sample_rate) {

            sensor_heartrate();  // 读 EM7028 → BPM 计算 → 更新 g_lvgl_data
            sensor_state.last_heartrate_sample = now;
        }

        // ⑤ 处理 LVGL 发来的 UI 事件（页面切换 → 调整采样策略）
        ui_state_t ui_event;
        if (osal_queue_recv(g_ui_event_queue, &ui_event, 0)
                == OSAL_SUCCESS) {
            adjust_sampling_strategy(ui_event);
        }

        // ⑥ 任务让出 CPU 40ms（约 25Hz 的主循环速率）
        osal_task_delay_ms(40);
    }
}
```

## 3. 按页面动态调整采样策略

```c
// 根据用户当前查看的 LVGL 页面，决定哪些传感器需要采样、以什么频率采样

void adjust_sampling_strategy(ui_state_t page)
{
    switch (page) {

    case UI_STATE_WatchGiral_1:  // 表盘主页 → 所有传感器全开
        sensor_state.temp_sampling_enabled = true;
        sensor_state.motion_sampling_enabled = true;
        sensor_state.airpressure_sampling_enabled = true;
        sensor_state.heartrate_sampling_enabled = true;
        sensor_state.heartrate_sample_rate = 1000;  // 心率 1Hz
        break;

    case UI_STATE_Heart:  // 心率详情页 → 心率加速采样
        sensor_state.temp_sampling_enabled = false;    // 关温度
        sensor_state.motion_sampling_enabled = true;   // 保留 IMU（步数）
        sensor_state.airpressure_sampling_enabled = false; // 关气压
        sensor_state.heartrate_sampling_enabled = true;
        sensor_state.heartrate_sample_rate = 40;  // ★ 心率加速到 25Hz
        break;

    case UI_STATE_Weather:  // 天气页 → 只开环境传感器
        sensor_state.temp_sampling_enabled = true;
        sensor_state.motion_sampling_enabled = false;
        sensor_state.airpressure_sampling_enabled = true;
        sensor_state.heartrate_sampling_enabled = false;
        break;

    case UI_STATE_Pmscreen:  // 气压详情页 → 加速气压采样
        sensor_state.airpressure_sample_rate = 1000;  // 1Hz（默认 5s）
        break;

    default:  // 菜单、设置、OTA → 最小采样（只保持步数）
        sensor_state.temp_sampling_enabled = false;
        sensor_state.motion_sampling_enabled = true;  // 步数不能停
        sensor_state.motion_sample_rate = 1000;  // 降频到 1Hz
        sensor_state.airpressure_sampling_enabled = false;
        sensor_state.heartrate_sampling_enabled = false;
        break;
    }
}
```

### 采样频率矩阵

| LVGL 页面 | 温湿度 | IMU | 气压 | 心率 | 总功耗 |
|-----------|:---:|:---:|:---:|:---:|:---:|
| 表盘主页 | 0.1Hz | 10Hz | 0.2Hz | 1Hz | 中 |
| 心率详情 | OFF | 10Hz | OFF | 25Hz | 高 |
| 天气页 | 0.1Hz | OFF | 1Hz | OFF | 低 |
| 气压详情 | OFF | 10Hz | 1Hz | OFF | 低 |
| 菜单/设置 | OFF | 1Hz | OFF | OFF | 最低 |

## 4. 数据采集函数

### 4.1 温湿度

```c
void sensor_temp_humi(void)
{
    extern bsp_aht21_driver_t aht21_driver;
    float temp, humi;

    aht21_status_t ret = aht21_driver.pf_read_temp_humi(
        &aht21_driver, &temp, &humi);

    if (ret == AHT21_OK) {
        // 写入全局数据结构（LVGL 定时器读取）
        lvgl_temperature_get_data((uint8_t)temp);
        // 湿度暂不显示在表盘上（但可选扩展到详情页）
    }
}
```

### 4.2 IMU（含步数检测）

```c
void sensor_motion(void)
{
    extern bsp_mpuxxx_driver_t mpu6050_driver;
    mpuxxx_data_t mpu_data;

    // 读取 6 轴数据
    mpu6050_driver.pf_get_all_data(&mpu6050_driver, &mpu_data);

    // 步数检测算法
    if (detect_step(mpu_data.ax, mpu_data.ay, mpu_data.az)) {
        g_lvgl_data.step_count++;
    }

    // 更新 LVGL 数据
    lvgl_step_count_get_data(g_lvgl_data.step_count);
}
```

### 4.3 心率

```c
void sensor_heartrate(void)
{
    extern bsp_em7028_driver_t em7028_driver;
    uint32_t green_samples[32];

    // 读取 FIFO 中的多组 PPG 样本
    em7028_read_fifo_samples(&em7028_driver, green_samples, 32);

    // 运行 BPM 计算算法
    float bpm = calculate_bpm(green_samples, 32);

    if (bpm > 30.0f && bpm < 220.0f) {  // 合理范围过滤
        update_bpm_buffer(bpm);          // 4 阶平滑
        lvgl_heart_rate_get_data((uint16_t)current_bpm);
    }
}
```

### 4.4 气压

```c
void sensor_airpressure(void)
{
    extern bmp280_driver_t bmp280_driver;
    int32_t raw_temp, raw_press;

    bmp280_read_raw(&bmp280_driver, &raw_temp, &raw_press);

    // Bosch 补偿算法
    int32_t t_fine = bmp280_compensate_T(raw_temp, &bmp280_calib);
    uint32_t pressure_pa = bmp280_compensate_P(raw_press, t_fine,
                                                &bmp280_calib);

    // 转为 0.1 hPa 单位（LVGL 显示用）
    uint16_t pressure_hpa_x10 = pressure_pa / 100;
    lvgl_pressure_get_data(pressure_hpa_x10);
}
```

## 5. 数据分发：到 LVGL 和 BLE

```
sensor_polling_task
    │
    ├──→ lvgl_temperature_get_data(temp)
    │        └→ g_lvgl_data.temperature = temp
    │             └→ LVGL lv_timer 每 100ms 读取 → 更新界面
    │
    ├──→ lvgl_heart_rate_get_data(bpm)
    │        └→ g_lvgl_data.heart_rate = bpm
    │
    ├──→ lvgl_pressure_get_data(pressure)
    │
    ├──→ lvgl_step_count_get_data(steps)
    │
    └──→ (如果 BLE 连接) → nRF52840 UART 推送
             └→ hrs_notify(bpm)  → BLE HRS 服务
             └→ 手机 App 实时显示心率曲线
```

## 6. 低功耗策略

```c
// 根据 UI 页面和电池状态，降低传感器功耗

void power_optimize(void)
{
    // ① 非骑行状态 → 停止 IMU 高速采样
    if (!is_riding) {
        // MPU6050 进入睡眠模式
        mpu6050_driver.pf_sleep(&mpu6050_driver);
        sensor_state.motion_sampling_enabled = false;
    }

    // ② 电池 < 10% → 停止非关键传感器
    if (g_lvgl_data.battery < 10) {
        sensor_state.temp_sampling_enabled = false;
        sensor_state.airpressure_sampling_enabled = false;
        sensor_state.motion_sample_rate = 5000;  // IMU 降到 0.2Hz
    }

    // ③ 屏幕熄灭 → 所有传感器降频
    if (display_is_off) {
        sensor_state.heartrate_sampling_enabled = false;
        sensor_state.motion_sample_rate = 5000;
    }
}

// 传感器功耗对比：
//   AHT21:  测量中 980μA / 待机 0.04μA
//   MPU6050: 全速 3.9mA / 睡眠 5μA
//   BMP280: 测量中 2.7μA / 待机 0.1μA
//   EM7028: 测量中 1.5mA / 待机 0.7μA
//   全部开启: 约 6.4mA → 500mAh 电池续航约 78 小时
//   仅保留步数: 约 0.5mA → 续航约 1000 小时
```

## 7. 看门狗与异常保护

```c
// Sensor Task 的看门狗策略：5 秒不喂狗则复位

// sensor_polling_task 主循环中每次迭代都喂狗
// 如果某个传感器 I2C 通信阻塞（如从机拉死 SDA），看门狗触发复位
// 复位后 Boot Manager 重新初始化所有传感器

// 注意事项：
//   传感器初始化失败时不要死循环等 ACK → 应该超时返回
//   所有 I2C 操作都设置合理的 TIME_OUT（如 1000ms）
//   如果某个传感器连续失败 3 次 → 标记为故障 → 停止读它
//   不要让一个坏了的心率传感器导致整个系统卡死
```

## 8. 系列总结

本系列五篇文章覆盖了 Bicycle_Watch BSP 驱动开发的完整链路：

| 文章 | 核心知识点 |
|------|-----------|
| 第一篇：架构设计 | 三层分离（Driver/Handler/Adapter）、函数指针接口抽象、inst 实例化模式、硬件/软件 I2C 适配 |
| 第二篇：AHT21 驱动 | I2C 起始-地址-数据-停止时序、测量命令序列、80ms 等待+状态轮询、20-bit 数据拼装、温湿度公式 |
| 第三篇：MPU6050 驱动 | 硬件 I2C+DMA FIFO 读取、量程/滤波器配置、INT 中断驱动、步数峰值检测算法、OS 队列/信号量集成 |
| 第四篇：心率+气压驱动 | EM7028 PPG 波形处理、峰值检测 BPM 计算、BMP280 Bosch 补偿算法、海拔换算、骑行场景应用 |
| 第五篇：Sensor Service | 统一调度框架、采样频率矩阵、按 LVGL 页面动态启停、低功耗策略、看门狗保护 |

---

> 所有代码均基于 `C:\Users\XTHBA\Desktop\找工作\项目\Bicycle_Watch` 工程中的真实源码，遵循 BSP 分层架构设计规范。
