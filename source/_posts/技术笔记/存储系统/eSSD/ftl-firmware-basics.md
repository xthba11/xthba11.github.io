---
title: FTL 固件学习笔记：L2P 映射、GC 与写放大
date: 2026-05-04
categories:
  - 技术笔记
  - 存储系统
  - eSSD
  - FTL
tags:
  - FTL
  - eSSD
  - SSD固件
  - 垃圾回收
  - C语言
description: FTL 核心机制学习：逻辑地址到物理地址映射、无效页、垃圾回收、磨损均衡和写放大。
top_img: /img/embedded-lab-hero.png
---

FTL，全称 Flash Translation Layer，是 SSD 固件中最核心的模块之一。Host 看到的是连续 LBA，而 NAND Flash 只能按 page 写、按 block 擦，不能像磁盘一样原地覆盖。

FTL 的任务就是把 Host 的逻辑读写转换为 NAND 的物理操作。

## 基本概念

```text
LBA: Logical Block Address，Host 看到的逻辑地址
PPA: Physical Page Address，NAND 上的物理页地址
L2P: Logical to Physical，逻辑到物理映射
P2L: Physical to Logical，物理到逻辑反向映射
```

一个简单的物理地址可以这样表示：

```c
typedef struct {
    uint16_t ch;    // 通道号 (channel)
    uint16_t lun;   // 逻辑单元号 (Logical Unit Number)
    uint16_t block; // 块号 (block index)
    uint16_t page;  // 页号 (page index within block)
} ppa_t;
```

## L2P 映射表

最直观的 FTL 是 page-level mapping：每个 LBA 对应一个物理 page。

```c
#define INVALID_BLOCK 0xffff  // 无效块标记，L2P 项未映射时使用
#define INVALID_PAGE  0xffff  // 无效页标记，L2P 项未映射时使用

typedef struct {
    uint16_t ch;    // 通道号 (channel)
    uint16_t lun;   // 逻辑单元号 (LUN)
    uint16_t block; // 块号 (block index)
    uint16_t page;  // 页号 (page index)
} ppa_t;

typedef struct {
    ppa_t *table;       // 指向 L2P 映射表数组的指针
    uint32_t lba_count; // LBA 总数，即映射表条目数
} l2p_table_t;
```

初始化时，所有 LBA 都指向无效地址：

```c
void L2P_Init(l2p_table_t *l2p, ppa_t *buf, uint32_t count)
{
    // 将预分配的缓冲区绑定到 L2P 表结构
    l2p->table = buf;
    l2p->lba_count = count;

    // 遍历所有 LBA 条目，初始化为无效地址
    // 表示该 LBA 从未被写入过，FTL_Read 会据此返回错误
    for (uint32_t i = 0; i < count; i++) {
        l2p->table[i].block = INVALID_BLOCK; // 块号设为无效标记
        l2p->table[i].page = INVALID_PAGE;   // 页号设为无效标记
    }
}
```

## 写入流程

NAND 不能原地覆盖。更新一个 LBA 时，通常流程如下：

1. 分配新的空闲 page
2. 把数据写入新 page
3. 更新 L2P 表
4. 把旧 page 标记为 invalid

```c
int FTL_Write(uint64_t lba, const void *data)
{
    // 1. 查 L2P 表，获取该 LBA 的旧物理位置
    ppa_t old_ppa = g_l2p.table[lba];
    // 2. 从空闲页池分配一个新的物理页（log-structured 写入）
    ppa_t new_ppa = Alloc_FreePage();

    // 3. 将数据编程到 NAND 新页中
    if (NAND_Program(new_ppa, data) != 0)
        return -1;

    // 4. 更新 L2P 映射表，指向新物理页
    g_l2p.table[lba] = new_ppa;

    // 5. 如果旧页之前有有效数据（非首次写入），标记为无效
    //    等待 GC 回收
    if (old_ppa.block != INVALID_BLOCK)
        Mark_Invalid(old_ppa);

    return 0;
}
```

这就是 log-structured 写入思想：新数据往新位置写，旧位置等待 GC 回收。

## 读取流程

读取时只需要查 L2P，然后读 NAND：

```c
int FTL_Read(uint64_t lba, void *data)
{
    // 1. 查 L2P 映射表，获取 LBA 对应的物理页地址
    ppa_t ppa = g_l2p.table[lba];

    // 2. 如果该 LBA 从未被写入，返回错误
    if (ppa.block == INVALID_BLOCK)
        return -1;

    // 3. 从 NAND 物理页读取数据（真实固件还需 ECC 校验）
    return NAND_Read(ppa, data);
}
```

