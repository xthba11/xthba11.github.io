---
title: MPU6050 六轴传感器 I2C 驱动开发（DMA + FIFO + 中断）
date: 2026-07-20
categories:
  - 项目实战
  - BSP开发
tags:
  - BSP
  - MPU6050
  - I2C
  - DMA
  - FIFO
  - IMU
  - 步数算法
  - Bicycle_Watch
description: MPU6050 六轴传感器驱动深度开发：硬件 I2C + DMA 加速读取、FIFO 批量获取（1024 字节）、量程与低通滤波器配置、中断引脚 INT 数据就绪通知、Kalman 姿态解算、步数统计算法（峰值检测）
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# MPU6050 六轴传感器 I2C 驱动开发

## 1. MPU6050 硬件概述

MPU6050 是 InvenSense 的经典 6 轴 IMU，Bicycle_Watch 用它来做手势识别（翻转手腕亮屏）和步数统计：

| 参数 | 规格 |
|------|------|
| 陀螺仪量程 | ±250/500/1000/2000 °/s |
| 加速度计量程 | ±2/4/8/16 g |
| ADC 精度 | 16-bit |
| 接口 | I2C（最高 400kHz） |
| FIFO | 1024 字节（可存 42 组 6 轴数据） |
| 中断 | INT 引脚（数据就绪 / FIFO 溢出 / 运动检测） |
| I2C 地址 | 0x68（AD0=0）/ 0x69（AD0=1） |
| 工作温度 | -40°C ~ +85°C |

## 2. 寄存器访问宏封装

Bicycle_Watch 封装了寄存器读写宏，避免重复的 HAL 调用：

```c
// bsp_mpuxxx_driver.c — 寄存器访问宏

// I2C 存储器地址宽度 = 8-bit（MPU6050 的寄存器地址是单字节的）
#define IIC_MEMADD_SIZE_8BIT  0x00000001U
#define TIME_OUT_MS           1000

// ★ 写寄存器宏
#define MPUXXX_WRITE_REG(p_mpu_driver, reg, p_data, len) \
    p_mpu_driver->p_iic_driver_interface->pf_iic_mem_write( \
        p_mpu_driver->p_iic_driver_interface->hi2c, \
        (MPU_ADDR << 1) | 0,      /* 7-bit → 8-bit 写地址 */ \
        reg,                        /* 寄存器起始地址 */ \
        IIC_MEMADD_SIZE_8BIT,      /* 寄存器地址宽度 */ \
        p_data,                     /* 数据指针 */ \
        len,                        /* 数据长度 */ \
        TIME_OUT_MS)               /* 超时时间 */

// ★ 读寄存器宏
#define MPUXXX_READ_REG(p_mpu_driver, reg, p_data, len) \
    p_mpu_driver->p_iic_driver_interface->pf_iic_mem_read( \
        p_mpu_driver->p_iic_driver_interface->hi2c, \
        (MPU_ADDR << 1) | 1,      /* 7-bit → 8-bit 读地址 */ \
        reg, p_data, len, TIME_OUT_MS)

// 使用示例：
// uint8_t data = 0x00;
// MPUXXX_WRITE_REG(drv, MPU_PWR_MGMT1_REG, &data, 1);  // 写 1 字节
// uint8_t buf[14];
// MPUXXX_READ_REG(drv, MPU_ACCEL_XOUT_H_REG, buf, 14); // 读 14 字节
```

## 3. 初始化配置流程

### 3.1 上电唤醒

```c
// MPU6050 上电后默认处于睡眠模式 → 必须清除 SLEEP 位

static mpuxxx_status_t mpuxxx_wakeup(bsp_mpuxxx_driver_t *p_mpu_driver)
{
    uint8_t data = 0x00;  // SLEEP(bit6) = 0 → 唤醒

    mpuxxx_status_t ret = MPUXXX_WRITE_REG(
        p_mpu_driver, MPU_PWR_MGMT1_REG, &data, 1);

    if (ret != MPUxxx_OK) {
        DEBUG_OUT("mpuxxx_wakeup: write PWR_MGMT1 error\r\n");
    }
    return ret;
}
```

