---
title: 外部 Flash 策略与 W25Q64 数据缓冲（OTA 暂存区设计）
date: 2026-07-20
categories:
  - 技术笔记
  - 嵌入式
  - OTA开发
tags:
  - OTA
  - W25Q64
  - 外部Flash
  - SPI
  - 数据缓冲
  - LittleFS
  - Bicycle_Watch
description: W25Q64 外部 Flash 在 OTA 系统中的实践：8MB 四分区设计（OTA/FlashDB/FATFS/LVGL）、4096 字节扇区缓冲策略、多任务互斥锁保护、事件组同步机制、SPI 写入性能优化
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# 外部 Flash 策略与 W25Q64 数据缓冲

## 1. W25Q64 在 OTA 系统中的角色

STM32F411 的内部 Flash 只有 512KB，无法同时存放运行中的固件和应用数据。Bicycle_Watch 使用 W25Q64（8MB SPI NOR Flash）作为 **OTA 固件暂存区** 和 **持久化数据存储**。

```
OTA 数据流：

  PC (SecureCRT)
      │ UART 115200 bps
      ▼
  STM32F411 USART1 (DMA + IDLE)
      │ 约 11.5 KB/s
      ▼
  RAM 缓冲区 (1030B × 2, ping-pong)
      │ 队列通知
      ▼
  Download Task (OTA Flash Handler)
      │ 累积到 4096 字节才写入
      ▼
  W25Q64 OTA 区域 (0x000000 ~ 0x0FFFFF, 1MB)
      │ 固件完整下载后
      ▼
  HAL_FLASH 擦写 STM32 内部 Flash (Sector 4-7)
      │ 44KB/s (Word 编程)
      ▼
  新固件就位 → Boot Manager 校验 → 跳转
```

> **为什么需要外部 Flash 暂存？**
> STM32 内部 Flash 在编程时不能同时执行代码（Flash 是统一编址的）。如果直接把 Ymodem 数据写入内部 Flash，USART 中断和 DMA 都无法正常工作（中断向量表在 Flash 中）。外部 Flash 通过 SPI 独立访问，不影响内部 Flash 的代码执行。

## 2. W25Q64 分区规划

### 2.1 四分区设计

```c
// service_externflash_manage.h — W25Q64 8MB 分区

/* W25Q64 总容量 8MB = 0x800000 (8388608 字节)
 * 划分为 4 个功能区域，每个区域有独立的地址范围校验 */

#define MEMORY_OTA_START_ADDRESS     (0x000000UL)  //   0 ~   1MB
#define MEMORY_OTA_END_ADDRESS       (0x0FFFFFUL)  //  OTA 固件暂存区

#define MEMORY_FLASHDB_START_ADDRESS (0x100000UL)  //   1MB ~ 2MB
#define MEMORY_FLASHDB_END_ADDRESS   (0x1FFFFFUL)  //  数据库存储区

#define MEMORY_FATFS_START_ADDRESS   (0x200000UL)  //   2MB ~ 3MB
#define MEMORY_FATFS_END_ADDRESS     (0x2FFFFFUL)  //  FAT 文件系统

#define MEMORY_LVGL_START_ADDRESS    (0x300000UL)  //   3MB ~ 6MB
#define MEMORY_LVGL_END_ADDRESS      (0x5FFFFFUL)  //  LVGL UI 资源、校准数据

/* 分区示意图：
   0x000000 ┌──────────────────┐
            │   OTA 区域 1MB   │  ← Ymodem 下载的固件暂存
   0x100000 ├──────────────────┤
            │  FlashDB 区域 1MB │  ← EasyLogger 日志、配置数据库
   0x200000 ├──────────────────┤
            │  FATFS 区域 1MB   │  ← 文件系统（备选，当前未启用）
   0x300000 ├──────────────────┤
            │  LVGL 区域 3MB    │  ← UI 图片、字体、触摸校准数据
            │                  │     使用 LittleFS 管理
   0x600000 ├──────────────────┤
            │  保留 2MB        │
   0x800000 └──────────────────┘
*/
```

### 2.2 地址范围校验

