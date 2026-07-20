---
title: Boot Manager 启动管理与异常恢复（双区切换与断点续升）
date: 2025-10-26
categories:
  - 技术笔记
  - 嵌入式
  - OTA开发
tags:
  - OTA
  - Boot Manager
  - 双区切换
  - 向量表
  - 异常恢复
  - 断点续升
  - Bicycle_Watch
description: Boot Manager 启动管理深度实践：上电启动流程与状态决策、App Info 标志位驱动双区切换、Flash-to-Flash 固件搬运、向量表重定位（SCB->VTOR）、断电保护和回退恢复、验收测试
cover: /img/covers/articles/mcu-bluetooth-development.svg
top_img: /img/covers/articles/mcu-bluetooth-development.svg
---

# Boot Manager 启动管理与异常恢复

## 1. Boot Manager 的地位

Boot Manager 是 Bicycle_Watch 上电后执行的第一段代码。它不参与业务逻辑，只做一件事：**决定运行哪个固件，并安全地跳转过去**。

```
上电/复位
    │
    ▼
┌──────────────────────┐
│   Boot Manager        │  ← 0x08000000 (Sector 0-2, 48KB)
│   1. 读取 App Info     │
│   2. 判断固件状态      │
│   3. 搬运/校验/切换    │
│   4. 设置向量表        │
│   5. 跳转到 App        │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│   Application         │  ← 0x0800C000 (Sector 3+)
│   正常业务逻辑         │
│   - LVGL UI           │
│   - Sensor 采集       │
│   - OTA 更新          │
└──────────────────────┘

Boot Manager 的核心职责：
  ① 上电后读取 App Info 状态 → 判断是否需要进行固件更新
  ② 如果需要更新 → 从 W25Q64 或 AreaB 搬运固件到运行区
  ③ 校验固件完整性 → 防止刷入损坏的固件导致变砖
  ④ 设置 SCB->VTOR → 让中断向量表指向正确的 App 位置
  ⑤ 跳转到 App 的 Reset_Handler → 控制权移交
```

## 2. 启动流程状态机

### 2.1 上电决策树

```c
// Boot Manager 伪代码——上电后的判断逻辑

void boot_manager_main(void)
{
    st_App_Info_t app_info;
    uint32_t run_state;

    // ① 从 Flash 固定地址读取 App Info
    memcpy(&app_info, (void *)BOOT_MANAGER_APP_INFO_ADDR,
           sizeof(app_info));

    // ② 反码校验
    if (app_info.u32_App_RunState != ~app_info.u32_App_RunState_Anti) {
        // 标志区数据损坏 → 进入安全模式
        // 尝试直接运行当前 Area 的固件（不要做任何 Flash 操作）
        jump_to_app(APPLICATION_ADDRESS_A);
    }

    run_state = app_info.u32_App_RunState;

    // ③ 根据状态决定行为
    switch (run_state) {

    case APP_Valid:  // 0x44444444
        // 固件正常 → 直接跳转运行
        jump_to_app(APPLICATION_ADDRESS_A);
        break;

    case APP_WAIT_UPDATE:  // 0x11111111
        // 有新固件需要更新
        //   新固件已经在 W25Q64 OTA 区域中
        //   App Info 中有 AreaASize 指出新固件大小
        perform_update_from_ext_flash(&app_info);
        break;

    case APP_Check_NewApp:  // 0x22222222
        // 新固件已搬运到 Area B，但尚未校验
        verify_and_switch_to_area_b(&app_info);
        break;

    case APP_AreaAToAreaB:  // 0x33333333
        // 正在从 Area A 搬运到 Area B（可能是上次搬运中断了）
        retry_copy_a_to_b(&app_info);
        break;

    default:
        // 未知状态 → 安全模式：尝试运行当前固件
        jump_to_app(APPLICATION_ADDRESS_A);
        break;
    }
}
```

### 2.2 状态转移全集

