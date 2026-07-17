---
title: NAND Flash 学习笔记：Page、Block、坏块与 ECC
date: 2026-05-05
categories:
  - 技术笔记
  - 存储系统
  - NAND Flash
tags:
  - NAND Flash
  - eSSD
  - ECC
  - 坏块管理
  - C语言
description: NAND Flash 基础：page/block 结构、读写擦约束、坏块管理、ECC、OOB 和常见可靠性问题。
cover: /img/covers/articles/nand-flash-basics.svg
top_img: /img/covers/articles/nand-flash-basics.svg
---

理解 eSSD 固件必须先理解 NAND Flash。NAND 的行为和普通 RAM、NOR Flash 都不一样，它有严格的编程和擦除约束，也有坏块、位翻转、读干扰等可靠性问题。

## 基本结构

```text
Die
 └── Plane
      └── Block
           └── Page
                ├── Data Area
                └── Spare/OOB Area
```

常见粒度：

- Page：读写基本单位，例如 4KB、8KB、16KB
- Block：擦除基本单位，例如 128、256、512 个 page
- OOB/Spare：保存 ECC、坏块标记、逻辑页号、元数据

## 三个基本操作

### Read Page

读操作以 page 为单位。

```c
// NAND 页读操作：从指定 block/page 读出数据和 OOB 区域
// 返回值：0 成功；非 0 表示读失败，需检查 NAND 状态寄存器
int NAND_ReadPage(uint32_t block, uint32_t page, void *data, void *oob);
```

读出后通常需要做 ECC 校验和纠错。

### Program Page

写操作也是以 page 为单位，但不能随意覆盖已经写过的位置。

```c
// NAND 页编程操作：将数据和 OOB 写入指定 block/page
// 约束：page 需从低到高顺序编程，不能覆盖已编程的 page
// 返回值：0 成功；非 0 表示编程失败（可能产生运行时坏块）
int NAND_ProgramPage(uint32_t block, uint32_t page,
                     const void *data, const void *oob);
```

通常要求 page 从低到高顺序编程。不同 NAND 颗粒规则可能不同，固件要按 datasheet 约束实现。

### Erase Block

擦除以 block 为单位。

```c
// NAND 块擦除操作：将 block 中所有 page 恢复为全 1 状态
// 擦除后该 block 的所有 page 可重新编程
// 返回值：0 成功；非 0 表示擦除失败（需标记为运行时坏块）
int NAND_EraseBlock(uint32_t block);
```

擦除后，block 中所有 bit 恢复为 `1`。写入本质上是把部分 bit 从 `1` 编程为 `0`。

## 为什么不能原地覆盖

如果一个 page 已经写过，再写同一个 page 可能失败或引入数据可靠性问题。要更新数据，SSD 通常写到新的 page，然后让旧 page 失效。

这就是 FTL 存在的根本原因。

## OOB 区域

OOB 可以保存：

- ECC 校验信息
- 坏块标记
- LBA 或逻辑页号
- 写入序列号
- 元数据版本

```c
typedef struct {
    uint32_t magic;   // 魔数：标识 OOB 数据格式的合法性
    uint64_t lba;     // 逻辑块地址：掉电恢复时用于 P2L 扫描重建映射表
    uint32_t seq;     // 写入序列号：确定同一 LBA 多次写入的顺序
    uint16_t valid;   // 有效标记：0=无效（旧版本），1=有效（最新数据）
    uint16_t crc;     // CRC 校验：保证 OOB 信息的完整性
} nand_oob_t;
```

OOB 信息在掉电恢复和扫描重建映射表时很有用。

## 坏块管理

NAND 有两类坏块：

- 出厂坏块：芯片出厂时就存在
- 运行时坏块：使用过程中擦写失败、编程失败、读错误过多产生

坏块表可以这样抽象：

