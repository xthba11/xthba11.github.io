---
title: RK3568 车载网关实验四：OpenCV 视频采集与轻量级车道线检测
date: 2026-07-16 18:40:00
categories:
  - 技术笔记
  - Linux
  - RK3568
  - 车载网关
tags:
  - RK3568
  - Linux
  - OpenCV
  - V4L2
  - 车道线检测
description: 在 RK3568 车载网关项目中使用 OpenCV 支持视频文件和 USB 摄像头输入，并通过 ROI、Canny、HoughLinesP 实现第一版轻量级车道线检测。
top_img: /img/covers/linux-driver-cover.svg
---

CAN 网关只能说明系统能采集车辆状态，但车道偏离预警还需要视觉输入。

这篇文章记录项目里的视频采集和第一版轻量级车道线检测。第一版不使用深度学习模型，而是采用传统 OpenCV 流程：灰度化、滤波、Canny、ROI、HoughLinesP、斜率筛选和车道中心计算。

## 测试环境

- 主机系统：Ubuntu 22.04 LTS，先用视频文件稳定调试。
- 目标板/芯片：RK3568 Linux 开发板。
- 内核/SDK/编译器版本：OpenCV 4.x，V4L2，C++11。
- 使用工具：`v4l2-ctl`、`ffplay`、`opencv`、`cmake`、`g++`、`top/htop`。
- 输入源：道路视频文件 `data/lane_test.mp4` 或 USB 摄像头 `/dev/video0`。
- 输出：`LaneStatus` 和叠加 ROI/车道线后的图像。

安装依赖：

```bash
sudo apt install -y libopencv-dev v4l-utils ffmpeg
```

检查摄像头：

```bash
ls /dev/video*
v4l2-ctl --list-devices
v4l2-ctl --device=/dev/video0 --all
```

## 问题背景

项目最终数据流是：

```text
USB Camera / Video File
  -> OpenCV VideoCapture
  -> VideoFrameQueue
  -> LaneDetector
  -> FusionState
  -> AlarmManager
  -> Qt Dashboard
```

第一版同时支持两种输入：

- 视频文件：适合 PC 阶段稳定复现，方便调 ROI 和阈值。
- USB 摄像头：适合 RK3568 实机演示。

我更建议先用视频文件调通算法，因为摄像头角度、曝光、光照和安装位置都会影响检测结果。视频文件能让每一次运行面对相同输入，调参更可控。

## 配置文件

视频输入配置：

```json
{
  "video": {
    "enable": true,
    "source_type": "file",
    "file_path": "./data/lane_test.mp4",
    "camera_device": 0,
    "width": 640,
    "height": 480,
    "fps": 30
  }
}
```

车道检测配置：

```json
{
  "lane_detection": {
    "enable": true,
    "resize_width": 640,
    "resize_height": 480,
    "canny_low": 50,
    "canny_high": 150,
    "hough_threshold": 40,
    "min_line_length": 40,
    "max_line_gap": 80,
    "min_slope_abs": 0.5,
    "max_slope_abs": 2.5,
    "offset_warning_px": 80,
    "lane_lost_frame_threshold": 10,
    "roi": {
      "left_bottom": [80, 480],
      "right_bottom": [560, 480],
      "left_top": [260, 280],
      "right_top": [380, 280]
    }
  }
}
```

ROI 坐标一定要放配置文件里，不要写死在代码中。不同视频和摄像头安装角度会让 ROI 差异很大。

## 视频采集模块

核心接口：

```cpp
class VideoCaptureModule {
public:
    bool open(const VideoConfig& config);
    bool readFrame(cv::Mat& frame);
    void close();
};
```

打开输入源：

```cpp
bool VideoCaptureModule::open(const VideoConfig& config)
{
    if (config.source_type == "file") {
        cap_.open(config.file_path);
    } else if (config.source_type == "camera") {
        cap_.open(config.camera_device);
        cap_.set(cv::CAP_PROP_FRAME_WIDTH, config.width);
        cap_.set(cv::CAP_PROP_FRAME_HEIGHT, config.height);
        cap_.set(cv::CAP_PROP_FPS, config.fps);
    }

    if (!cap_.isOpened()) {
        std::cerr << "[VIDEO] open failed\n";
        return false;
    }

    return true;
}
```

视频不可用时程序不能崩溃。项目应该允许 `video.enable=false`，让网关只运行 CAN 功能。

## LaneStatus 设计

车道检测输出结构：

```cpp
struct LaneStatus {
    bool lane_detected = false;
    bool left_lane_detected = false;
    bool right_lane_detected = false;
    double lane_center_x = 0.0;
    double vehicle_center_x = 0.0;
    double center_offset_px = 0.0;
    bool lane_lost = false;
    bool departure_warning = false;
    std::uint64_t timestamp_ms = 0;
};
```

