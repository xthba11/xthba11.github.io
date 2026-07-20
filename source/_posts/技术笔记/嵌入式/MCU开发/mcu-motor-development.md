---
title: MCU开发专题：电机开发从入门到实战
date: 2024-08-18
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
cover: /img/covers/articles/mcu-motor-development.svg
top_img: /img/covers/articles/mcu-motor-development.svg
---

# MCU开发专题：电机开发从入门到实战

## 1. 电机类型与驱动方式

### 直流有刷电机（DC Brushed）

```
驱动方式：H 桥驱动
控制信号：PWM 调速 + 方向控制
```

```c
// 直流有刷电机 H 桥控制（两路 GPIO + 一路 PWM）
// IN1/IN2 控制 H 桥 MOS 开关组合，决定电流方向（正转/反转/制动）
#define MOTOR_IN1_HIGH()  (GPIO_SetBits(GPIOB, GPIO_Pin_0))   // IN1 置高，H 桥左上臂导通
#define MOTOR_IN1_LOW()   (GPIO_ResetBits(GPIOB, GPIO_Pin_0))  // IN1 置低
#define MOTOR_IN2_HIGH()  (GPIO_SetBits(GPIOB, GPIO_Pin_1))   // IN2 置高，H 桥左下臂导通
#define MOTOR_IN2_LOW()   (GPIO_ResetBits(GPIOB, GPIO_Pin_1))  // IN2 置低

// PWM 调速：通过改变占空比控制电机平均电压
void Motor_SetSpeed(uint8_t speed) {
    TIM_SetCompare1(TIM3, speed);  // speed 0-100 对应 0%-100% 占空比
}

// 停止：IN1 和 IN2 都为低电平，H 桥全部截止，电机惯性滑行
void Motor_Stop(void) {
    MOTOR_IN1_LOW();
    MOTOR_IN2_LOW();
}

// 正转：IN1=高, IN2=低，电流从左到右流过电机
void Motor_Forward(uint8_t speed) {
    MOTOR_IN1_HIGH();   // 左上臂导通
    MOTOR_IN2_LOW();    // 右下臂导通
    Motor_SetSpeed(speed);
}

// 反转：IN1=低, IN2=高，电流从右到左流过电机
void Motor_Reverse(uint8_t speed) {
    MOTOR_IN1_LOW();    // 左下臂导通
    MOTOR_IN2_HIGH();   // 右上臂导通
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
// BLDC 六步换向表（基于霍尔传感器位置反馈）
// 霍尔传感器输出 3 位编码（001~110），共 6 种有效状态
// 每一行表示一个换向步，列依次对应 A/B/C 三相上桥臂是否导通（1=导通, 0=关断）
const uint8_t BLDC_STEP_TABLE[6][3] = {
    // Hall值 A  B  C
    {  1,  0,  0 },  // Step 0: AH-BL — A相上桥+B相下桥导通
    {  0,  1,  0 },  // Step 1: AL-BH — A相下桥+B相上桥导通
    {  0,  1,  0 },  // Step 2: AL-CH — A相下桥+C相上桥导通
    {  0,  0,  1 },  // Step 3: BL-CH — B相下桥+C相上桥导通
    {  1,  0,  0 },  // Step 4: BH-CL — B相上桥+C相下桥导通
    {  0,  0,  1 },  // Step 5: BL-CL — B相下桥+C相下桥... (实际需修正)
};

// 六步换向函数：根据霍尔编码切换三相 MOS 管导通状态
void BLDC_Commutation(uint8_t hall_value) {
    // 三相上桥臂分别对应的 GPIO 端口和引脚
    static GPIO_TypeDef* PORT[3] = {GPIOA, GPIOA, GPIOB};
    static uint16_t PIN[3] = {GPIO_Pin_0, GPIO_Pin_1, GPIO_Pin_2};

    // 第1步：先关闭所有上桥臂输出，防止上下桥同时导通（直通短路）
    for (int i = 0; i < 3; i++)
        GPIO_ResetBits(PORT[i], PIN[i]);

    // 第2步：根据换向表开启对应相的上桥臂 MOS 管
    uint8_t *step = BLDC_STEP_TABLE[hall_value];  // 获取当前霍尔值对应的换向行
    for (int i = 0; i < 3; i++) {
        if (step[i] == 1)                         // 该相标记为导通
            GPIO_SetBits(PORT[i], PIN[i]);        // 置高 GPIO 打开上桥臂
    }
}
```

