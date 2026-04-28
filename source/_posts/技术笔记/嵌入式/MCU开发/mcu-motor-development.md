---
title: MCU开发专题：电机开发从入门到实战
date: 2026-04-28
categories:
  - 技术笔记
  - 嵌入式
  - MCU开发
  - 电机开发
tags:
  - MCU
  - STM32
  - 电机
  - PWM
  - PID
description: 电机开发详解：直流电机、BLDC、PMSM 的驱动与控制算法
top_img: https://source.unsplash.com/1600x900/?motor,engineering
---

## 1. 电机类型与驱动方式
---

# MCU开发专题：电机开发从入门到实战

## 1. 电机类型与驱动方式

### 直流有刷电机（DC Brushed）

```
驱动方式：H 桥驱动
控制信号：PWM 调速 + 方向控制
```

```c
// H 桥控制
#define MOTOR_IN1_HIGH()  (GPIO_SetBits(GPIOB, GPIO_Pin_0))
#define MOTOR_IN1_LOW()   (GPIO_ResetBits(GPIOB, GPIO_Pin_0))
#define MOTOR_IN2_HIGH()  (GPIO_SetBits(GPIOB, GPIO_Pin_1))
#define MOTOR_IN2_LOW()   (GPIO_ResetBits(GPIOB, GPIO_Pin_1))

// PWM 调速
void Motor_SetSpeed(uint8_t speed) {
    TIM_SetCompare1(TIM3, speed);  // 0-100 对应 0%-100%
}

// 停止
void Motor_Stop(void) {
    MOTOR_IN1_LOW();
    MOTOR_IN2_LOW();
}

// 正转
void Motor_Forward(uint8_t speed) {
    MOTOR_IN1_HIGH();
    MOTOR_IN2_LOW();
    Motor_SetSpeed(speed);
}

// 反转
void Motor_Reverse(uint8_t speed) {
    MOTOR_IN1_LOW();
    MOTOR_IN2_HIGH();
    Motor_SetSpeed(speed);
}
```

---

### 无刷直流电机（BLDC）

```
驱动方式：六步换向 / FOC
控制信号：3 路 PWM + 传感器或无传感器
```

#### 六步换向控制

```c
// BLDC 六步换向表（霍尔传感器）
// 霍尔值：0-5，对应 6 种换向状态
const uint8_t BLDC_STEP_TABLE[6][3] = {
    // A  B  C
    {  1,  0,  0 },  // Step 0: AH-BL
    {  0,  1,  0 },  // Step 1: AL-BH
    {  0,  1,  0 },  // Step 2: AL-CH
    {  0,  0,  1 },  // Step 3: BL-CH
    {  1,  0,  0 },  // Step 4: BH-CL
    {  0,  0,  1 },  // Step 5: BL-CL
};

void BLDC_Commutation(uint8_t hall_value) {
    static GPIO_TypeDef* PORT[3] = {GPIOA, GPIOA, GPIOB};
    static uint16_t PIN[3] = {GPIO_Pin_0, GPIO_Pin_1, GPIO_Pin_2};

    // 关闭所有输出
    for (int i = 0; i < 3; i++)
        GPIO_ResetBits(PORT[i], PIN[i]);

    // 根据换向表开启对应 MOS
    uint8_t *step = BLDC_STEP_TABLE[hall_value];
    for (int i = 0; i < 3; i++) {
        if (step[i] == 1)
            GPIO_SetBits(PORT[i], PIN[i]);
    }
}
```

---

### 永磁同步电机（PMSM / FOC）

FOC（磁场定向控制）是高性能电机控制方案。

```c
// 简化的 FOC 结构
struct FOC_Handle {
    float i_alpha, i_beta;     // 静止坐标系电流
    float i_d, i_q;            // 旋转坐标系电流
    float u_alpha, u_beta;     // 静止坐标系电压
    float u_d, u_q;            // 旋转坐标系电压
    float angle_el;            // 电角度
    float speed;               // 电机速度
};

// Clark 变换：ABC -> αβ
void Clark_Transform(float ia, float ib, float ic,
                     float *i_alpha, float *i_beta) {
    *i_alpha = ia;
    *i_beta = (ia + 2*ib) / sqrt(3);
}

// Park 变换：αβ -> dq
void Park_Transform(float i_alpha, float i_beta, float angle,
                   float *i_d, float *i_q) {
    float cos_a = cosf(angle);
    float sin_a = sinf(angle);
    *i_d = i_alpha * cos_a + i_beta * sin_a;
    *i_q = -i_alpha * sin_a + i_beta * cos_a;
}

// 反 Park 变换：dq -> αβ
void Inv_Park_Transform(float u_d, float u_q, float angle,
                        float *u_alpha, float *u_beta) {
    float cos_a = cosf(angle);
    float sin_a = sinf(angle);
    *u_alpha = u_d * cos_a - u_q * sin_a;
    *u_beta = u_d * sin_a + u_q * cos_a;
}
```

---

## 2. PWM 与定时器配置

### STM32 PWM 配置

