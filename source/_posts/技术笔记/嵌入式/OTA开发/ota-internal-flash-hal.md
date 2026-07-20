---
title: STM32 内部 Flash 编程与 HAL 库操作（OTA 固件写入）
date: 2026-07-20
categories:
  - 技术笔记
  - 嵌入式
  - OTA开发
tags:
  - OTA
  - STM32
  - HAL_FLASH
  - 内部Flash
  - Sector擦写
  - Bicycle_Watch
description: STM32F411 内部 Flash 编程实战：Flash Sector 结构、HAL_FLASH_Unlock/Erase/Program/Lock 操作序列、字对齐写入与尾部填充、App Info 标志区编程、临界区保护、从 W25Q64 到内部 Flash 的固件搬运流程
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# STM32 内部 Flash 编程与 HAL 库操作

## 1. STM32F411 Flash 结构

### 1.1 Sector 布局

```c
// STM32F411CE (512KB Flash) Sector 布局

/*
┌──────────────┬──────────┬───────────┬──────────────────────┐
│   Sector     │ Address  │  Size     │  Bicycle_Watch 用途   │
├──────────────┼──────────┼───────────┼──────────────────────┤
│ Sector 0     │ 08000000 │   16 KB   │ Boot Manager         │
│ Sector 1     │ 08004000 │   16 KB   │ Boot Manager         │
│ Sector 2     │ 08008000 │   16 KB   │ App Info 标志区       │
│ Sector 3     │ 0800C000 │   16 KB   │ Application (Area A) │
│ Sector 4     │ 08010000 │   64 KB   │ Application (Area A) │
│ Sector 5     │ 08020000 │  128 KB   │ Application (Area A) │
│ Sector 6     │ 08040000 │  128 KB   │ Application (Area B) │
│ Sector 7     │ 08060000 │  128 KB   │ Application (Area B) │
└──────────────┴──────────┴───────────┴──────────────────────┘

Total: 512 KB = 16+16+16+16+64+128+128+128 = 512 KB
Application Area A: Sector 3-5 (16+64+128 = 208KB) + 部分 Sector 2
Application Area B: Sector 6-7 (128+128 = 256KB)
*/

// 地址 → Sector 查询函数
static uint32_t ota_GetFlashSector(uint32_t address)
{
    if      (address < 0x08004000UL) return FLASH_SECTOR_0;  // 16KB
    else if (address < 0x08008000UL) return FLASH_SECTOR_1;  // 16KB
    else if (address < 0x0800C000UL) return FLASH_SECTOR_2;  // 16KB
    else if (address < 0x08010000UL) return FLASH_SECTOR_3;  // 16KB
    else if (address < 0x08020000UL) return FLASH_SECTOR_4;  // 64KB
    else if (address < 0x08040000UL) return FLASH_SECTOR_5;  // 128KB
    else if (address < 0x08060000UL) return FLASH_SECTOR_6;  // 128KB
    else                                return FLASH_SECTOR_7;  // 128KB
}
```

### 1.2 Flash 编程约束

| 约束项 | 规则 | 违反后果 |
|--------|------|---------|
| 擦除单位 | 必须整 Sector 擦除 | 无法单字节擦除 |
| 编程单位 | Word(32bit)、Half-Word(16bit)、Byte(8bit) | Word 模式最常用 |
| 写入前状态 | bit 必须为 1（擦除后状态） | 否则写入失败（PGERR） |
| 电压范围 | 2.7V ~ 3.6V（FLASH_VOLTAGE_RANGE_3） | 电压不对 → 擦写异常 |
| 并行操作 | 写 Flash 时不能从 Flash 取指令 | 需在 RAM 中执行或关中断等待 |
| 寿命 | 约 1 万次擦除/Sector | 超出后写入可能失败 |

## 2. HAL Flash 操作序列

### 2.1 标准四步法