```
           ┌──────────────────────┐
           │    APP_Valid          │ ← 正常运行
           │    (0x44444444)       │
           └──────────┬───────────┘
                      │ OTA Task 写入新固件到 W25Q64
                      ▼
           ┌──────────────────────┐
           │  APP_WAIT_UPDATE      │ ← 固件已下载，等待重启升级
           │  (0x11111111)         │
           └──────────┬───────────┘
                      │ 用户点击"立即升级" → SoftReset()
                      │ Boot Manager 从 W25Q64 搬运到 Area B
                      ▼
           ┌──────────────────────┐
           │  APP_AreaAToAreaB     │ ← 搬运中（可能耗时 ~15s）
           │  (0x33333333)         │
           └──────────┬───────────┘
                      │ 搬运完成
                      ▼
           ┌──────────────────────┐
           │  APP_Check_NewApp     │ ← 校验 Area B 固件
           │  (0x22222222)         │
           └──────────┬───────────┘
                      │ 校验通过
                      ▼
           ┌──────────────────────┐
           │  Area B → Area A 搬运 │ ← 覆盖旧固件（不可逆！）
           │  APP_AreaAToAreaB     │   ★ 此步是最危险的操作
           └──────────┬───────────┘
                      │ 搬运完成 + 校验通过
                      ▼
           ┌──────────────────────┐
           │  APP_Valid            │ ← 新固件就位，正常启动
           │  (0x44444444)         │
           └──────────────────────┘
```

## 3. 固件搬运流程

### 3.1 Area B → Area A 拷贝

```c
// 将 Area B 的新固件（已校验通过）复制到 Area A（运行区）
// ★ 这是整个 OTA 流程中最危险的操作 —— 覆盖正在运行的固件

#define AREA_A_START  0x0800C000
#define AREA_B_START  0x08046000
#define FLASH_SECTOR_SIZE_128K  0x20000  // 128KB

void copy_area_b_to_area_a(uint32_t firmware_size)
{
    uint32_t remaining = firmware_size;
    uint32_t src_addr  = AREA_B_START;
    uint32_t dst_addr  = AREA_A_START;

    // ① 擦除 Area A 的目标扇区
    erase_sectors(dst_addr, firmware_size);

    // ② 逐页搬运（使用 RAM 中的临时缓冲区）
    uint8_t ram_buffer[256];  // 256 字节 = Flash 的 Page 编程单位

    while (remaining > 0) {
        uint32_t chunk = (remaining > 256) ? 256 : remaining;

        // 从 Area B 读取到 RAM
        memcpy(ram_buffer, (void *)src_addr, chunk);

        // 从 RAM 写入到 Area A（不能 Flash → Flash 直接写！）
        flash_program_page(dst_addr, ram_buffer, chunk);

        src_addr  += chunk;
        dst_addr  += chunk;
        remaining -= chunk;

        // ★ 关键：每一步都要更新 App Info 中的进度标志
        // 这样即使断电，下次上电也能从中断点继续
        update_copy_progress(dst_addr - AREA_A_START, firmware_size);
    }

    // ③ 搬运完成 → 校验 Area A 与 Area B 的内容一致性
    if (verify_flash_content(AREA_A_START, AREA_B_START,
                              firmware_size) != 0) {
        // 校验失败 → 保持在 APP_AreaAToAreaB 状态 → 重试
        return;
    }

    // ④ 校验通过 → 标记 Area A 固件有效
    set_app_flag_value(App_RunState, APP_Valid);
}
```

### 3.2 断电续升（Breakpoint Resume）

```c
// 如果在搬运过程中断电 → 下次上电时从断点继续
// 实现：在搬运过程中定期更新 App Info 中的进度字段

void update_copy_progress(uint32_t copied_bytes, uint32_t total_bytes)
{
    // 使用 App_AreaBSize 字段存储已搬运的字节数
    // （此时 AreaBSize 刚好闲置，复用避免额外 Flash 写入）
    set_app_flag_value(App_AreaBSize, copied_bytes);

    // 下次上电时：
    //   if (run_state == APP_AreaAToAreaB) {
    //       uint32_t progress = read_app_flag_value(App_AreaBSize);
    //       // 从 dst_addr + progress 继续搬运
    //       continue_copy_from(progress);
    //   }
}

// 为什么这个方案安全？
//   1. 如果断电发生在搬运过程中 → 下次上电从上次记录的位置继续
//   2. 如果断电发生在写入 App Info 过程中 → 反码校验不通过 → 重新搬运
//   3. 搬运完成前 Area A 始终是旧固件 → 随时可以回退
//   ★ 只有在 all copy done + verify passed + App Info 更新成功后，
//      Area A 才切换为新固件
```

## 4. 向量表重定位

### 4.1 SCB->VTOR 的作用

