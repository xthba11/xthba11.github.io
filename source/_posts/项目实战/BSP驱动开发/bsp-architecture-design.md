---
title: BSP 驱动分层架构与接口抽象设计（Bicycle_Watch 实战）
date: 2025-12-22
categories:
  - 项目实战
  - BSP开发
tags:
  - BSP
  - 驱动架构
  - 分层设计
  - I2C
  - SPI
  - 接口抽象
  - Bicycle_Watch
description: Bicycle_Watch BSP 驱动架构全景：三层分离设计（Driver/Handler/Adapter）、面向接口的函数指针抽象、I2C/SPI 通信接口统一、OS 适配层（临界区/延迟/信号量）、驱动实例化（inst）模式
cover: /img/covers/articles/bsp-architecture-design.svg
top_img: /img/covers/articles/bsp-architecture-design.svg
---

# BSP 驱动分层架构与接口抽象设计

## 1. 为什么需要分层

嵌入式项目中最容易失控的就是驱动代码。一个 I2C 传感器驱动，不同的人会写出完全不同的风格：有人直接调 HAL 库，有人封装了函数指针，有人用全局变量传递句柄。Bicycle_Watch 的 BSP 层用一套严格的**三层分离 + 接口抽象**模式统一了所有传感器驱动。

```
┌─────────────────────────────────────────────────────────┐
│                  05_Service（服务层）                     │
│   service_sensor.c — 传感器调度、采样策略、数据分发       │
├─────────────────────────────────────────────────────────┤
│           02_BSP_Platform（BSP 平台层）                   │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Bsp_Drivers/ — 驱动层（纯逻辑，不依赖 MCU 型号）     │  │
│  │   ├── Sensor_Temphumi/driver/Aht21/               │  │
│  │   ├── Motion_processing_sensor/mpu6050/driver/    │  │
│  │   ├── Hartrate/Driver/    (EM7028)                │  │
│  │   └── ...                                         │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ Bsp_Integration/ — 集成层（驱动 + OS + 硬件 的胶水）  │  │
│  │   └── mpu6050_Integration/                        │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ Platform_Interface/ — 适配层（统一对外接口）          │  │
│  │   ├── display/  (bsp_adapter_port_display)        │  │
│  │   └── flash/    (bsp_adapter_port_flash)          │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│           02_MCU_Platform（MCU 抽象层）                   │
│   MCU_Core_IIC/i2c_port  /  MCU_Core_SPI/spi_port      │
│   封装 HAL 库，提供统一的 I2C/SPI 操作接口               │
├─────────────────────────────────────────────────────────┤
│           STM32 HAL (硬件层)                             │
│   HAL_I2C / HAL_SPI / HAL_GPIO / HAL_DMA                │
└─────────────────────────────────────────────────────────┘
```

> **核心原则**：驱动代码不调 HAL 库函数，上层代码不关心传感器型号。每一层只依赖下一层提供的接口，不依赖具体实现。

## 2. 面向接口的函数指针抽象

### 2.1 I2C 通信接口（软件 I2C 模式）

```c
// bsp_aht21_driver.h — 驱动对外暴露的 I2C 接口定义

// Bicycle_Watch 同时支持硬件 I2C 和软件 I2C（GPIO 模拟）
// 通过 #define HARDWARE_IIC 切换

#ifndef HARDWARE_IIC     // 软件 I2C（GPIO 模拟，项目当前使用）
typedef struct {
    aht21_status_t (*pf_iic_init)        (void *);
    aht21_status_t (*pf_iic_deinit)      (void *);
    aht21_status_t (*pf_iic_start)       (void *);   // 起始信号
    aht21_status_t (*pf_iic_stop)        (void *);   // 停止信号
    aht21_status_t (*pf_iic_wait_ack)    (void *);   // 等待从机 ACK
    aht21_status_t (*pf_iic_send_ack)    (void *);   // 发送 ACK
    aht21_status_t (*pf_iic_send_no_ack) (void *);   // 发送 NACK
    aht21_status_t (*pf_iic_send_byte)   (void *, const uint8_t);
    aht21_status_t (*pf_iic_receive_byte)(void *, uint8_t *const);
    aht21_status_t (*pf_critical_enter)  (void);      // 进入临界区
    aht21_status_t (*pf_critical_exit)   (void);      // 退出临界区
} ahtxx_iic_driver_interface_t;
#endif
```