```c
typedef enum {
    BLOCK_GOOD = 0,       // 正常块：可以正常使用
    BLOCK_FACTORY_BAD,    // 出厂坏块：芯片出厂时标记，通常 OOB 首字节非 0xFF
    BLOCK_RUNTIME_BAD,    // 运行时坏块：使用过程中因编程/擦除失败产生的坏块
} block_health_t;

static block_health_t g_bad_block_table[BLOCK_COUNT];  // 全局坏块表

int Is_BadBlock(uint32_t block)
{
    // 检查指定 block 是否可用：非 BLOCK_GOOD 即为坏块
    return g_bad_block_table[block] != BLOCK_GOOD;
}
```

坏块不能继续分配给 FTL 使用。

## ECC

NAND 存储会发生 bit flip。ECC 用于检测和纠正错误。

读 page 后通常会得到几种结果：

- 无错误
- 有错误但可纠正
- 错误过多，不可纠正

```c
typedef enum {
    ECC_OK,             // ECC 校验通过：数据无错误
    ECC_CORRECTED,      // ECC 纠正成功：检测到 bit 翻转但已纠正
                        // 需统计纠正位数，若持续升高则考虑 read reclaim
    ECC_UNCORRECTABLE,  // ECC 不可纠正：数据已损坏，无法恢复
                        // 上层需返回错误给 Host 或尝试 RAID 恢复
} ecc_status_t;
```

如果某个 block 频繁出现接近纠错极限的错误，固件可能触发 read reclaim，把数据搬到新 block。

## Read Disturb

反复读取同一个 block 的 page，可能影响相邻 page 的电荷状态，导致 bit flip 增多。

常见处理：

- 记录 block read count
- 超过阈值后触发搬移
- 后台 scrub 扫描冷数据

```c
void NAND_OnRead(uint32_t block)
{
    // 每次读取后递增该 block 的读计数
    g_block_info[block].read_count++;

    // 读干扰处理：当读次数超过阈值时，触发 read reclaim
    // 将该 block 中的有效数据搬移到新 block，防止 bit flip 累积
    if (g_block_info[block].read_count > READ_RECLAIM_THRESHOLD)
        Schedule_ReadReclaim(block);
}
```

## Program/Erase Fail

NAND 操作完成后要读状态寄存器判断是否成功。

```c
int NAND_CheckStatus(void)
{
    // 读 NAND 状态寄存器，判断上一个操作是否成功
    uint8_t status = NAND_ReadStatus();

    // 检查 FAIL 位：如果置位，表示编程或擦除操作失败
    if (status & NAND_STATUS_FAIL)
        return -1;  // 操作失败，上层需标记坏块并迁移数据

    return 0;       // 操作成功
}
```

一旦擦除或编程失败，通常要把 block 标记为 runtime bad，并迁移有效数据。

## NAND 请求结构

固件中常把 NAND 操作封装成统一请求：

```c
typedef enum {
    NAND_REQ_READ,     // NAND 读请求
    NAND_REQ_PROGRAM,  // NAND 编程请求
    NAND_REQ_ERASE,    // NAND 擦除请求
} nand_req_type_t;

typedef struct {
    nand_req_type_t type;  // 操作类型（读/编程/擦除）
    uint16_t ch;           // 目标通道号 (channel)
    uint16_t lun;          // 目标逻辑单元号 (LUN)
    uint16_t block;        // 目标块号 (block index)
    uint16_t page;         // 目标页号（擦除操作时忽略此字段）
    void *data;            // 数据缓冲区（读：存放读出数据；写：源数据）
    void *oob;             // OOB 缓冲区（存放或提供 OOB 信息）
    int status;            // 操作结果：0 成功，非 0 失败
} nand_req_t;
```

这样上层 FTL 不需要关心底层命令细节。

## 常见调试点

- Page 编程顺序是否违反 NAND 约束
- OOB 中的逻辑页号和映射表是否一致
- ECC corrected bit 是否持续升高
- GC 搬移后旧 page 是否正确标 invalid
- 运行时坏块是否从 free block 池移除
- 掉电恢复时是否误用了未完成写入的 page

## 小结

NAND Flash 的核心特点是：读写快但约束多，必须用固件管理可靠性和寿命。

学习 eSSD 时，先把 NAND 的 page、block、erase-before-write、bad block、ECC 这些基础概念吃透，再看 FTL 和 Host 协议会顺很多。