### 3.2 关键寄存器配置

```c
// MPU6050 初始化完整配置流程

mpuxxx_status_t mpuxxx_init_full(bsp_mpuxxx_driver_t *drv)
{
    uint8_t data;

    // ① 唤醒设备（清除 SLEEP 位）
    data = 0x00;
    MPUXXX_WRITE_REG(drv, MPU_PWR_MGMT1_REG, &data, 1);

    // ② 配置陀螺仪量程：±2000 °/s（最灵敏的骑行姿态检测）
    //    FS_SEL[1:0] = 11 → ±2000 °/s → scale = 16.4 LSB/(°/s)
    data = 0x18;  // FS_SEL = 3
    MPUXXX_WRITE_REG(drv, MPU_GYRO_CONFIG_REG, &data, 1);

    // ③ 配置加速度计量程：±16g（支持冲击检测）
    //    AFS_SEL[1:0] = 11 → ±16g → scale = 2048 LSB/g
    data = 0x18;  // AFS_SEL = 3
    MPUXXX_WRITE_REG(drv, MPU_ACCEL_CONFIG_REG, &data, 1);

    // ④ 配置低通滤波器：DLPF = 3（41Hz 加速度 / 42Hz 陀螺仪）
    //    骑行场景不需要太高带宽，41Hz 足够
    data = 0x03;
    MPUXXX_WRITE_REG(drv, MPU_CONFIG_REG, &data, 1);

    // ⑤ 配置采样率分频：1kHz / (1 + 4) = 200Hz
    //    采样太快 DMA 来不及处理，200Hz 是合理的折中
    data = 0x04;
    MPUXXX_WRITE_REG(drv, MPU_SMPLRT_DIV_REG, &data, 1);

    // ⑥ 使能数据就绪中断（INT 引脚在数据准备好时拉高）
    data = 0x01;  // DATA_RDY_EN = 1
    MPUXXX_WRITE_REG(drv, MPU_INT_ENABLE_REG, &data, 1);

    // ⑦ 配置中断引脚：推挽输出、高电平有效
    data = 0x00;
    MPUXXX_WRITE_REG(drv, MPU_INT_PIN_CFG_REG, &data, 1);

    // ⑧ 使能 FIFO：加速度 + 陀螺仪
    data = 0xF8;  // ACCEL + GYRO + TEMP
    MPUXXX_WRITE_REG(drv, MPU_FIFO_EN_REG, &data, 1);

    return MPUxxx_OK;
}
```

## 4. 数据读取方式

### 4.1 普通寄存器读取（6 轴一次读）

```c
// 一次性读取全部 14 字节（加速度 6 + 温度 2 + 陀螺仪 6）
// 使用 I2C burst read 模式——发一次寄存器地址，连续读 N 字节

mpuxxx_status_t mpuxxx_get_all_data(bsp_mpuxxx_driver_t *p_mpu_driver,
                                     mpuxxx_data_t *p_data)
{
    uint8_t buf[14];

    // 从 ACCEL_XOUT_H (0x3B) 开始连续读 14 字节
    mpuxxx_status_t ret = MPUXXX_READ_REG(
        p_mpu_driver, MPU_ACCEL_XOUT_H_REG, buf, 14);
    if (ret != MPUxxx_OK) return ret;

    // 拼装原始值（大端字节序 → 小端）
    p_data->accel_x_raw = (int16_t)((buf[0] << 8) | buf[1]);
    p_data->accel_y_raw = (int16_t)((buf[2] << 8) | buf[3]);
    p_data->accel_z_raw = (int16_t)((buf[4] << 8) | buf[5]);

    int16_t temp_raw = (int16_t)((buf[6] << 8) | buf[7]);
    p_data->temperature = (temp_raw / 340.0f) + 36.53f;  // 数据手册公式

    p_data->gyro_x_raw = (int16_t)((buf[8]  << 8) | buf[9]);
    p_data->gyro_y_raw = (int16_t)((buf[10] << 8) | buf[11]);
    p_data->gyro_z_raw = (int16_t)((buf[12] << 8) | buf[13]);

    // 转换为物理量
    p_data->ax = p_data->accel_x_raw / 2048.0f;  // ±16g → 2048 LSB/g
    p_data->ay = p_data->accel_y_raw / 2048.0f;
    p_data->az = p_data->accel_z_raw / 2048.0f;
    p_data->gx = p_data->gyro_x_raw / 16.4f;     // ±2000°/s → 16.4 LSB/(°/s)
    p_data->gy = p_data->gyro_y_raw / 16.4f;
    p_data->gz = p_data->gyro_z_raw / 16.4f;

    return MPUxxx_OK;
}
```

