---
title: FreeRTOS 任务设计：优先级、队列与事件组怎么选
date: 2026-04-30
categories:
  - 技术笔记
  - 嵌入式
  - RTOS
tags:
  - FreeRTOS
  - RTOS
  - 任务调度
  - 队列
  - 事件组
description: FreeRTOS 工程中的任务划分、优先级设计、队列、事件组、任务通知和常见调试方法。
top_img: /img/embedded-lab-hero.png
---

FreeRTOS 的难点不在于创建任务，而在于任务怎么拆、优先级怎么定、任务之间怎么通信。

任务拆得太粗，实时性和可维护性都差；拆得太细，又会带来上下文切换、栈占用和同步复杂度。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS / STM32CubeIDE 开发环境。
- 目标板/芯片：STM32F411 系列，现有智能手表固件和 RidePulse 自行车码表改造项目。
- 内核/SDK/编译器版本：FreeRTOS CMSIS-RTOS 封装或原生 FreeRTOS API，STM32 HAL，Arm GCC。
- 使用工具：J-Link/ST-Link、串口日志、逻辑分析仪、FreeRTOS 运行时统计、任务栈高水位接口。
- 关联项目：RidePulse 码表任务拆分，包含轮速采集、传感器采样、LVGL 显示、LittleFS 存储、OTA 和看门狗。

建议先打开这些 FreeRTOS 调试选项：

```c
#define configCHECK_FOR_STACK_OVERFLOW 2
#define configUSE_MALLOC_FAILED_HOOK 1
#define configUSE_TRACE_FACILITY 1
#define configGENERATE_RUN_TIME_STATS 1
```

## 问题背景

在 RidePulse 里，功能看起来只是“显示速度、里程和骑行时间”，但任务之间的时序关系并不简单：

```text
轮速 EXTI 中断 -> RideTask 计算速度/里程
SensorTask -> 心率/气压/温湿度/IMU 数据
LvglTask -> 码表页面刷新
StorageTask -> LittleFS 保存骑行记录
OtaTask -> Ymodem 升级
WatchdogTask -> 检查任务心跳
```

如果所有逻辑都塞进一个任务，UI 刷新可能被 Flash 写入卡住；如果每个小功能都拆一个任务，队列、锁和栈又会变得很难管。这篇文章的目标是给这个项目定一套任务拆分原则。

## 验证方法

我会用三个指标验证任务设计是否合理：

第一，看任务是否按预期周期运行。每个关键任务定期更新心跳：

```c
typedef enum {
    TASK_ID_RIDE = 0,
    TASK_ID_SENSOR,
    TASK_ID_LVGL,
    TASK_ID_STORAGE,
    TASK_ID_MAX,
} task_id_t;

static volatile uint32_t g_task_heartbeat[TASK_ID_MAX];

void TaskHeartbeat_Update(task_id_t id)
{
    g_task_heartbeat[id] = HAL_GetTick();
}
```

串口期望日志：

```text
[TASK] ride alive, period=100ms
[TASK] sensor alive, period=500ms
[TASK] lvgl alive, period=5ms
[TASK] storage idle
```

第二，看栈是否够用：

```c
Log_Info("RideTask stack remain=%lu", uxTaskGetStackHighWaterMark(g_ride_task));
Log_Info("LvglTask stack remain=%lu", uxTaskGetStackHighWaterMark(g_lvgl_task));
```

第三，看压力场景是否稳定：

- 用信号源模拟高频轮速脉冲，RideTask 不应丢失明显脉冲。
- 连续切换 LVGL 页面，LvglTask 不应卡顿或访问空指针。
- 骑行结束后写 LittleFS，UI 仍能刷新。
- OTA 期间暂停非必要任务，看门狗不应误复位。

## 复盘

FreeRTOS 项目最常见的问题不是“不会创建任务”，而是任务边界不清。

- UI 任务不要直接写 Flash，Flash 写入失败或擦除耗时会让界面卡住。
- 中断不要直接调用复杂业务函数，应该用任务通知或队列唤醒任务。
- 看门狗不能只在一个高优先级任务里喂，否则低优先级任务死掉也发现不了。
- 日志不能在高频任务里阻塞打印，最好放入日志队列异步输出。
- 队列长度要结合最坏情况计算，不要只靠“感觉够用”。

我在 RidePulse 里更倾向于少量稳定任务加清晰队列，而不是把每个模块都拆成任务。比如轮速中断只累计脉冲，RideTask 每 100ms 计算一次速度；UI 每 100ms 读取一次快照；StorageTask 只在骑行结束或周期保存时被唤醒。

## 任务划分原则

一个任务最好对应一种稳定职责：