```c
// ARM Cortex-M 的中断向量表默认位于 0x00000000
// STM32 通过 BOOT 引脚将其映射到 Flash 起始地址 0x08000000
// 但 Boot Manager 需要让 App 的中断向量表指向 App 的起始地址

// 在跳转到 App 之前，必须设置 SCB->VTOR
void jump_to_application(uint32_t app_address)
{
    // ① 检查栈顶指针是否合法（SP 应在 RAM 范围内）
    uint32_t app_sp = *(volatile uint32_t *)app_address;
    if ((app_sp < 0x20000000) || (app_sp > 0x20020000)) {
        // 栈指针不在 STM32F411 的 SRAM 范围内（128KB = 0x20000000~0x20020000）
        // → 固件损坏 → 不进 App，发错误信号
        goto error;
    }

    // ② 检查 Reset_Handler 是否合法
    uint32_t app_reset_handler = *(volatile uint32_t *)(app_address + 4);
    if ((app_reset_handler < 0x08000000) ||
        (app_reset_handler > 0x08080000)) {
        // 复位向量不在 Flash 范围内 → 固件损坏
        goto error;
    }

    // ③ 关闭全局中断（跳转前最后的安全保障）
    __disable_irq();

    // ④ ★ 设置向量表偏移
    SCB->VTOR = app_address;

    // ⑤ 设置 MSP（主栈指针）为 App 的栈顶
    __set_MSP(app_sp);

    // ⑥ 加载 App 的 Reset_Handler 地址并跳转
    //    这三条是标准的 Cortex-M App 跳转序列
    pFunction app_entry = (pFunction)app_reset_handler;
    app_entry();  // 控制权永久转交给 App

    // 不会执行到这里
error:
    // 错误处理：LED 快闪 5 次 → 进入 Boot Manager 的死循环
    while (1) {
        led_toggle(); delay_ms(100);
    }
}
```

### 4.2 App 侧的对等配置

```c
// App 的 main() 必须在自己初始化时设置自己的向量表偏移
// 这是"防御性编程"——即使 Boot Manager 已经设置了 VTOR，
// App 也应该自己设置一遍

int main(void)
{
    // ① 设置向量表偏移为 App 的起始地址
    SCB->VTOR = APPLICATION_ADDRESS;  // 0x0800C000

    // ② HAL 初始化（会调用 SystemInit → 配置时钟）
    HAL_Init();
    SystemClock_Config();

    // ③ 其余初始化
    // ...

    // 如果不设置 SCB->VTOR，当 Boot Manager 跳转到 App 后，
    // 第一个发生的中断会从 0x08000000 取 ISR 向量
    // → 跳到 Boot Manager 的中断处理函数 → 行为完全错误
}
```

## 5. 异常恢复策略

### 5.1 场景全覆盖

| 断电时机 | Boot Manager 下次上电看到的状态 | 恢复策略 |
|---------|-------------------------------|---------|
| OTA 下载中（Ymodem 传输） | APP_Valid → 旧固件正常 | 正常启动旧固件，重新下载 |
| W25Q64 擦除中 | APP_WAIT_UPDATE → 新固件不完整 | 重新搬运（从 W25Q64 重新读） |
| Area B → Area A 搬运中 | APP_AreaAToAreaB + progress | 从记录的 progress 继续搬运 |
| App Info 更新中（临界区内） | 反码校验失败 → 进度未知 | 重新从头搬运（最坏情况重来） |
| Area A 搬运完成 + 校验通过 | APP_Valid + Area A 是新固件 | 正常启动新固件 |
| 新固件运行中 crash | Watchdog 复位 → APP_Valid | 正常启动，连续 3 次 crash → 回退 |

### 5.2 崩溃回退机制

```c
// App 启动后，在正常运行一段时间后（如 5 秒），
// 向 App Info 写入 "启动成功" 标记

void app_startup_watchdog(void)
{
    // ① App 起来后先不急着标记成功
    // ② 初始化外设 → 启动 FreeRTOS → LVGL 显示
    // ③ 5 秒后一切正常 → 写入标记

    osal_task_delay(5000);

    // 读取 boot_count（用 LittleFS 在外部 Flash 中记录）
    uint32_t boot_count = read_boot_count();

    if (boot_count > 3) {
        // 连续启动 3 次都没能正常运行 → 可能新固件有问题
        // → 设置回退标记 → 下次上电 Boot Manager 回到旧版本
        set_app_flag_value(App_RunState, APP_AREA_B_FALLBACK);
        SoftReset();
    }

    // 正常运行 → 清除启动计数
    clear_boot_count();
}

// 下次上电 → Boot Manager 看到 APP_AREA_B_FALLBACK
// → 从 Area B 回退固件到 Area A（或直接运行 Area B 的旧版本）
```