### 4.2 DMA 加速 FIFO 读取

```c
// MPU6050 的 FIFO 可以缓存 42 组 6 轴数据
// 用 I2C DMA 一次性读出全部数据 → 避免 CPU 逐字节轮询

mpuxxx_status_t mpuxxx_read_fifo_packet(bsp_mpuxxx_driver_t *p_mpu_driver,
                                         mpuxxx_data_t *p_data)
{
    uint8_t buf[14 * 4];  // 一次读 4 组（56 字节）

    // DMA 异步读取 FIFO 数据（非阻塞）
    mpuxxx_status_t ret = p_mpu_driver->p_iic_driver_interface
        ->pf_iic_mem_read_dma(
            p_mpu_driver->p_iic_driver_interface->hi2c,
            (MPU_ADDR << 1) | 1,
            MPU_FIFO_R_W_REG,   // FIFO 读写寄存器地址 = 0x74
            IIC_MEMADD_SIZE_8BIT,
            buf,
            14 * 4              // 读 4 组数据
        );

    // DMA 完成后在回调中解析数据
    // → 通过队列发送给 service_sensor 任务
    return ret;
}
```

## 5. 中断驱动采样

### 5.1 INT 引脚配置

```
STM32F411                    MPU6050
┌─────────┐              ┌──────────┐
│         │              │          │
│  PBx    │◄─────────────│ INT      │  ← 数据就绪时拉高
│ (EXTI)  │              │          │
└─────────┘              └──────────┘

EXTI 中断配置：
  触发方式：上升沿（MPU6050 INT 高电平有效）
  优先级：中等（比 I2C DMA 中断低，比 UI 中断高）
  中断服务：触发 DMA 读取 → 解析 → 队列发送
```

### 5.2 中断服务流程

```c
// 中断回调中触发 DMA FIFO 读取

void mpuxxx_int_interrupt_callback(void)
{
    // ① 读取中断状态寄存器（确认是 DATA_RDY 中断）
    uint8_t int_status;
    MPUXXX_READ_REG(p_mpu_drv, MPU_INT_STATUS_REG, &int_status, 1);

    if (int_status & 0x01) {  // DATA_RDY → 数据就绪
        // ② 触发 DMA 批量读取（在中断中只设置标志，不实际读）
        //    实际 DMA 读取由 DMA 完成中断中的回调触发
        os_queue_put_isr(data_queue, &trigger_flag, &task_woken);
        portYIELD_FROM_ISR(task_woken);
    }
}
```

## 6. 步数统计算法