```c
// HAL Flash 编程的完整流程

// ① Unlock（解锁 Flash 控制寄存器）
HAL_FLASH_Unlock();  // 写入 KEY1, KEY2 到 FLASH_KEYR

// ② Erase（擦除目标扇区）
FLASH_EraseInitTypeDef eraseInit = {0};
eraseInit.TypeErase    = FLASH_TYPEERASE_SECTORS;   // 扇区擦除
eraseInit.VoltageRange = FLASH_VOLTAGE_RANGE_3;     // 2.7V~3.6V
eraseInit.Sector       = FLASH_SECTOR_4;            // 起始扇区
eraseInit.NbSectors    = 2;                         // 擦除 2 个扇区

uint32_t sectorError = 0;
HAL_FLASHEx_Erase(&eraseInit, &sectorError);        // 阻塞执行

// ③ Program（逐 Word 写入）
for (uint32_t addr = start_addr; addr < end_addr; addr += 4) {
    uint32_t word = *(uint32_t *)(src_data);
    HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, addr, (uint64_t)word);
    src_data += 4;
}

// ④ Lock（锁定 Flash 控制寄存器）
HAL_FLASH_Lock();
```

### 2.2 Bicycle_Watch 的完整实现

```c
// service_ota_manager.c — ota_Flash_EraseWrite_HAL
// 一次性完成擦除 + 写入的原子操作

static uint8_t ota_Flash_EraseWrite_HAL(
    uint32_t start_addr,       // 目标地址
    const uint8_t *data,       // 源数据
    uint32_t size)             // 数据大小
{
    if (data == NULL || size == 0) return 1;

    // ① 计算需要擦除的扇区范围
    uint32_t end_addr = start_addr + size - 1U;
    uint32_t start_sector = ota_GetFlashSector(start_addr);
    uint32_t end_sector   = ota_GetFlashSector(end_addr);
    uint32_t nb_sectors   = (end_sector - start_sector) + 1U;

    FLASH_EraseInitTypeDef eraseInit = {0};
    uint32_t sectorError = 0;

    eraseInit.TypeErase    = FLASH_TYPEERASE_SECTORS;
    eraseInit.VoltageRange = FLASH_VOLTAGE_RANGE_3;
    eraseInit.Sector       = start_sector;
    eraseInit.NbSectors    = nb_sectors;

    // ② Unlock → Erase → Program → Lock
    if (HAL_FLASH_Unlock() != HAL_OK) {
        return 1;
    }

    // ③ 擦除目标扇区
    if (HAL_FLASHEx_Erase(&eraseInit, &sectorError) != HAL_OK) {
        HAL_FLASH_Lock();
        return 1;
    }

    // ④ Word 写入（32-bit 对齐）
    uint32_t addr = start_addr;
    uint32_t i = 0;

    // 主体部分 —— 每 4 字节写入一个 Word
    for (; i + 4U <= size; i += 4U) {
        // 从源数据指针读取一个 32-bit Word（注意字节序）
        uint32_t word = *(const uint32_t *)(data + i);

        if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD,
                              addr, (uint64_t)word) != HAL_OK) {
            HAL_FLASH_Lock();
            return 1;
        }
        addr += 4U;
    }

    // ⑤ 尾部处理 —— 不足 4 字节的剩余数据用 0xFF 填充
    if (i < size) {
        uint32_t last = 0xFFFFFFFFUL;    // Flash 擦除后默认值
        uint32_t rem = size - i;
        memcpy(&last, data + i, rem);    // 只覆盖低 rem 字节

        if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD,
                              addr, (uint64_t)last) != HAL_OK) {
            HAL_FLASH_Lock();
            return 1;
        }
    }

    // ⑥ Lock
    HAL_FLASH_Lock();
    return 0;
}

// 注意：尾部填充 0xFF 的精妙之处
// Flash 擦除后每个 bit 都是 1（即 0xFFFFFFFF）
// 如果要写入的数据不足 4 字节，把剩余部分填 0xFF 就不会改变其原有值
// 这避免了"不需要改写的位置被错误清 0"的问题
```

## 3. 关键设计点

### 3.1 临界区保护