---

### 永磁同步电机（PMSM / FOC）

FOC（磁场定向控制）是高性能电机控制方案。

```c
// 简化的 FOC（磁场定向控制）控制结构体
struct FOC_Handle {
    float i_alpha, i_beta;     // α-β 静止坐标系电流（Clark 变换输出）
    float i_d, i_q;            // d-q 旋转坐标系电流（Park 变换输出）
    float u_alpha, u_beta;     // α-β 静止坐标系电压（Inv-Park 变换输出，送 SVPWM）
    float u_d, u_q;            // d-q 旋转坐标系电压（PID 控制器输出）
    float angle_el;            // 转子电角度（来自编码器或观测器）
    float speed;               // 电机当前转速（rpm 或 rad/s）
};

// Clark 变换：将三相定子电流 (ia, ib, ic) 映射到两相静止坐标系 (α, β)
// 原理：ia + ib + ic = 0（三相对称），所以只用 ia 和 ib 即可推导 ic
void Clark_Transform(float ia, float ib, float ic,
                     float *i_alpha, float *i_beta) {
    *i_alpha = ia;                            // α 轴与 A 轴重合，直接取 ia
    *i_beta = (ia + 2*ib) / sqrt(3);          // β 轴 = (ia + 2ib) / √3（等幅值变换）
}

// Park 变换：将静止 α-β 坐标系旋转到与转子同步的 d-q 坐标系
// d 轴对齐转子磁场方向（励磁分量），q 轴与磁场垂直（转矩分量）
void Park_Transform(float i_alpha, float i_beta, float angle,
                   float *i_d, float *i_q) {
    float cos_a = cosf(angle);                // 电角度的余弦
    float sin_a = sinf(angle);                // 电角度的正弦
    *i_d = i_alpha * cos_a + i_beta * sin_a;  // d 轴投影：同相分量
    *i_q = -i_alpha * sin_a + i_beta * cos_a; // q 轴投影：正交分量
}

// 反 Park 变换：将 d-q 旋转坐标系电压转换回静止 α-β 坐标系
// 用于将 PID 输出的 d/q 电压转换为 SVPWM 需要的 α/β 电压
void Inv_Park_Transform(float u_d, float u_q, float angle,
                        float *u_alpha, float *u_beta) {
    float cos_a = cosf(angle);
    float sin_a = sinf(angle);
    *u_alpha = u_d * cos_a - u_q * sin_a;     // α 轴电压 = d*cosθ - q*sinθ
    *u_beta = u_d * sin_a + u_q * cos_a;      // β 轴电压 = d*sinθ + q*cosθ
}
```

---

## 2. PWM 与定时器配置

### STM32 PWM 配置