```c
// Bicycle_Watch 使用加速度计峰值检测法统计步数
// 位置: service_sensor.c 中的 sensor_motion()

// 算法流程：
//   ① 计算合成加速度幅值: a_mag = sqrt(ax² + ay² + az²)
//   ② 去除重力分量: a_dynamic = |a_mag - 1g|
//   ③ 峰值检测: a_dynamic 超过阈值 → 可能是一步
//   ④ 时间过滤: 两次步之间的间隔 ≥ 200ms（避免抖动）
//   ⑤ 连续确认: 连续 3 个峰值 → 确认为步数 +1

static uint8_t detect_step(double ax, double ay, double az)
{
    // 合成加速度幅值（去除方向信息）
    double magnitude = sqrt(ax * ax + ay * ay + az * az);

    // 去除重力（1g = 9.8m/s²），取绝对值
    double dynamic_accel = fabs(magnitude - 1.0);

    // 静态变量保存状态
    static double peak_threshold = 0.15;  // 峰值阈值（经过调试）
    static uint32_t last_step_time = 0;
    static uint8_t  confirm_count = 0;

    uint32_t now = HAL_GetTick();

    if (dynamic_accel > peak_threshold) {
        // 时间过滤：距上一步至少 200ms
        if ((now - last_step_time) > 200) {
            confirm_count++;
            if (confirm_count >= 3) {
                last_step_time = now;
                confirm_count = 0;
                return 1;  // ★ 确认走了一步
            }
        }
    } else {
        confirm_count = 0;  // 低于阈值 → 重置确认计数
    }
    return 0;
}
```

## 7. MPU6050 驱动特有的 OS 集成

```c
// MPU6050 驱动使用了完整的 OS 接口（队形/信号量/互斥锁）

typedef struct {
    mpuxxx_status_t (*os_queue_create) (uint32_t item_num, uint32_t item_size,
                                         void **queue_handle);
    mpuxxx_status_t (*os_queue_put)    (void *queue_handle, void *item,
                                         uint32_t timeout);
    mpuxxx_status_t (*os_queue_put_isr)(void *queue_handle, void *item,
                                         long *HigherPriorityTaskWoken);
    mpuxxx_status_t (*os_queue_get)    (void *queue_handle, void *item,
                                         uint32_t timeout);
    mpuxxx_status_t (*os_queue_delete) (void *queue_handle);

    mpuxxx_status_t (*os_semaphore_create_mutex) (void **mutex_handle);
    mpuxxx_status_t (*os_semaphore_lock_mutex)   (void *mutex_handle);
    mpuxxx_status_t (*os_semaphore_unlock_mutex) (void *mutex_handle);

    mpuxxx_status_t (*os_semaphore_create_binary) (void **binary_handle);
    mpuxxx_status_t (*os_semaphore_wait_binary)   (void *binary_handle);
    mpuxxx_status_t (*os_semaphore_signal_binary) (void *binary_handle);
} mpuxxx_os_interface_t;

// 为什么 MPU6050 需要这么重的 OS 集成？
//   - 中断中触发 DMA → DMA 完成中断中放入队列 → 任务从队列取数据
//   - 队列满时需要信号量阻塞 → 任务让出 CPU → 等数据被消费后再唤醒
//   - 互斥锁保护 DMA 缓冲区（同一时间只能有一个 DMA 传输在进行）
```

## 8. MPU6050 寄存器参考

```c
// 核心寄存器（用于驱动开发和调试）

#define MPU_ADDR              0x68  // AD0=0
#define MPU_PWR_MGMT1_REG     0x6B  // 电源管理：bit6=SLEEP
#define MPU_SMPLRT_DIV_REG    0x19  // 采样率分频
#define MPU_CONFIG_REG        0x1A  // 低通滤波器
#define MPU_GYRO_CONFIG_REG   0x1B  // 陀螺仪量程
#define MPU_ACCEL_CONFIG_REG  0x1C  // 加速度计量程
#define MPU_FIFO_EN_REG       0x23  // FIFO 使能
#define MPU_INT_ENABLE_REG    0x38  // 中断使能
#define MPU_INT_STATUS_REG    0x3A  // 中断状态
#define MPU_ACCEL_XOUT_H_REG  0x3B  // 加速度 X 高字节（14 字节 burst read 起点）
#define MPU_FIFO_R_W_REG      0x74  // FIFO 读写
#define MPU_WHO_AM_I_REG      0x75  // WHO_AM_I: 应返回 0x68
```

## 下一步

下一篇将介绍 **EM7028 心率传感器与 BMP280 气压计驱动**：心率传感器的 PPG 信号采集与滤波、BMP280 气压/温度读取与海拔换算、以及这两种传感器在 Bicycle_Watch 中的应用场景。
