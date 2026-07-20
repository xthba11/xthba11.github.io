---
title: OTA 固件升级系统架构与双区备份设计（Bicycle_Watch 实战）
date: 2026-07-20
categories:
  - 技术笔记
  - 嵌入式
  - OTA开发
tags:
  - OTA
  - 固件升级
  - 双区备份
  - Bootloader
  - STM32F411
  - Ymodem
  - W25Q64
  - Bicycle_Watch
description: Bicycle_Watch OTA 系统架构全景：四阶段状态机（WaitReqDownload → OtaDownload → WaitReqUpdate → OtaEnd）、双区备份（AreaA/AreaB）策略、Flash 内存布局、App Info 标志管理、多任务协作模型
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# OTA 固件升级系统架构与双区备份设计

## 1. 为什么需要 OTA

Bicycle_Watch 是穿戴式设备，一旦量产发货，就不可能用 J-Link 给每台设备烧录固件。OTA（Over-The-Air，无线固件升级）是产品化必须的能力：

| 升级方式 | 适用阶段 | 用户体验 |
|---------|---------|---------|
| J-Link / ST-Link | 开发调试 | 需要物理连接 |
| USB DFU | 工厂量产 | 插线操作 |
| UART Ymodem | 售后本地升级 | 需要 PC + 串口工具 |
| BLE OTA | 售后无线升级 | 手机 App 一键升级 ★ |

Bicycle_Watch 当前实现了 **UART + Ymodem** 有线升级方案，并预留了 BLE OTA 的扩展接口。本文聚焦于 **UART Ymodem OTA** 的完整架构。

## 2. 系统全景架构

```
┌──────────────────────────────────────────────────────────┐
│                     OTA 系统全景                           │
│                                                          │
│  PC端 (SecureCRT)              STM32F411                  │
│  ┌──────────────┐     UART    ┌──────────────────────┐   │
│  │ Ymodem 发送  │────────────►│ USART1 (RX DMA+IDLE) │   │
│  │ firmware.bin │◄────────────│ (TX) ACK / NAK / CA  │   │
│  └──────────────┘   115200bps └──────────┬───────────┘   │
│                                         │                │
│                              ┌──────────┴───────────┐   │
│                              │    OTA Task           │   │
│                              │  (ota_task_runnable)  │   │
│                              │   四阶段状态机          │   │
│                              └──────────┬───────────┘   │
│                                         │                │
│                    ┌────────────────────┼────────────┐   │
│                    │                    │             │   │
│               ┌────┴────┐     ┌────────┴──────┐     │   │
│               │ Ymodem  │     │ Download Task  │     │   │
│               │ Receive │     │ (写W25Q64)     │     │   │
│               └─────────┘     └───────┬────────┘     │   │
│                                       │               │   │
│                              ┌────────┴────────┐     │   │
│                              │   W25Q64 外部    │     │   │
│                              │   Flash (OTA区)  │     │   │
│                              │   0x000000~1MB   │     │   │
│                              └────────┬────────┘     │   │
│                                       │               │   │
│                              ┌────────┴────────┐     │   │
│                              │  内部 Flash 编程  │     │   │
│                              │  HAL_FLASH_*     │     │   │
│                              │  Sector 4-7      │     │   │
│                              └────────┬────────┘     │   │
│                                       │               │   │
│                              ┌────────┴────────┐     │   │
│                              │   SoftReset()    │     │   │
│                              │   → Boot Manager  │     │   │
│                              └─────────────────┘     │   │
└──────────────────────────────────────────────────────────┘
```

## 3. 四阶段状态机

OTA 升级过程由 `ota_task_runnable` 任务驱动，使用有限状态机管理整个流程：

```c
// service_ota_manager.h — OTA 状态定义

typedef enum {
    WaitReqDownload = 0,  // 等待 PC 端发起 Ymodem 传输
    OtaDownload,          // Ymodem 接收中 → 数据写入 W25Q64
    WaitReqUpdate,        // 下载完成 → 等待用户确认更新
    OtaEnd                // 执行复位，进入 Boot Manager
} E_Ota_State;

static E_Ota_State s_e_Ota_State = WaitReqDownload;
```