- 周期采样：传感器读取、滤波、阈值判断
- 通信收发：串口、CAN、TCP/MQTT 数据处理
- 控制输出：电机、继电器、LED、蜂鸣器
- 日志记录：异步打印，避免业务任务阻塞
- 系统监控：看门狗、任务心跳、异常恢复

不要为了“用了 RTOS”而把每个函数都拆成任务。

## 示例任务结构

```c
void App_CreateTasks(void)
{
    xTaskCreate(SensorTask, "sensor", 512, NULL, 3, NULL);
    xTaskCreate(CommTask, "comm", 768, NULL, 4, NULL);
    xTaskCreate(ControlTask, "ctrl", 512, NULL, 5, NULL);
    xTaskCreate(LogTask, "log", 512, NULL, 1, NULL);
    xTaskCreate(WatchdogTask, "wdg", 256, NULL, 6, NULL);
}
```

这里的优先级不是固定答案，只体现一种思路：

- 看门狗任务优先级高，保证系统监控及时
- 控制任务高于采样任务，保证输出响应
- 通信任务根据协议实时性设置
- 日志任务优先级低，不能影响业务

## 优先级设计

优先级不要拍脑袋，建议从响应时间倒推。

| 任务 | 响应要求 | 优先级建议 |
|------|----------|------------|
| 电机控制 | 1ms-10ms | 高 |
| 通信接收 | 1ms-20ms | 中高 |
| 传感器采样 | 10ms-100ms | 中 |
| UI/指示灯 | 100ms-500ms | 低 |
| 日志输出 | 不敏感 | 低 |

优先级过高的任务必须避免长时间运行，否则会饿死低优先级任务。

## 队列适合什么

队列适合传递数据对象，尤其是生产者和消费者速率不一致时。

```c
typedef struct {
    uint16_t id;
    uint8_t len;
    uint8_t data[16];
} msg_t;

QueueHandle_t g_comm_queue;

void CommTask(void *arg)
{
    msg_t msg;

    while (1) {
        if (xQueueReceive(g_comm_queue, &msg, portMAX_DELAY) == pdTRUE) {
            Protocol_Handle(&msg);
        }
    }
}
```

队列的优点是边界清晰，缺点是会复制数据。大块数据可以传指针，但要管理生命周期。

## 事件组适合什么

事件组适合表达多个状态条件，例如 WiFi 已连接、时间已同步、配置已加载。

```c
#define EVT_NET_READY      (1 << 0)
#define EVT_TIME_SYNCED    (1 << 1)
#define EVT_CONFIG_READY   (1 << 2)

EventGroupHandle_t g_sys_event;

void UploadTask(void *arg)
{
    const EventBits_t wait_bits = EVT_NET_READY | EVT_TIME_SYNCED | EVT_CONFIG_READY;

    while (1) {
        xEventGroupWaitBits(
            g_sys_event,
            wait_bits,
            pdFALSE,
            pdTRUE,
            portMAX_DELAY
        );

        Upload_RunOnce();
    }
}
```

如果你传的是“数据”，用队列；如果你等的是“状态”，用事件组。

## 任务通知适合什么

任务通知比队列和信号量更轻量，适合一对一唤醒。

```c
TaskHandle_t g_sensor_task;

void EXTI_IRQHandler(void)
{
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    vTaskNotifyGiveFromISR(g_sensor_task, &xHigherPriorityTaskWoken);
    portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
}

void SensorTask(void *arg)
{
    while (1) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        Sensor_ReadAndFilter();
    }
}
```

它很适合中断唤醒任务，但不适合广播给多个任务。

## 栈大小怎么估

栈不够会导致非常隐蔽的问题。建议开启 FreeRTOS 栈检测：

```c
#define configCHECK_FOR_STACK_OVERFLOW 2

void vApplicationStackOverflowHook(TaskHandle_t task, char *name)
{
    Log_Error("stack overflow: %s", name);
    taskDISABLE_INTERRUPTS();
    while (1) {}
}
```

运行一段时间后可以检查高水位：

```c
UBaseType_t remain = uxTaskGetStackHighWaterMark(NULL);
Log_Info("stack remain: %u", remain);
```

## 常见问题

### 低优先级任务一直不运行

通常是高优先级任务没有 `vTaskDelay()` 或阻塞等待，导致 CPU 被长期占用。

### 队列满

先确认消费者是否处理太慢，再考虑加大队列长度。不要一上来只扩大队列，否则只是把问题推迟。

### 串口日志卡住系统

日志任务应异步输出，业务任务只把日志放入缓冲区。串口阻塞发送很容易影响实时性。

## 小结

FreeRTOS 的核心不是 API 数量，而是设计边界：

- 任务负责什么
- 数据怎么流动
- 状态怎么同步
- 异常怎么恢复

把这些想清楚，系统就不会随着功能增加变成一团互相等待的状态机。