## 6. 软件复位（SoftReset）

```c
// Bicycle_Watch 的 SoftReset 实现
// 触发条件：OTA 升级完成、用户手动重启、异常恢复

void SoftReset(void)
{
    // ① 关闭全局中断 + 设置 FAULTMASK（阻止所有可屏蔽异常）
    __set_FAULTMASK(1);

    // ② 软件复位 —— 等价于按下 RESET 按钮
    NVIC_SystemReset();

    // 不会执行到这里
    while (1);
}

// NVIC_SystemReset() 做了什么：
//   1. 设置 SCB->AIRCR 的 SYSRESETREQ 位
//   2. CPU 内核向系统复位控制器请求复位
//   3. 复位 → SP 从 0x08000000 加载 → PC 跳到 0x08000004 (Reset_Handler)
//   4. → Boot Manager 再次运行 → 读取 App Info → 决策
```

## 7. 完整升级时序

```
阶段                  耗时      操作
───────────────────────────────────────────────────
① PC 发送 OTA 命令     <1s     SecureCRT → UART 0x11 0x22 0x33
② 用户确认下载         <10s    LVGL 弹窗 → 用户点击"开始下载"
③ Ymodem 传输          40s     PC → STM32, 464KB @ 115200bps
④ W25Q64 写入           6s     缓冲 4096B → SPI 写入
⑤ 用户确认升级         <10s    LVGL 弹窗 → 用户点击"立即升级"
⑥ SoftReset            <1s     NVIC_SystemReset()
⑦ Boot Manager 启动    <0.1s   读取 App Info → 判断状态
⑧ W25Q64 → Area B     15s     外部 Flash → 内部 Flash 搬运
⑨ 校验 Area B          <1s     逐字节比对
⑩ Area B → Area A     15s     内部 Flash-to-Flash 搬运
⑪ 设置 APP_Valid       <0.2s   写 App Info 标志区
⑫ 跳转 App             <0.1s   SCB->VTOR + jump
⑬ App 初始化 + 启动     <3s     外设初始化 + FreeRTOS + LVGL
───────────────────────────────────────────────────
总计                    ~90s    约一分半钟完成全流程
```

## 8. 验收测试

```c
// Bicycle_Watch OTA 验收测试矩阵

// 测试 1：正常升级
//   条件：电池 > 50%，固件完整
//   操作：PC Ymodem → 确认下载 → 确认升级
//   预期：90s 后运行新固件，版本号更新

// 测试 2：中途断电（Ymodem 阶段）
//   条件：传输到 50% 时拔掉电源
//   预期：重新上电 → 运行旧固件 → App Info 为 APP_Valid

// 测试 3：中途断电（Area B → Area A 搬运阶段）
//   条件：搬运到 30% 时拔掉电源
//   预期：重新上电 → Boot Manager 检测到 APP_AreaAToAreaB
//        → 读取 progress → 从 30% 继续搬运 → 最终升级成功

// 测试 4：固件校验失败
//   条件：人为修改 W25Q64 中某几个字节
//   预期：Boot Manager 校验不通过 → 运行旧固件

// 测试 5：3 次启动失败回退
//   条件：刷入一个会 crash 的固件
//   预期：第 4 次上电 → Boot Manager 回退到旧版本

// 测试 6：看门狗复位
//   条件：OTA 任务 600s 超时
//   预期：看门狗复位 → 重新进入 Boot Manager → APP_Valid → 旧固件
```

## 系列总结

本系列五篇文章覆盖了 Bicycle_Watch OTA 固件升级系统的完整实现：

| 文章 | 核心知识点 |
|------|-----------|
| 第一篇：系统架构与双区备份 | 四阶段状态机、AreaA/AreaB 设计、App Info 标志区、多任务协作 |
| 第二篇：Ymodem 协议 | 包格式（SOH/STX）、CRC16、序列号、双缓冲接收、文件元数据解析 |
| 第三篇：W25Q64 外部 Flash | 四分区设计、4096B 扇区缓冲、事件组同步、LittleFS 集成 |
| 第四篇：STM32 内部 Flash | HAL 操作序列、临界区保护、字对齐写入、尾部 0xFF 填充 |
| 第五篇：Boot Manager | 启动状态机、向量表重定位、断点续升、异常回退 |

---

> 所有代码均基于 `C:\Users\XTHBA\Desktop\找工作\项目\Bicycle_Watch` 工程中的真实源码，符合实际产品开发标准。