### 3.1 状态转移图

```
   ┌──────────────┐
   │ WaitReqDownload│◄────────── 失败/超时 ──────────┐
   │ (等待下载指令)  │                                  │
   └──────┬────────┘                                  │
          │ 收到 0x11 0x22 0x33 命令                   │
          │ + 用户在 LVGL 确认下载                      │
          ▼                                           │
   ┌──────────────┐                                  │
   │ OtaDownload   │────────── Ymodem 传输失败 ────────┤
   │ (Ymodem接收)  │                                  │
   └──────┬────────┘                                  │
          │ Ymodem 成功 + CRC 校验通过                  │
          │ + 写入 App Info (AreaASize, RunState)       │
          ▼                                           │
   ┌──────────────┐                                  │
   │ WaitReqUpdate │────── 用户取消/超时 ─────────────┤
   │ (等用户确认更新)│                                  │
   └──────┬────────┘                                  │
          │ 用户确认 + 软件复位                         │
          ▼                                           │
   ┌──────────────┐
   │ OtaEnd        │──► SoftReset() → Boot Manager
   │ (执行复位)     │
   └──────────────┘
```

### 3.2 状态机实现

```c
// service_ota_manager.c — 状态机主循环

void ota_task_runnable(void *argument)
{
    uint16_t t_u16_rec_length = 0;
    int32_t t_int32_app_data_length = 0;

    for (;;) {
        switch (s_e_Ota_State) {

        // ====== 阶段 1：等待下载指令 ======
        case WaitReqDownload:
            lvgl_ota_screen_write(UI_STATE_OTA_NONE);

            // 监听 USART1，等待 PC 端发送 OTA 启动命令 (0x11 0x22 0x33)
            core_usart_receive_to_idle_dma(CORE_USART1, s_au8_OtaCmd, 4);

            // 取消看门狗，等待 Ymodem 接收队列通知
            watchdog_unregister(osal_task_get_current_handle());
            osal_queue_receive(
                st_userqueuecfg[YmodemRec_Queue].queue_handle,
                &t_u16_rec_length, OSAL_MAX_DELAY);
            // OTA 任务最长 600 秒（10 分钟）——超过此时间看门狗复位
            watchdog_register(osal_task_get_current_handle(),
                              600000, "OTA_task");

            // 校验启动命令
            if ((3 == t_u16_rec_length) &&
                (s_au8_OtaCmd[0] == 0x11) &&
                (s_au8_OtaCmd[1] == 0x22) &&
                (s_au8_OtaCmd[2] == 0x33)) {

                // 通知 LVGL 弹出升级确认弹窗
                lvgl_ota_screen_write(UI_STATE_OTA_REQUIRE);

                // 等待用户在屏幕上点击"同意"/"拒绝"（最长 100s）
                uint16_t t_u8_confirmcnt = 0;
                while (0 == lvgl_ota_download_requirest_state_read()) {
                    osal_task_delay(50);
                    t_u8_confirmcnt++;
                    if (t_u8_confirmcnt >= 2000) break;  // 超时退出
                }

                if (1 == lvgl_ota_download_requirest_state_read()) {
                    s_e_Ota_State = OtaDownload;
                    lvgl_ota_screen_write(UI_STATE_OTA_NONE);
                }
            }
            break;

        // ====== 阶段 2：Ymodem 下载 ======
        case OtaDownload:
            lvgl_ota_download_percentage_write(0);

            // ★ 核心：调用 Ymodem_Receive 接收固件
            // 参数是两个 1030 字节的缓冲区（双缓冲 ping-pong）
            // 返回值 = 固件文件大小（字节），-1 = 失败
            t_int32_app_data_length = Ymodem_Receive(
                g_au8_YmodemRec_A, g_au8_YmodemRec_B);

            lvgl_ota_download_percentage_write(100);

            if (0 < t_int32_app_data_length) {
                s_e_Ota_State = WaitReqUpdate;

                // 写入剩余缓冲数据到 W25Q64
                w25q64_write_data_end();

                // ★ 写入 App Info 标志（Flash 中的持久化信息区）
                set_app_flag_value(App_AreaASize,
                    (uint32_t)t_int32_app_data_length);
                set_app_flag_value(App_RunState, APP_WAIT_UPDATE);
            } else {
                s_e_Ota_State = WaitReqDownload;  // 传输失败，回退
            }
            break;

        // ====== 阶段 3：等待用户确认更新 ======
        case WaitReqUpdate:
            lvgl_ota_screen_write(UI_STATE_OTA_DONE);

            // 再次等待用户确认"立即重启升级"
            uint16_t confirm_cnt = 0;
            lvgl_ota_download_requirest_state_write(0);

            while (0 == lvgl_ota_download_requirest_state_read()) {
                osal_task_delay(50);
                confirm_cnt++;
                if (confirm_cnt >= 2000) break;
            }

            if (1 == lvgl_ota_download_requirest_state_read()) {
                s_e_Ota_State = OtaEnd;
            } else {
                s_e_Ota_State = WaitReqDownload;  // 用户取消
            }
            break;

        // ====== 阶段 4：复位 → Boot Manager 接管 ======
        case OtaEnd:
            osal_task_delay(1000);  // 给 UI 1s 时间显示"即将重启"
            SoftReset();           // NVIC_SystemReset()
            break;
        }
    }
}
```