其中 `center_offset_px = vehicle_center_x - lane_center_x`。第一版可以近似认为车辆中心在图像中心，也就是 `image_width / 2`。

## 检测流程

第一版算法：

```text
输入图像
  -> resize 640x480
  -> 灰度化
  -> 高斯滤波
  -> Canny 边缘检测
  -> ROI 梯形区域裁剪
  -> HoughLinesP 检测直线
  -> 按斜率筛选左/右车道线
  -> 拟合左右车道线
  -> 计算车道中心
  -> 计算车辆偏移
  -> 输出 LaneStatus
```

简化代码：

```cpp
bool LaneDetector::processFrame(const cv::Mat& input, LaneStatus& status, cv::Mat& output)
{
    cv::Mat resized;
    cv::resize(input, resized, cv::Size(config_.resize_width, config_.resize_height));

    cv::Mat gray;
    cv::cvtColor(resized, gray, cv::COLOR_BGR2GRAY);

    cv::Mat blur;
    cv::GaussianBlur(gray, blur, cv::Size(5, 5), 0);

    cv::Mat edges;
    cv::Canny(blur, edges, config_.canny_low, config_.canny_high);

    cv::Mat masked = applyRoi(edges);

    std::vector<cv::Vec4i> lines;
    cv::HoughLinesP(masked, lines, 1, CV_PI / 180,
                    config_.hough_threshold,
                    config_.min_line_length,
                    config_.max_line_gap);

    return fitLaneLines(resized, lines, status, output);
}
```

根据斜率区分左右车道线：

```cpp
for (const auto& l : lines) {
    double x1 = l[0], y1 = l[1], x2 = l[2], y2 = l[3];
    if (std::abs(x2 - x1) < 1.0) {
        continue;
    }

    double slope = (y2 - y1) / (x2 - x1);
    if (std::abs(slope) < config_.min_slope_abs ||
        std::abs(slope) > config_.max_slope_abs) {
        continue;
    }

    if (slope < 0) {
        left_lines.push_back(l);
    } else {
        right_lines.push_back(l);
    }
}
```

不同相机坐标系和视频方向可能导致左右判断相反，第一次调试时一定要把候选线画出来确认。

## 验证方法

先检查视频文件：

```bash
ffplay data/lane_test.mp4
```

运行检测程序：

```bash
./vehicle_gateway --config config/gateway.json --video-only
```

期望日志：

```text
[VIDEO] source=file path=./data/lane_test.mp4
[VIDEO] fps=29.8
[LANE] left=1 right=1 offset=45.2px lost=0 warning=0
```

切换到摄像头：

```bash
./vehicle_gateway --config config/gateway_camera.json --video-only
```

RK3568 板端检查：

```bash
ls /dev/video*
v4l2-ctl --list-devices
./vehicle_gateway --config config/gateway_camera.json
```

验收标准：

- 能显示 ROI 区域。
- 能显示 Canny 边缘图。
- 能显示 Hough 候选线。
- 能画出最终左右车道线。
- 能画出车辆中心线和车道中心线。
- 能输出偏移量。
- 视频文件不存在或摄像头断开时程序不崩溃。

## 和 CAN 融合

视觉模块只输出车道状态，不直接决定最终告警。最终车道偏离要结合车辆速度和转向灯：

```text
speed > 30
abs(center_offset_px) > offset_warning_px
未开启对应方向转向灯
  -> lane departure warning
```

低速偏移不告警：

```text
vehicle_speed <= 30
abs(center_offset_px) > 80
期望：不触发车道偏离告警
```

高速偏移告警：

```text
vehicle_speed > 30
abs(center_offset_px) > 80
left_turn_signal=false
right_turn_signal=false
期望：[WARNING] lane departure detected
```

## 复盘

第一版传统算法的价值是简单、可解释、容易在 RK3568 上跑起来，但它也有明显限制：

- 对光照敏感。
- 对摄像头角度敏感。
- 对车道线磨损、阴影、弯道不稳定。
- ROI 和阈值需要针对视频调参。

所以我会把它定位为“轻量级演示版本”，目标不是替代真实 ADAS 算法，而是让项目具备视觉融合链路：

```text
视频输入 -> 车道线检测 -> 偏移量 -> 与 CAN 速度/转向灯融合 -> 告警 -> Qt 显示
```

后续如果继续升级，可以把 `LaneDetector` 的实现替换为 RKNN 或轻量神经网络，但 `LaneStatus` 接口保持不变。这样上层融合告警、SQLite 存储和 Dashboard 都不用重写。