```c
void TIM1_PWM_Init(void) {
    // 使能时钟
    RCC->APB2ENR |= RCC_APB2ENR_TIM1EN;

    // GPIO 配置：PA8=TIM1_CH1 (复用推挽)
    GPIOA->MODER &= ~GPIO_MODER_MODER8;
    GPIOA->MODER |= GPIO_MODER_MODER8_1;  // 复用
    GPIOA->OSPEEDR |= 0x3;  // 高速

    // 定时器配置
    TIM1->PSC = 83;   // 1MHz (84MHz / 84)
    TIM1->ARR = 1000; // 1kHz PWM 频率
    TIM1->CNT = 0;

    // PWM 模式1：CNT < CCR 时输出有效电平
    TIM1->CCMR1 = (6 << 4) | (1 << 3);  // OC1M=110, OC1PE=1
    TIM1->CCR1 = 500;  // 50% 占空比

    TIM1->CCER |= TIM_CCER_CC1E;  // 使能通道1
    TIM1->BDTR |= TIM_BDTR_MOE;  // 主输出使能
    TIM1->CR1 |= TIM_CR1_CEN;    // 使能计数器
}
```

### 双电机（两路 PWM）

```c
// TIM3 配置两路 PWM：PA6=CH1, PA7=CH2
void TIM3_PWM_Init(void) {
    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;

    // PA6, PA7 复用
    GPIOA->MODER |= (GPIO_MODER_MODER6_1 | GPIO_MODER_MODER7_1);

    TIM3->PSC = 83;   // 1MHz
    TIM3->ARR = 1000; // 1kHz

    // CH1: PWM 模式1
    TIM3->CCMR1 = (6 << 4);
    TIM3->CCR1 = 0;

    // CH2: PWM 模式1
    TIM3->CCMR1 |= (6 << 12);
    TIM3->CCR2 = 0;

    TIM3->CCER |= TIM_CCER_CC1E | TIM_CCER_CC2E;
    TIM3->CR1 |= TIM_CR1_CEN;
}
```

---

## 3. PID 控制器

### 位置式 PID

```c
struct PID {
    float kp, ki, kd;
    float target;
    float feedback;
    float integral;
    float out_max;
    float out_min;
};

float PID_Calc(struct PID *pid, float feedback) {
    float error = pid->target - feedback;
    float out;

    // 积分项（带积分限幅）
    pid->integral += pid->ki * error;
    if (pid->integral > pid->out_max) pid->integral = pid->out_max;
    if (pid->integral < pid->out_min) pid->integral = pid->out_min;

    // 微分项
    float derivative = error - pid->last_error;

    // 输出
    out = pid->kp * error + pid->integral + pid->kd * derivative;

    // 输出限幅
    if (out > pid->out_max) out = pid->out_max;
    if (out < pid->out_min) out = pid->out_min;

    pid->last_error = error;
    return out;
}
```

### 增量式 PID

```c
float PID_Incremental(struct PID *pid, float feedback) {
    float error = pid->target - feedback;

    float delta_out = pid->kp * (error - pid->last_error)
                    + pid->ki * error
                    + pid->kd * (error - 2*pid->last_error + pid->prev_error);

    pid->prev_error = pid->last_error;
    pid->last_error = error;

    // 限幅
    float out = pid->last_output + delta_out;
    if (out > pid->out_max) out = pid->out_max;
    if (out < pid->out_min) out = pid->out_min;
    pid->last_output = out;

    return out;
}
```

---

## 4. 编码器测速

### 正交编码器模式

```c
// TIM2 配置为编码器模式
void TIM2_Encoder_Init(void) {
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;

    // PA0=TIM2_CH1, PA1=TIM2_CH2
    GPIOA->MODER |= GPIO_MODER_MODER0_1 | GPIO_MODER_MODER1_1;

    // 编码器模式：TI1 和 TI2 都计数
    TIM2->SMCR = 3;  // SMS=011
    TIM2->CCMR1 = (1 << 0) | (1 << 8);  // CC1S=01, CC2S=01
    TIM2->ARR = 65535;
    TIM2->CNT = 32768;  // 中心对齐
    TIM2->CR1 |= TIM_CR1_CEN;
}

// 读取速度（定时调用，如 10ms 一次）
int16_t Encoder_Read_Speed(void) {
    static int16_t last_count = 0;
    int16_t count = TIM2->CNT;
    int16_t speed = count - last_count;
    last_count = count;
    return speed;
}
```

---

## 5. 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 电机抖动 | PID 参数不当 | 减小 P 或 D |
| 电机不转 | PWM 频率太高 | 降低到 20kHz 以下 |
| 电机发热 | 电流过大 | 检查 H 桥驱动能力 |
| 启动逆转 | 霍尔传感器接线错 | 换相序 |
| 转速不稳 | 负载波动 | 增大积分或加前馈 |

---

## 总结

| 电机类型 | 控制复杂度 | 性能 | 适用场景 |
|---------|-----------|------|---------|
| DC 有刷 | 低 | 中 | 简单调速 |
| BLDC | 中 | 高 | 工业、消费电子 |
| PMSM | 高 | 最高 | 伺服、无人机 |

> **核心**：直流电机用 PWM，BLDC 用换向，PMSM 用 FOC。