## 4. 双区备份（AreaA / AreaB）

### 4.1 为什么需要双区备份

单区 OTA 有一个致命缺陷：如果在升级过程中断电，设备变砖。双区备份通过保留旧固件来保障安全：

```
Flash 内存布局（STM32F411, 512KB Flash）:

┌──────────────────────┐ 0x08000000  (0KB)
│   Boot Manager        │  48KB (Sector 0-2)
│   启动管理程序          │
├──────────────────────┤ 0x0800C000  (48KB)
│                      │
│   Area A (主固件区)    │  232KB (Sector 3-6)
│   当前运行的应用        │  MAXAPP_SIZE = 464KB
│                      │
├──────────────────────┤ 0x08046000
│   Area B (备份固件区)  │  232KB (Sector 7-10)
│   待升级的新固件        │
│                      │
├──────────────────────┤ 0x08080000  (512KB)
│   App Info (标志区)    │  16KB (Sector 4 in alternate view)
│   升级状态标志 + 版本号  │
└──────────────────────┘

设计说明：
  Boot Manager 总是放在 Flash 起始位置（48KB 够用）
  Area A 和 Area B 轮流作为"运行区"和"升级区"
  当前运行 Area A → 新固件下载到 Area B → 验证后切换
  下次升级时，新固件下载到 Area A → 验证后切回
```

### 4.2 App Info 标志区

```c
// 存储于内部 Flash 的 0x08008000 地址
// 每个字段都有反码（Anti）校验——防止 Flash bit-flip 导致的错误判断

typedef struct {
    uint32_t u32_App_RunState;       // 应用状态（值 = APP_WAIT_UPDATE / APP_Valid 等）
    uint32_t u32_App_RunState_Anti;  // 反码（~值），用于完整性校验
    uint32_t u32_App_AreaASize;      // Area A 固件大小
    uint32_t u32_App_AreaASize_Anti;
    uint32_t u32_App_AreaBState;     // Area B 固件状态
    uint32_t u32_App_AreaBState_Anti;
    uint32_t u32_App_AreaBSize;      // Area B 固件大小
    uint32_t u32_App_AreaBSize_Anti;
} st_App_Info_t;

// 状态枚举（关键值）
typedef enum {
    APP_WAIT_UPDATE = 0x11111111,  // 有固件等待更新（断点续传场景也可用）
    APP_Check_NewApp = 0x22222222, // Boot Manager 正在校验新固件
    APP_AreaAToAreaB = 0x33333333, // 正在从 AreaA 搬运到 AreaB（Flash-to-Flash copy）
    APP_Valid = 0x44444444,        // ★ 固件有效，可直接运行
    APP_AreaBState_Valid = 0x55555555, // AreaB 中的固件校验通过
} en_App_State_t;

// 反码校验机制：
// 读取时：if (u32_App_RunState == ~u32_App_RunState_Anti)
//   ✓ 通过 → 标志值可信
//   ✗ 不通过 → Flash 数据损坏，进入安全模式
```