```c
// 写入 App Info 时，必须进入临界区 —— 防止写入过程中被中断打断
// 如果 ISR 在 Flash 编程期间触发 → CPU 尝试从 Flash 取 ISR 向量 → Crash!

void set_app_flag_value(en_App_FlagType_t AppFlagType,
                         uint32_t AppFlagValue)
{
    // 先更新 RAM 中的结构体
    AppInfo.u32_App_RunState = AppFlagValue;
    AppInfo.u32_App_RunState_Anti = ~AppFlagValue;

    // ★ 进入临界区 —— 屏蔽所有中断
    osal_enter_critical();

    // 执行 Flash 擦写（耗时约 50-200ms）
    // 这期间不能响应任何中断——对此 OTA 场景，用户本来就
    // 在等待升级完成，短暂的无响应是可接受的
    ota_Flash_EraseWrite_HAL(
        AppFlagAddress,  // 0x08008000
        (const uint8_t *)&AppInfo,
        sizeof(st_App_Info_t));

    // ★ 退出临界区
    osal_exit_critical();
}
```

### 3.2 电压范围选择

```c
// STM32F4 的 Flash 编程电压范围与主频的关系：

FLASH_VOLTAGE_RANGE_1  // 1.8V~2.1V → HCLK ≤ 120 MHz
FLASH_VOLTAGE_RANGE_2  // 2.1V~2.4V → HCLK ≤ 112 MHz
FLASH_VOLTAGE_RANGE_3  // 2.4V~2.7V → HCLK ≤ 100 MHz
FLASH_VOLTAGE_RANGE_4  // 2.7V~3.6V → HCLK ≤ 84 MHz

// Bicycle_Watch 使用 RANGE_3 (2.7V~3.6V)
// 电池供电设备，电压从 4.2V 降到 3.3V → 全范围覆盖
// HCLK = 100MHz → 配合 RANGE_3 完全没问题
```

### 3.3 擦除前确认

```c
// 在擦除前确认目标扇区内容为空（全 0xFF）
// 如果已经是空白的，跳过擦除——节省时间 + 延长 Flash 寿命

static bool is_sector_erased(uint32_t start_addr, uint32_t size)
{
    for (uint32_t i = 0; i < size; i += 4) {
        if (*(volatile uint32_t *)(start_addr + i) != 0xFFFFFFFF) {
            return false;  // 至少有一个 Word 不是 0xFF
        }
    }
    return true;
}

// 可选优化：
// if (is_sector_erased(start_addr, sector_size)) {
//     goto program;  // 跳过擦除，直接写入
// }
```

## 4. App Info 标志区的特殊处理

### 4.1 为什么 App Info 需要独立管理

```c
// App Info 结构体位于 0x08008000（Sector 2）
// 它需要在固件升级过程中被频繁写入（更新状态标志）
// 但 Sector 2 只有 16KB → 频繁擦除会消耗 Flash 寿命

// Bicycle_Watch 的策略：
//   App Info 写入时擦除整个 Sector 2（16KB）
//   ota_Flash_EraseWrite_HAL 每次调用都会擦除 → 再写入
//   对于 App Info 这种小数据（32 字节），整扇区擦除是浪费

// 改进方案（为 BLE OTA 预留）：
//   使用 Flash 模拟 EEPROM 技术
//   在 16KB 扇区中顺序写入 + 标记有效/失效
//   只有整扇区写满时才擦除 → 寿命提升 512 倍
//   但当前有线 OTA 场景的写入次数很少（每次升级 2-3 次），
//   暂不需要这种优化
```

### 4.2 反码校验的由来

```c
// Flash bit-flip 是真实存在的问题：
//   高温、低电压、辐射环境 → Flash 存储的 bit 可能从 0 翻转为 1
//   单 bit 翻转的概率虽然低（约 10^-12），但对于安全关键的标志位不可接受

// 反码方案：
//   每个有效值存储两次：原值 + 反码
//   读取时校验：if (value == ~anti_value) → 可信
//   如果发生 bit-flip → 原值和反码不满足取反关系 → 检测到错误

// 示例：
//   写入 APP_Valid (0x44444444)
//   → App_RunState      = 0x44444444
//   → App_RunState_Anti = 0xBBBBBBBB  (= ~0x44444444)

//   如果 0x44444444 的 bit 3 翻转为 0 → 变成 0x4444444C
//   但 0xBBBBBBBB 没变 → 0x4444444C != ~0xBBBBBBBB
//   → 校验失败 → 进入安全模式
```