### 2.2 时间基准与 OS 延迟接口

```c
// 时间基准接口 — 来自 MCU 层（SysTick）
typedef struct {
    uint32_t (*pf_get_tick_count)(void);  // 获取系统 ms 滴答数
} ahtxx_timebase_interface_t;

// OS 延迟接口 — 来自 FreeRTOS（非阻塞延迟）
typedef struct {
    void (*pf_rtos_yield)(const uint32_t);  // 任务让出 CPU N ms
} ahtxx_yield_interface_t;
```

### 2.3 接口组合：驱动实例结构体

```c
// 将分散的接口组合为一个完整的驱动实例
typedef struct {
    // ★ 接口指针（依赖注入——谁用谁提供）
    ahtxx_iic_driver_interface_t  *p_iic_driver_instance;
    ahtxx_timebase_interface_t    *p_timebase_instance;
    ahtxx_yield_interface_t       *p_yield_instance;

    // ★ 功能函数指针（驱动对外暴露的操作）
    aht21_status_t (*pf_init)         (void *const);
    aht21_status_t (*pf_deinit)       (void *const);
    aht21_status_t (*pf_read_id)      (void *const);
    aht21_status_t (*pf_read_temp_humi)(void *const, float *temp, float *humi);
    aht21_status_t (*pf_read_humi)     (void *const, float *humi);
    aht21_status_t (*pf_sleep)        (void *const);
    aht21_status_t (*pf_wakeup)       (void *const);
} bsp_aht21_driver_t;
```

## 3. 实例化模式（inst 模式）

Bicycle_Watch 的所有驱动都遵循 **inst 模式**——不提供全局的驱动对象，而是由上层分配内存、传入接口、调用 `xxx_inst()` 完成初始化：

```c
// 上层调用示例（service_sensor.c 中的初始化流程）：

// ① 声明驱动实例（静态分配或动态分配）
bsp_aht21_driver_t aht21_driver;

// ② 准备 I2C 接口（软件 I2C 的函数指针绑定）
ahtxx_iic_driver_interface_t i2c_if = {
    .pf_iic_init       = sw_i2c_init,
    .pf_iic_start      = sw_i2c_start,
    .pf_iic_stop       = sw_i2c_stop,
    .pf_iic_send_byte  = sw_i2c_send_byte,
    .pf_iic_receive_byte = sw_i2c_receive_byte,
    .pf_iic_wait_ack   = sw_i2c_wait_ack,
    .pf_iic_send_ack   = sw_i2c_send_ack,
    .pf_iic_send_no_ack = sw_i2c_send_nack,
    .pf_critical_enter = osal_enter_critical,
    .pf_critical_exit  = osal_exit_critical,
};

// ③ 准备时间基准接口
ahtxx_timebase_interface_t timebase = {
    .pf_get_tick_count = HAL_GetTick,  // 或 osKernelGetTickCount
};

// ④ 准备 OS 延迟接口
ahtxx_yield_interface_t yield = {
    .pf_rtos_yield = osal_task_delay_ms,
};

// ⑤ 实例化——驱动内部完成初始化 + ID 校验
aht21_inst(&aht21_driver, &i2c_if, &yield, &timebase);

// ⑥ 使用驱动
float temp, humi;
aht21_driver.pf_read_temp_humi(&aht21_driver, &temp, &humi);
```

### inst 模式的收益

| 对比维度 | 全局变量模式 | inst 模式 |
|---------|------------|----------|
| 多实例支持 | 需要修改代码 | 天然支持（多个 struct） |
| 单元测试 | 困难（全局状态耦合） | 简单（Mock 接口指针） |
| 代码复用 | MCU 换了要改驱动 | 只换接口实现，驱动代码不变 |
| 依赖关系 | 隐式（#include HAL） | 显式（传入接口指针） |