### 4.3 标志位写入与读取

```c
// 写入 App Info 标志（原子操作，临界区保护）
void set_app_flag_value(en_App_FlagType_t AppFlagType, uint32_t AppFlagValue)
{
    switch (AppFlagType) {
    case App_RunState:
        AppInfo.u32_App_RunState = AppFlagValue;
        AppInfo.u32_App_RunState_Anti = ~AppFlagValue;  // 自动生成反码
        break;
    case App_AreaASize:
        AppInfo.u32_App_AreaASize = AppFlagValue;
        AppInfo.u32_App_AreaASize_Anti = ~AppFlagValue;
        break;
    // ... 其他字段类似
    }

    // 临界区保护（写入过程中不能被中断打断）
    osal_enter_critical();
    ota_Flash_EraseWrite_HAL(
        AppFlagAddress,                    // 0x08008000
        (const uint8_t *)&AppInfo,
        sizeof(st_App_Info_t));
    osal_exit_critical();
}

// 读取 App Info 标志（带反码校验）
uint8_t read_app_flag_value(en_App_FlagType_t AppFlagType,
                             uint32_t *p_u32_AppFlagValue)
{
    uint8_t u8_result = 1;  // 默认失败

    // 从 Flash 固定地址 0x08008000 读取整个结构体
    memcpy(&AppInfo, (uint8_t *)BOOT_MANAGER_APP_INFO_ADDR,
           sizeof(st_App_Info_t));

    switch (AppFlagType) {
    case App_RunState:
        // 反码校验通过才返回
        if (AppInfo.u32_App_RunState == ~AppInfo.u32_App_RunState_Anti) {
            *p_u32_AppFlagValue = AppInfo.u32_App_RunState;
            u8_result = 0;  // 读取成功
        }
        break;
    // ...
    }
    return u8_result;
}
```

## 5. 多任务协作模型

OTA 流程涉及 4 个 FreeRTOS 任务和多个同步原语：

```
┌─────────────────────────────────────────────────────────┐
│                      任务协作图                           │
│                                                         │
│  ┌──────────┐   队列       ┌──────────────┐             │
│  │ OTA Task │◄───────────│ USART1 ISR    │             │
│  │(状态机)   │ YmodemRec   │ (DMA+IDLE)   │             │
│  └────┬─────┘             └──────────────┘             │
│       │                                                 │
│       │ 队列(AppDataBuffer)                              │
│       ▼                                                 │
│  ┌──────────────┐   互斥锁     ┌──────────────────┐     │
│  │ Download Task│◄──────────►│ ExtFlash Task     │     │
│  │ (缓冲管理)   │ Semaphore   │ (W25Q64 写入)     │     │
│  └──────┬───────┘             └──────────────────┘     │
│         │                                               │
│         │ 事件组(EVENT_OTA)                              │
│         ▼                                               │
│  ┌──────────────┐                                       │
│  │Storage Mgr   │                                       │
│  │(Flash 分区)   │                                       │
│  └──────────────┘                                       │
│                                                         │
│  ┌──────────────┐    全局变量     ┌──────────────┐      │
│  │  LVGL Task   │◄──────────────►│  OTA Task     │      │
│  │  (进度条 UI)  │   lvgl_port    │  (状态通知)    │      │
│  └──────────────┘                └──────────────┘      │
└─────────────────────────────────────────────────────────┘
```

### 5.1 队列定义

```c
// 两个关键队列：

// ① YmodemRec_Queue：USART 中断 → OTA Task
//    数据流向：USART1 收到一帧数据 → 通知 OTA Task
//    负载：接收长度 (uint16_t)

// ② AppDataBuffer_Queue：OTA Task → Download Task
//    数据流向：OTA Task 解析出一个数据包 → 交给 Download Task 写 W25Q64
//    负载：数据缓冲区指针 (uint8_t*)
```