## 5. 从 W25Q64 到内部 Flash 的搬运

OTA 下载到 W25Q64 后，需要将固件从外部 Flash 搬运到内部 Flash：

```c
// 搬运流程（在 Boot Manager 中执行）：

void copy_firmware_from_ext_to_internal(void)
{
    uint32_t internal_addr = ApplicationAddress;  // 0x0800C000
    uint32_t external_addr = MEMORY_OTA_START_ADDRESS;  // 0x000000
    uint32_t firmware_size = read_app_flag_value(App_AreaASize);
    uint8_t  buffer[4096];  // 临时缓冲区

    // ① 擦除目标区域（内部 Flash Sector 4-7）
    ota_Flash_EraseWrite_EraseOnly(internal_addr,
                                    internal_addr + firmware_size);

    // ② 逐扇区搬运（4KB 为一批）
    for (uint32_t offset = 0; offset < firmware_size; offset += 4096) {
        // 从 W25Q64 读一批
        externflash_read(external_addr + offset, 4096, buffer);

        // 写入内部 Flash
        ota_Flash_EraseWrite_ProgramOnly(
            internal_addr + offset, buffer,
            (firmware_size - offset) < 4096
                ? (firmware_size - offset) : 4096);

        // 更新 LVGL 进度
        lvgl_ota_download_percentage_write(
            offset * 100 / firmware_size);
    }

    // ③ 标记 Area B 固件有效
    set_app_flag_value(App_AreaBState, APP_AreaBState_Valid);

    // ④ 跳转到新固件
    jump_to_application(ApplicationAddress + 0x20000);  // Area B
}
```

## 6. Flash 编程中的常见坑

| 问题 | 症状 | 根因 | 解法 |
|------|------|------|------|
| PGERR (Programming Sequence Error) | `HAL_FLASH_Program` 返回 HAL_ERROR | 没有先擦除就写入（bit 不为 1） | 确保 Erase → Program 的顺序 |
| WRPERR (Write Protection Error) | 擦除失败 | 目标扇区被写保护（OPTCR 寄存器） | 检查 FLASH_OPTCR 的 nWRP 位 |
| HardFault | 写 Flash 时程序崩溃 | 写 Flash 期间发生了中断，ISR 也在 Flash 中 | 使用 `osal_enter_critical()` 关中断 |
| 数据丢失 | 尾部几个字节变成 0xFF | 大小不是 4 的倍数，尾部没写入 | 尾部用 0xFFFFFFFF 填充补齐 4 字节 |
| 地址未对齐 | `HAL_FLASH_Program` 失败 | Word 编程要求地址 4 字节对齐 | 确保 `addr % 4 == 0` |
| Flash Lock 未释放 | 下次开机 Flash 无法操作 | 异常路径没有调用 `HAL_FLASH_Lock()` | 所有的 return 分支都加 Lock |

## 7. 调试 Flash 编程

```c
// 技巧 1：编程后回读校验
for (uint32_t i = 0; i < size; i++) {
    if (*(volatile uint8_t *)(start_addr + i) != data[i]) {
        printk("Flash verify FAIL at offset %lu: wrote 0x%02X, read 0x%02X\n",
               i, data[i], *(volatile uint8_t *)(start_addr + i));
        return -1;
    }
}

// 技巧 2：检查 Flash 状态寄存器
if (FLASH->SR & FLASH_SR_PGERR) {
    printk("Programming sequence error!\n");
    FLASH->SR |= FLASH_SR_PGERR;  // 清除错误标志
}

// 技巧 3：使用 ST-Link Utility 查看 Flash 内容
// 烧录后 → ST-Link → Target → MCU Core → 0x08008000
// 比对 App Info 结构体的十六进制值是否正确
```

## 下一步

最后一篇将实现 **Boot Manager 启动管理**：上电后的启动流程、从 App Info 读取状态、校验新固件完整性、Flash-to-Flash 搬运、向量表重定位、以及异常恢复（断电续升、安全回退）。