## 4. MPU6050 的大规模接口设计

MPU6050 是最复杂的传感器，其驱动接口远多于 AHT21：

```c
typedef struct bsp_mpuxxx_driver {
    // ====== 核心层接口（依赖注入） ======
    mpuxxx_iic_driver_interface_t   *p_iic_driver_interface;   // I2C（含 DMA）
    hardware_interrupt_interface_t  *p_interrupt_interface;    // 硬件中断
    mpuxxx_delay_interface_t        *p_delay_interface;        // us/ms 延迟
    mpuxxx_timebase_interface_t     *p_timebase_interface;     // 时间基准

    // ====== OS 层接口（FreeRTOS 相关） ======
    mpuxxx_yield_interface_t        *p_yield_interface;        // RTOS 延迟
    mpuxxx_os_interface_t           *p_os_interface;           // 队列/信号量/互斥锁

    // ====== 功能函数指针（24 个） ======
    mpuxxx_status_t (*pf_sleep)              (...);
    mpuxxx_status_t (*pf_wakeup)             (...);
    mpuxxx_status_t (*pf_set_gyro_fsr)       (...);   // 陀螺仪量程
    mpuxxx_status_t (*pf_set_accel_fsr)      (...);   // 加速度计量程
    mpuxxx_status_t (*pf_set_lpf)            (...);   // 低通滤波器
    mpuxxx_status_t (*pf_set_rate)           (...);   // 采样率
    mpuxxx_status_t (*pf_get_temperature)    (...);
    mpuxxx_status_t (*pf_get_accel)          (...);
    mpuxxx_status_t (*pf_get_gyro)           (...);
    mpuxxx_status_t (*pf_get_all_data)       (...);   // 一次读全部
    mpuxxx_status_t (*pf_read_fifo_packet)   (...);   // FIFO 批量读
    mpuxxx_status_t (*pf_read_fifo_isr_occur)(...);   // 中断中 FIFO 读
    // ... 还有 12 个
} bsp_mpuxxx_driver_t;
```

## 5. 硬件 I2C vs 软件 I2C 切换

```c
// Bicycle_Watch 工程使用软件 I2C（#undef HARDWARE_IIC）

// 硬件 I2C 接口（HAL 库封装，代码更简洁）：
#ifdef HARDWARE_IIC
typedef struct {
    aht21_status_t (*pfiic_init)       (void *);
    aht21_status_t (*pfiic_send_byte)  (void *, uint8_t);
    aht21_status_t (*pfiic_receive_byte)(void *);
} ahtxx_iic_driver_interface_t;
#endif

// 软件 I2C 接口（GPIO 模拟，需要更多控制）：
#ifndef HARDWARE_IIC
typedef struct {
    aht21_status_t (*pf_iic_start)     (void *);  // 需要手动拉 SDA/SCL
    aht21_status_t (*pf_iic_stop)      (void *);
    aht21_status_t (*pf_iic_wait_ack)  (void *);
    aht21_status_t (*pf_iic_send_ack)  (void *);
    aht21_status_t (*pf_iic_send_no_ack)(void *);
    aht21_status_t (*pf_iic_send_byte) (void *, const uint8_t);
    aht21_status_t (*pf_iic_receive_byte)(void *, uint8_t *const);
    aht21_status_t (*pf_critical_enter)(void);   // 软件 I2C 需要临界区保护
    aht21_status_t (*pf_critical_exit) (void);
} ahtxx_iic_driver_interface_t;
#endif

// 为什么用软件 I2C？
//   - STM32F411 的 I2C 外设以难用著称（中断管理复杂、DMA 配置繁琐）
//   - GPIO 模拟 I2C 代码透明可控，调试方便
//   - 对温湿度传感器来说 100kHz 的 I2C 速率足够（数据量小）
//   - 缺点：CPU 占用略高（但对 FreeRTOS 多任务环境影响不大）
```

## 6. 驱动中的 CRC 校验

AHT21 的数据完整性保障使用了 CRC-8 校验：