### 5.2 互斥锁保护 W25Q64

```c
// W25Q64 只有一个 SPI 总线，不能同时读写
// → 使用互斥锁保证 Download Task 和 ExtFlash Task 的互斥访问

extern osal_mutex_handle_t Semaphore_ExtFlashState;

// Download Task 中写入数据时的典型流程：
void download_app_data_task_runnable(void *argument)
{
    uint8_t *pu8_data = NULL;
    int32_t file_size = 0;
    int32_t download_size = 0;

    // 首先接收文件大小
    osal_queue_receive(
        st_userqueuecfg[AppDataBuffer_Queue].queue_handle,
        &file_size, OSAL_MAX_DELAY);

    // 释放信号量 → 初始化完成，OTA Task 可以开始发数据
    osal_mutex_give(Semaphore_ExtFlashState);

    while (1) {
        // 阻塞等待新数据包
        osal_queue_receive(
            st_userqueuecfg[AppDataBuffer_Queue].queue_handle,
            &pu8_data, OSAL_MAX_DELAY);

        // ★ 获取互斥锁 → 确保独占 W25Q64
        if (osal_mutex_take(Semaphore_ExtFlashState,
                            OSAL_MAX_DELAY) == OSAL_SUCCESS) {
            if (pu8_data != NULL) {
                // 写入外部 Flash
                w25q64_write_data(pu8_data, g_u32_datalength);
                download_size += g_u32_datalength;

                // 更新 LVGL 进度条
                lvgl_ota_download_percentage_write(
                    download_size * 100 / file_size);
            }
            // 释放锁
            osal_mutex_give(Semaphore_ExtFlashState);
        }
    }
}
```

## 6. 外部 Flash 分区

Bicycle_Watch 的 W25Q64（8MB）被划分为 4 个功能区域：

```c
// service_externflash_manage.h — W25Q64 分区规划

#define MEMORY_OTA_START_ADDRESS      (0x000000UL)  // 0~1MB   OTA 固件暂存
#define MEMORY_OTA_END_ADDRESS        (0x0FFFFFUL)

#define MEMORY_FLASHDB_START_ADDRESS  (0x100000UL)  // 1~2MB   Flash 数据库
#define MEMORY_FLASHDB_END_ADDRESS    (0x1FFFFFUL)

#define MEMORY_FATFS_START_ADDRESS    (0x200000UL)  // 2~3MB   FATFS 文件系统
#define MEMORY_FATFS_END_ADDRESS      (0x2FFFFFUL)

#define MEMORY_LVGL_START_ADDRESS     (0x300000UL)  // 3~6MB   LVGL UI 资源
#define MEMORY_LVGL_END_ADDRESS       (0x5FFFFFUL)

// OTA 区域设计：
//   1MB 空间足以容纳 464KB 的最大应用固件
//   下载时数据先写入 OTA 区，校验通过后再复制到内部 Flash
//   下载失败不污染其他分区
```

## 7. OTA 系统关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 传输接口 | USART1 @ 115200 bps | 有线 Ymodem |
| 协议 | Ymodem (1K 模式) | 1024 字节/包 |
| 缓冲区大小 | 1030 字节 × 2 | 双缓冲 ping-pong |
| 外部 Flash | W25Q64, SPI | 8MB, OTA 区 1MB |
| 内部 Flash | STM32F411, 512KB | Sector 0-2 给 Boot Manager |
| APP_MAX_SIZE | 464KB | 应用固件最大容量 |
| 看门狗超时 | 600 秒 | OTA 任务级超时 |
| 用户确认超时 | 100 秒 | 等待用户点击"确认升级" |
| Ymodem 错误重试 | 3 次 | MAX_ERRORS = 3 |

## 下一步

下一篇将深入 **Ymodem 协议解析与实现**：数据包格式（SOH/STX/EOT/ACK/NAK/CA）、CRC16 校验算法、序列号机制、超时重传策略，以及 Bicycle_Watch 中的双缓冲接收代码。