```c
// 每次写入前校验目标地址是否在合法区域内
// 防止固件 bug 导致的 Flash 越界写入

ext_flash_status_t write_ota_data(uint32_t flash_addr,
                                   uint8_t *srcaddr, uint32_t size)
{
    uint32_t write_addr = flash_addr + MEMORY_OTA_START_ADDRESS;

    // ① 起始地址校验
    if ((MEMORY_OTA_START_ADDRESS > write_addr) ||
        (MEMORY_OTA_END_ADDRESS < write_addr)) {
        return Ext_Flash_ERRORPARAMETER;
    }

    // ② 结束地址校验（防止跨区域写入）
    if ((write_addr + size) > MEMORY_OTA_END_ADDRESS) {
        return Ext_Flash_ERRORNOMEMORY;
    }

    // ③ 获取互斥锁
    if (OSAL_ERROR == osal_mutex_take(extern_flash_mutex_handler, 0)) {
        return Ext_Flash_ERROR;
    }

    // ④ 设置目标地址并通知 ExtFlash Task
    s_u32_TargetAddress = write_addr;
    s_u32_Size = size;
    p_au8_otadata = srcaddr;
    xEventGroupSetBits(userExtFlashEveGropHandle, EVENT_OTA);

    // ⑤ 等待写入完成（信号量同步）
    osal_sema_give(st_usersemacfg[ExtFlashSema].sema_handle);
    osal_sema_take(st_usersemacfg[ExtFlashSema].sema_handle,
                   OSAL_MAX_DELAY);
    osal_sema_take(st_usersemacfg[ExtFlashSema].sema_handle,
                   OSAL_MAX_DELAY);
    osal_mutex_give(extern_flash_mutex_handler);

    return Ext_Flash_OK;
}
```

## 3. 4096 字节扇区缓冲

### 3.1 为什么需要缓冲

W25Q64 的最小擦除单位是 4KB（一个 Sector），但支持 256 字节的 Page Program。Ymodem 每次发送 1024 字节，如果直接写到 W25Q64，每包触发一次 SPI 写入：

- 每次 SPI 写入有开销（命令 + 地址 + 等待）
- W25Q64 写入寿命有限（典型 10 万次擦除/扇区）

扇区缓冲策略：**攒够 4096 字节再写入一个完整扇区**，减少 SPI 操作次数。

### 3.2 OTA Flash Handler 实现

```c
// ota_flash_handler.h — W25Q64 OTA 数据处理器

// 缓冲区管理结构体
typedef struct {
    uint8_t  databuf[4096];          // 扇区缓冲区（4096 字节 = 1 个 Sector）
    uint16_t write_databuf_index;    // 缓冲区写指针（0~4095）
    uint32_t write_index;            // 总写入字节计数
    uint8_t  write_sector_index;     // 已写入的扇区计数
    uint32_t read_index;             // 读指针（用于读回校验）
    uint8_t  read_sector_index;      // 读扇区索引
} st_W25Q_Handler;

static st_W25Q_Handler s_st_W25Q_Handler_1;

#define SUBSECTOR_SIZE  4096  // 扇区大小 = 4KB
#define PAGE_SIZE       256   // 页大小 = 256B（W25Q64 的 Page Program 单位）
```

### 3.3 扇区缓冲写入逻辑

```c
// ota_flash_handler.c — 核心写入逻辑

void w25q64_init(void)
{
    externflash_init();  // SPI 初始化 + W25Q64 复位

    // 清空所有索引
    s_st_W25Q_Handler_1.read_index = 0;
    s_st_W25Q_Handler_1.read_sector_index = 0;
    s_st_W25Q_Handler_1.write_databuf_index = 0;
    s_st_W25Q_Handler_1.write_index = 0;
    s_st_W25Q_Handler_1.write_sector_index = 0;
}

// 收到 Ymodem 数据包 → 写入 OTA 缓冲区
uint8_t w25q64_write_data(uint8_t *data, uint32_t length)
{
    uint32_t addr = 0;
    uint16_t index = 0;

    for (uint16_t i = 0; i < length; i++) {
        // ① 逐字节写入 4KB 缓冲区
        index = s_st_W25Q_Handler_1.write_databuf_index;
        s_st_W25Q_Handler_1.databuf[index] = *(data + i);
        s_st_W25Q_Handler_1.write_databuf_index++;

        // ② 缓冲区满 → 整扇区写入 W25Q64
        if (s_st_W25Q_Handler_1.write_databuf_index == SUBSECTOR_SIZE) {
            // 重置缓冲指针
            s_st_W25Q_Handler_1.write_databuf_index = 0;

            // 计算 W25Q64 目标地址
            addr = SUBSECTOR_SIZE *
                   s_st_W25Q_Handler_1.write_sector_index;

            // ★ 写入 W25Q64（通过 SPI）
            write_ota_data(addr,
                           &s_st_W25Q_Handler_1.databuf[0],
                           SUBSECTOR_SIZE);

            // 更新扇区和字节计数
            s_st_W25Q_Handler_1.write_sector_index++;
            s_st_W25Q_Handler_1.write_index += SUBSECTOR_SIZE;
        }
    }
    return 0;
}

// 文件传输完成后 → 写入剩余的缓冲数据（不足 4096 字节的尾部）
uint8_t w25q64_write_data_end(void)
{
    uint32_t addr = 0;

    // 如果缓冲区还有未写入的数据
    if (0 != s_st_W25Q_Handler_1.write_databuf_index) {
        addr = SUBSECTOR_SIZE *
               s_st_W25Q_Handler_1.write_sector_index;

        // 写入尾部数据（不满一个扇区也可以——W25Q64 支持 Page Program）
        write_ota_data(addr,
                       &s_st_W25Q_Handler_1.databuf[0],
                       s_st_W25Q_Handler_1.write_databuf_index);

        s_st_W25Q_Handler_1.write_index +=
            s_st_W25Q_Handler_1.write_databuf_index;
    }
    return 0;
}
```