```c
// AHT21 驱动中的 CRC-8（多项式 0x31）
// 用于验证温湿度数据在 I2C 传输中没有损坏

#define CRC8_POLYNOMIAL  0x31
#define CRC8_INITIAL     0xFF

static uint8_t CheckCrc8(const uint8_t *p_data, const uint8_t length)
{
    uint8_t crc = CRC8_INITIAL;

    for (uint8_t i = 0; i < length; i++) {
        crc ^= p_data[i];  // XOR 当前字节

        // 逐位处理
        for (uint8_t j = 0; j < 8; j++) {
            if (crc & 0x80) {
                crc = (crc << 1) ^ CRC8_POLYNOMIAL;
            } else {
                crc <<= 1;
            }
        }
    }
    return crc;
}

// 校验：将 CRC 计算值与传感器返回的 CRC 字节对比
// 不匹配 → 丢弃本次读数 → 等待下次采样
```

## 7. 驱动命名规范

Bicycle_Watch 的 BSP 层遵循统一的命名规范：

```text
文件命名:
  bsp_<设备名>_driver.c/h       ← 驱动实现
  bsp_<设备名>_reg.h           ← 寄存器定义
  bsp_<设备名>_reg_bit.h       ← 寄存器位定义（复杂设备）

函数命名:
  <设备名>_inst()    ← 实例化
  <设备名>_init()    ← 初始化
  <设备名>_read_xxx() ← 读取数据

状态枚举:
  <设备名>_status_t  ← 统一的状态返回类型
    <设备名>_OK
    <设备名>_ERROR
    <设备名>_ERRORTIMEOUT
    <设备名>_ERRORRESOURCE
    <设备名>_ERRORPARAMETER

接口结构体:
  <设备名>_<功能>_interface_t
  例: ahtxx_iic_driver_interface_t

驱动结构体:
  bsp_<设备名>_driver_t
```

## 8. 驱动目录结构总览

```
02_BSP_Platform/
├── Bsp_Drivers/
│   ├── Sensor_Temphumi/driver/Aht21/     ← AHT21 温湿度传感器
│   │   ├── Inc/
│   │   │   ├── bsp_aht21_driver.h        ← 驱动接口定义(130行)
│   │   │   └── bsp_aht21_reg.h           ← 寄存器定义(10行)
│   │   └── Src/
│   │       └── bsp_aht21_driver.c        ← 驱动实现(600行)
│   │
│   ├── Motion_processing_sensor/mpu6050/ ← MPU6050 六轴传感器
│   │   ├── driver/
│   │   │   ├── Inc/
│   │   │   │   ├── bsp_mpuxxx_driver.h   ← 驱动接口(277行)
│   │   │   │   ├── bsp_mpu6050_reg.h     ← 寄存器地址
│   │   │   │   └── bsp_mpu6050_reg_bit.h ← 寄存器位定义
│   │   │   └── Src/
│   │   │       └── bsp_mpuxxx_driver.c   ← 驱动实现(600+行)
│   │   └── handler/
│   │       └── bsp_mpuxxx_handler.c      ← 数据处理(FIFO/Kalman/步数)
│   │
│   ├── Hartrate/Driver/                 ← EM7028 心率传感器
│   │   ├── Inc/
│   │   │   ├── bsp_em7028_driver.h
│   │   │   └── bsp_em7028_reg.h
│   │   └── Src/
│   │       └── bsp_em7028_driver.c
│   │
│   └── ExternStorage_Flash/             ← W25Q64 外部 Flash
│       ├── handler/
│       └── config/flash_config.h
│
├── Bsp_Integration/                      ← 集成层
│   └── mpu6050_Integration/             ← MPU6050 中断+DMA 集成
│
└── Platform_Interface/                   ← 适配层
    ├── display/
    ├── flash/
    └── ...
```

## 下一步

下一篇将深入 **AHT21 温湿度传感器 I2C 驱动开发**：I2C 通信时序详解、测量命令发送（0xAC+0x33+0x00）、80ms 等待 + 状态轮询、6 字节数据读取与拼装、温湿度计算公式推导、CRC-8 校验。