```c
// TIM1 高级定时器 PWM 输出初始化（用于电机控制，支持互补输出和死区）
void TIM1_PWM_Init(void) {
    // 1. 使能 TIM1 时钟（TIM1 挂在 APB2 高速总线上）
    RCC->APB2ENR |= RCC_APB2ENR_TIM1EN;

    // 2. GPIO 配置：PA8 复用为 TIM1_CH1（通道 1 输出）
    GPIOA->MODER &= ~GPIO_MODER_MODER8;        // 先清除 MODER8 两位
    GPIOA->MODER |= GPIO_MODER_MODER8_1;       // MODER=10b 即复用功能模式
    GPIOA->OSPEEDR |= 0x3;                     // OSPEEDR=11b 最高速度等级（高速 PWM 需要）

    // 3. 定时器时基配置
    // PWM 频率 = 定时器时钟 / (PSC+1) / (ARR+1)
    // 例：84MHz / (83+1) / (999+1) = 1kHz
    TIM1->PSC = 83;       // 预分频器：84MHz / 84 = 1MHz 计数频率
    TIM1->ARR = 1000;     // 自动重载值：1MHz / 1000 = 1kHz PWM 频率
    TIM1->CNT = 0;        // 计数器清零，从 0 开始计数

    // 4. PWM 模式配置（通道 1）
    // CCMR1[6:4]=110b 即 PWM 模式 1：CNT < CCR 时输出有效电平，CNT >= CCR 时输出无效电平
    // CCMR1[3]=1 即 OC1PE 预装载使能：CCR 值在更新事件时才生效，避免 PWM 毛刺
    TIM1->CCMR1 = (6 << 4) | (1 << 3);  // OC1M=110 (PWM模式1), OC1PE=1 (预装载使能)
    TIM1->CCR1 = 500;                    // 捕获/比较值：500/1000 = 50% 占空比

    // 5. 输出使能
    TIM1->CCER |= TIM_CCER_CC1E;         // CC1E: 捕获/比较通道 1 输出使能
    TIM1->BDTR |= TIM_BDTR_MOE;          // MOE: 主输出使能（高级定时器必须置位才能输出）
    TIM1->CR1 |= TIM_CR1_CEN;            // CEN: 计数器使能，开始计数
}
```

### 双电机（两路 PWM）

```c
// TIM3 通用定时器双路 PWM 输出（用于双电机独立调速）
// PA6 = TIM3_CH1（电机1）, PA7 = TIM3_CH2（电机2）
void TIM3_PWM_Init(void) {
    // 使能时钟：TIM3 在 APB1, GPIOA 在 AHB1
    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;

    // 配置 PA6、PA7 为复用功能模式（MODER=10b）
    GPIOA->MODER |= (GPIO_MODER_MODER6_1 | GPIO_MODER_MODER7_1);

    // 时基配置：1MHz 计数，1kHz PWM 频率
    TIM3->PSC = 83;    // 预分频：84MHz/84 = 1MHz
    TIM3->ARR = 1000;  // 自动重载：1MHz/1000 = 1kHz

    // 通道1 配置：CCMR1[6:4]=110b PWM 模式1
    // CCMR1 低 16 位控制 CH1，高 16 位控制 CH2
    TIM3->CCMR1 = (6 << 4);   // CH1: OC1M=110 (PWM模式1)
    TIM3->CCR1 = 0;           // CH1 初始占空比 0%（电机停转）

    // 通道2 配置：CCMR1[14:12]=110b PWM 模式1
    TIM3->CCMR1 |= (6 << 12); // CH2: OC2M=110 (PWM模式1)，与 CH1 合并写入
    TIM3->CCR2 = 0;           // CH2 初始占空比 0%

    // 使能两路 PWM 输出并启动计数器
    TIM3->CCER |= TIM_CCER_CC1E | TIM_CCER_CC2E;  // CC1E+CC2E 双双使能
    TIM3->CR1 |= TIM_CR1_CEN;                      // 启动计数器
}
```

---

## 3. PID 控制器

### 位置式 PID