## 4. 多任务同步机制

### 4.1 事件组（EventGroup）

```c
// 使用 FreeRTOS EventGroup 管理多个 Flash 操作源的优先级

// 事件位定义
#define EVENT_OTA        (1 << 0)  // OTA 固件写入
#define EVENT_FLASHDB    (1 << 1)  // 数据库操作
#define EVENT_FATFS      (1 << 2)  // 文件系统操作
#define EVENT_LVGL       (1 << 3)  // LVGL 资源读取

// ExtFlash Task — 统一的外部 Flash 访问入口
void storage_manager_task(void *argument)
{
    // ① 初始化 LittleFS 文件系统
    lfs_port_init();
    int err = lfs_mount(&lfs, &lfs_w25q64_cfg);
    if (err) {
        lfs_format(&lfs, &lfs_w25q64_cfg);  // 首次使用 → 格式化
        lfs_mount(&lfs, &lfs_w25q64_cfg);
    }

    // ② 启动计数演示（使用 LittleFS 记录开机次数）
    lfs_file_open(&lfs, &file, "boot_count",
                  LFS_O_RDWR | LFS_O_CREAT);
    uint32_t boot_count = 0;
    lfs_file_read(&lfs, &file, &boot_count, sizeof(boot_count));
    boot_count += 1;
    lfs_file_rewind(&lfs, &file);
    lfs_file_write(&lfs, &file, &boot_count, sizeof(boot_count));
    DEBUG_OUT("boot_count_read %d", boot_count);
    lfs_file_close(&lfs, &file);
    lfs_unmount(&lfs);

    // ③ 主循环：等待事件触发
    EventBits_t uxBits;
    const EventBits_t uxBitsToWaitFor =
        EVENT_OTA | EVENT_FLASHDB | EVENT_FATFS | EVENT_LVGL;

    for (;;) {
        uxBits = xEventGroupWaitBits(
            userExtFlashEveGropHandle,  // 事件组句柄
            uxBitsToWaitFor,            // 等待的事件位
            pdTRUE,                     // 读取后清除
            pdFALSE,                    // 不等待全部位
            portMAX_DELAY               // 无限等待
        );

        watchdog_register(osal_task_get_current_handle(),
                          2000, "ExtFlashTask");

        switch (uxBits & uxBitsToWaitFor) {
        case EVENT_OTA:
            // OTA 数据写入外部 Flash → 最高优先级
            externflash_write(s_u32_TargetAddress,
                              s_u32_Size,
                              p_au8_otadata);
            break;

        case EVENT_LVGL:
            // LVGL 读取 Flash 中的图片/字体资源
            externflash_read(s_u32_TargetAddress,
                             s_u32_Size,
                             g_au8_lvgldata);
            osal_sema_give(st_usersemacfg[ExtFlashSema].sema_handle);
            break;
        }

        watchdog_unregister(osal_task_get_current_handle());
    }
}
```

### 4.2 互斥锁 + 信号量组合

```c
// W25Q64 访问的三级保护：
//
// ① 互斥锁 (extern_flash_mutex_handler)
//    保证同一时刻只有一个调用者能使用 s_u32_TargetAddress/s_u32_Size
//    避免：TaskA 设置了地址 → TaskB 抢占修改了地址 → TaskA 回来写错了位置
//
// ② 信号量 (ExtFlashSema)
//    通知 Storage Manager Task "有活要干"
//    调用者 give 信号量 → Storage Mgr take 并执行 → 执行完 give 回去
//    调用者 take 两次才返回（确保 Storage Mgr 确实执行完了）
//
// ③ 事件组 (userExtFlashEveGropHandle)
//    区分操作类型（OTA / LVGL / FlashDB / FATFS）
//    Storage Mgr 根据事件位决定调哪个处理函数

// 典型调用流程（以 OTA 写入为例）：
// 1. write_ota_data() 获取 mutex
// 2. 设置全局变量 target_addr, size, data_ptr
// 3. xEventGroupSetBits(EVENT_OTA)  ← 触发 Storage Mgr
// 4. osal_sema_give()  ← 通知 "数据就绪"
// 5. osal_sema_take() × 2  ← 等待 "写入完成"
// 6. 释放 mutex
```

## 5. SPI 性能优化

### 5.1 DMA vs 轮询 SPI