真实固件还要处理 ECC 纠错、read retry、read disturb、数据校验等。

## Block 状态管理

FTL 需要知道每个 block 有多少 valid page、invalid page、free page，以及擦除次数。

```c
typedef enum {
    BLK_FREE,    // 空闲块：已擦除，可分配用于写入
    BLK_OPEN,    // 开放块：当前正在写入的块，还有空闲页
    BLK_CLOSED,  // 关闭块：已写满，不可再分配新页
    BLK_GC,      // GC 候选块：已被选为垃圾回收目标
    BLK_BAD,     // 坏块：出厂坏块或运行时坏块，不可使用
} block_state_t;

typedef struct {
    block_state_t state;     // 块当前状态
    uint16_t valid_pages;    // 有效页数：含有有效数据的 page 数量
    uint16_t invalid_pages;  // 无效页数：数据已过期的 page 数量
    uint16_t free_pages;     // 空闲页数：可编程的空白 page 数量
    uint32_t erase_count;    // 擦除次数：用于磨损均衡决策
} block_info_t;
```

这些信息是 GC 和 Wear Leveling 的基础。

## 垃圾回收

当空闲 block 不够时，需要回收旧 block。

GC 基本流程：

1. 选择 victim block
2. 搬移其中仍然有效的 page
3. 更新 L2P
4. 擦除 victim block
5. 放回 free block 池

```c
static int Select_VictimBlock(void)
{
    // 贪心策略：选择无效页最多的块作为 GC 受害者
    int victim = -1;
    uint16_t max_invalid = 0;   // 记录当前最大无效页数

    for (int i = 0; i < BLOCK_COUNT; i++) {
        // 只考虑已关闭的块（BLK_OPEN 和 BLK_FREE 不参与 GC）
        if (g_block[i].state != BLK_CLOSED)
            continue;

        // 选无效页最多的块，搬移成本最低（有效页最少）
        if (g_block[i].invalid_pages > max_invalid) {
            max_invalid = g_block[i].invalid_pages;
            victim = i;
        }
    }

    return victim;  // 返回 victim block 索引，-1 表示无可用 victim
}
```

选择 invalid page 多的 block，可以降低搬移成本。

## 写放大

Host 写入 4KB，不代表 NAND 只写 4KB。GC 搬移有效数据、元数据更新、日志写入都会产生额外写入。

```text
写放大 WA = NAND 实际写入量 / Host 写入量
```

降低写放大的方法：

- 提高顺序写比例
- 减少热数据和冷数据混放
- 优化 GC victim 选择
- 合理预留 OP 空间
- 合并小写

## Wear Leveling

NAND block 有擦写寿命。如果总是使用同一批 block，它们会提前磨损。

Wear Leveling 分两类：

- Dynamic Wear Leveling：新写入尽量分布到擦写次数低的 block
- Static Wear Leveling：长期不动的冷数据也需要偶尔搬移

```c
static int Select_FreeBlock_ByEraseCount(void)
{
    // Dynamic Wear Leveling：从空闲块中选择擦除次数最少的块
    int best = -1;
    uint32_t min_ec = UINT32_MAX;   // 记录最小擦除次数

    for (int i = 0; i < BLOCK_COUNT; i++) {
        // 只在空闲块中筛选，选择擦除次数最低的块
        // 这样可以避免热数据集中在少数 block 上反复擦写
        if (g_block[i].state == BLK_FREE && g_block[i].erase_count < min_ec) {
            min_ec = g_block[i].erase_count;
            best = i;
        }
    }

    return best;  // 返回最佳空闲块索引，-1 表示无可用空闲块
}
```

## 元数据持久化

L2P 表在 RAM 中访问最快，但掉电会丢失。因此需要持久化策略。

常见方式：

- 全量 checkpoint
- 增量 journal
- P2L 扫描恢复
- super block 保存版本号和入口

```c
typedef struct {
    uint32_t magic;   // 魔数：校验日志条目是否合法
    uint32_t version; // 版本号：单调递增，用于掉电恢复时判断最新状态
    uint64_t lba;     // 逻辑块地址：本条日志对应的 LBA
    ppa_t ppa;        // 物理页地址：该 LBA 的新映射位置
    uint32_t crc;     // CRC 校验：保证日志条目完整性
} l2p_log_t;
```

## 小结

FTL 的主线可以概括为：

- L2P 解决地址转换
- 无效页记录解决更新问题
- GC 解决空间回收
- Wear Leveling 解决寿命均衡
- 元数据日志解决掉电恢复

学 FTL 时不要急着追复杂算法，先把“写新页、旧页失效、GC 回收、映射持久化”这个闭环跑通，后面的优化才有抓手。