```c
// 位置式 PID 控制器：输出 = 当前控制量的绝对值（非增量）
// 适用场景：电机位置控制、温度控制等对历史状态有要求的系统
struct PID {
    float kp, ki, kd;         // PID 三个增益系数
    float target;             // 目标值（设定点）
    float feedback;           // 反馈值（当前测量值）
    float integral;           // 积分累加器（历史误差累积）
    float last_error;         // 上一次误差（用于微分计算）
    float out_max;            // 输出上限（防止积分饱和）
    float out_min;            // 输出下限
};

float PID_Calc(struct PID *pid, float feedback) {
    float error = pid->target - feedback;  // 计算当前误差
    float out;

    // 第1步：积分项计算（带积分限幅 Anti-Windup）
    // 积分项消除稳态误差，但过大会导致超调和振荡
    pid->integral += pid->ki * error;
    if (pid->integral > pid->out_max) pid->integral = pid->out_max;  // 积分上限钳位
    if (pid->integral < pid->out_min) pid->integral = pid->out_min;  // 积分下限钳位

    // 第2步：微分项计算（误差变化率）
    // 微分项预测误差趋势，提供阻尼效果，抑制超调
    float derivative = error - pid->last_error;

    // 第3步：PID 三项求和得到最终输出
    out = pid->kp * error       // P：比例项，立刻响应当前误差
        + pid->integral          // I：积分项，消除历史累积误差
        + pid->kd * derivative;  // D：微分项，抑制变化趋势

    // 第4步：输出限幅，保护执行器不超出物理范围
    if (out > pid->out_max) out = pid->out_max;
    if (out < pid->out_min) out = pid->out_min;

    pid->last_error = error;  // 保存本次误差供下次微分计算
    return out;
}
```

### 增量式 PID

```c
// 增量式 PID 控制器：输出 = 控制量的增量（Δu），需要在外层累加
// 优点：无积分饱和问题，切换无冲击，适合步进电机、阀门开度等执行器
float PID_Incremental(struct PID *pid, float feedback) {
    float error = pid->target - feedback;  // 当前误差

    // 增量公式：Δu = Kp*(e_k - e_{k-1}) + Ki*e_k + Kd*(e_k - 2*e_{k-1} + e_{k-2})
    // 推导自位置式 PID 的差分形式，仅使用最近三次误差
    float delta_out = pid->kp * (error - pid->last_error)                     // 比例增量
                    + pid->ki * error                                         // 积分增量
                    + pid->kd * (error - 2*pid->last_error + pid->prev_error);// 微分增量

    // 更新误差历史（为下一次计算准备）
    pid->prev_error = pid->last_error;  // e_{k-2} ← e_{k-1}
    pid->last_error = error;            // e_{k-1} ← e_k

    // 增量叠加到上次输出并限幅
    float out = pid->last_output + delta_out;
    if (out > pid->out_max) out = pid->out_max;
    if (out < pid->out_min) out = pid->out_min;
    pid->last_output = out;  // 保存本次输出供下次叠加

    return out;
}
```

---

## 4. 编码器测速

### 正交编码器模式

```c
// TIM2 配置为增量式正交编码器模式
// 正交编码器输出 A/B 两相脉冲，相位差 90°，通过检测边沿判断方向和速度
void TIM2_Encoder_Init(void) {
    // 使能时钟
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;   // TIM2 在 APB1 总线
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;  // GPIOA 在 AHB1 总线

    // 配置 PA0=TIM2_CH1（编码器 A 相）, PA1=TIM2_CH2（编码器 B 相）为复用模式
    GPIOA->MODER |= GPIO_MODER_MODER0_1 | GPIO_MODER_MODER1_1;

    // 编码器模式配置：TI1 和 TI2 双边沿都计数（4 倍频，精度最高）
    TIM2->SMCR = 3;                          // SMS[2:0]=011：编码器模式 3，双通道双边沿计数
    TIM2->CCMR1 = (1 << 0) | (1 << 8);       // CC1S=01 (TI1), CC2S=01 (TI2) 选择输入通道
    TIM2->ARR = 65535;                       // 自动重载值设为 16 位最大值
    TIM2->CNT = 32768;                       // 计数器初始值为中间值，便于检测正反转
    TIM2->CR1 |= TIM_CR1_CEN;                // 启动编码器计数
}

// 读取编码器速度（周期性调用，例如每 10ms）
// 返回值 >0 表示正转，<0 表示反转，绝对值表示速度
int16_t Encoder_Read_Speed(void) {
    static int16_t last_count = 0;           // 上次计数值（静态变量保持）
    int16_t count = TIM2->CNT;               // 读取当前计数值
    int16_t speed = count - last_count;      // 差值即为单位时间内的脉冲增量
    last_count = count;                      // 更新历史值
    return speed;                            // 返回速度（脉冲/周期）
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