```c
// Bicycle_Watch 的 W25Q64 SPI 配置

// SPI2 参数：
//   速率：PCLK/2 ≈ 21 MHz（STM32F411 APB1 最高 42MHz）
//   模式：Mode 0 (CPOL=0, CPHA=0)
//   数据位：8-bit

// 写入性能估算：
//   SPI 时钟 21MHz → 2.6 MB/s 理论速率
//   每个字节 → 1 个命令字节 + 3 个地址字节 + 1 个数据字节 = 5 字节 SPI 传输
//   实际写入速率 ≈ 21MHz / 5 / 8 ≈ 525 KB/s
//
//   Sector 擦除时间 ≈ 45ms (W25Q64 典型值)
//   写入 4096 字节（含擦除）≈ 45ms + (4096/525KB/s) ≈ 45ms + 7.8ms ≈ 53ms
//
//   464KB 固件需要 ≈ 464/4 × 53ms ≈ 6.15s
//   加上 Ymodem 串口传输时间（115200bps → 约 40s）
//   总 OTA 时间 ≈ 40s + 6s + 15s(内部Flash编程) ≈ 61s

// 实际测试：
//   DMA 模式可以减少 CPU 占用（传输期间 CPU 可以做其他事）
//   但对 W25Q64 来说，DMA 传输完一个扇区只需要 7.8ms
//   擦除耗时 45ms 才是瓶颈 → DMA 优化的收益有限
```

### 5.2 写前擦除策略

```c
// W25Q64 的写入约束：
//   1. 只能把 bit 从 1 编程为 0（不能从 0 变回 1）
//   2. 要把 bit 从 0 变回 1 必须整扇区擦除（Erase Sector）
//   3. 擦除以 Sector(4KB) / Block(32KB/64KB) / Chip(全片) 为单位

// OTA 场景策略：
//   下载固件前 → 擦除整个 OTA 区域（1MB = 256 个 Sector）
//   每来一个扇区 → 直接写入（不需要再擦除）
//   优点：避免每扇区擦除的 45ms 延迟，保证写入带宽稳定

void w25q64_erase_ota_region(void)
{
    // 擦除 OTA 区域的所有扇区（Sector 0 ~ 255）
    for (uint32_t addr = 0; addr < 0x100000; addr += 4096) {
        w25q64_erase_sector(addr);  // 每个扇区约 45ms
    }
    // 总计擦除时间 ≈ 256 × 45ms ≈ 11.5s
    // 执行时机：收到 OTA 启动命令后，开始 Ymodem 传输前
}
```

## 6. LittleFS 集成

Bicycle_Watch 在 W25Q64 上运行 LittleFS 来管理 LVGL 区域的资源文件：

```c
// storage_manager_task 中的 LittleFS 初始化

// LittleFS 配置绑定到 W25Q64
lfs_t lfs;
lfs_file_t file;

// 挂载文件系统
int err = lfs_mount(&lfs, &lfs_w25q64_cfg);

// 如果挂载失败（首次使用或文件系统损坏），格式化
if (err) {
    lfs_format(&lfs, &lfs_w25q64_cfg);
    lfs_mount(&lfs, &lfs_w25q64_cfg);
}

// 典型用途：
//   1. 触摸校准数据的持久化：/calib/touch_calib.bin
//   2. 开机计数（掉电不丢失）：boot_count
//   3. LVGL UI 资源文件的存储和管理
//   4. 固件版本信息和升级日志

// LittleFS 与 OTA 区域是隔离的：
//   OTA 区域使用裸扇区写（不需要文件系统开销）
//   LittleFS 用于 LVGL 资源的管理型存储
//   两者通过不同的地址范围隔离（0x000000 vs 0x300000）
```

## 7. 常见问题与调试

| 问题 | 症状 | 原因 | 解法 |
|------|------|------|------|
| SPI 写入失败 | Flash 内容全 0xFF | 写使能未发送或 WP# 引脚拉低 | 检查 `w25q64_write_enable()` |
| 写入速度慢 | OTA 进度卡顿 | 每字节都在擦除 | 改为整区预擦除策略 |
| 跨区写入 | LVGL 图片损坏 | OTA 数据溢出到 LVGL 区 | 加强地址范围校验（越界即拒绝） |
| Flash 寿命耗尽 | 某扇区永久写入失败 | 频繁擦写同一扇区 | 使用磨损均衡（LittleFS 自带） |
| 任务死锁 | OTA 进度条卡在 50% | 互斥锁未释放 | 检查 `osal_mutex_give` 是否在所有的错误路径都有调用 |

## 下一步

下一篇将深入 **内部 Flash 编程与 HAL 库操作**：STM32F411 Flash Sector 结构、HAL_FLASH_Unlock/Erase/Program/Lock 操作序列、字对齐写入与尾部填充、以及如何从 W25Q64 将固件拷贝到内部 Flash。
