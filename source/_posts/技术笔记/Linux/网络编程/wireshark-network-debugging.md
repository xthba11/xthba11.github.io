---
title: Linux网络开发专题：Wireshark 使用指南
date: 2026-04-28
categories:
  - 技术笔记
  - Linux
  - 网络编程
  - 网络调试
tags:
  - Linux
  - 网络编程
  - Wireshark
  - tcpdump
  - 网络调试
description: Wireshark 使用指南：抓包、过滤、分析TCP/UDP/HTTP流量
top_img: https://source.unsplash.com/1600x900/?monitor,technology
---

## 1. 安装与启动

# Linux 网络开发专题：Wireshark 使用指南

## 1. 安装与启动

```bash
# Ubuntu / Debian
sudo apt install wireshark

# CentOS / RHEL
sudo yum install wireshark

# 启动（需要 root 权限）
sudo wireshark &
```

## 2. 常用抓包命令

### 抓取所有流量
```bash
sudo tcpdump -i eth0 -w capture.pcap
```

### 抓取特定端口
```bash
# 抓取 80 端口 HTTP 流量
sudo tcpdump -i eth0 port 80 -w http.pcap

# 抓取 8080 端口
sudo tcpdump -i eth0 port 8080 -w app.pcap
```

### 抓取特定 IP
```bash
# 抓取与 192.168.1.100 通信的包
sudo tcpdump -i eth0 host 192.168.1.100 -w target.pcap

# 抓取源或目标为指定 IP
sudo tcpdump -i eth0 src 192.168.1.100
sudo tcpdump -i eth0 dst 192.168.1.100
```

### 抓取 TCP/UDP
```bash
# TCP
sudo tcpdump -i eth0 tcp -w tcp.pcap

# UDP
sudo tcpdump -i eth0 udp -w udp.pcap

# 组合条件
sudo tcpdump -i eth0 'tcp port 80 or udp port 53' -w net.pcap
```

---

## 3. Wireshark 过滤语法

### 捕获过滤器（抓包前）
```bash
# 语法：proto [expr:size]
tcp port 8080
host 192.168.1.100
net 192.168.1.0/24
```

### 显示过滤器（抓包后）

#### 按协议过滤
```
tcp
udp
icmp
http
dns
```

#### 按 IP 过滤
```
ip.addr == 192.168.1.100
ip.src == 192.168.1.100
ip.dst == 192.168.1.100
```

#### 按端口过滤
```
tcp.port == 8080
tcp.srcport == 80
udp.port == 53
```

#### 组合条件
```
# AND
ip.addr == 192.168.1.100 and tcp.port == 8080

# OR
http or dns

# NOT
!(tcp.port == 80)
```

#### 按包内容过滤
```
tcp contains "GET"        # TCP载荷包含 GET
http.request.uri contains "login"  # HTTP请求URI包含login
```

---

## 4. 常见协议分析

### TCP 三次握手
```
Frame 1: SYN                    192.168.1.10 -> 192.168.1.100
Frame 2: SYN-ACK               192.168.1.100 -> 192.168.1.10
Frame 3: ACK                    192.168.1.10 -> 192.168.1.100
```

### TCP 四次挥手
```
Frame N: FIN, ACK               -> 关闭连接
Frame N+1: ACK                  <- 确认关闭
Frame N+2: FIN, ACK             <- 关闭连接
Frame N+3: ACK                  -> 确认关闭
```

### HTTP 请求/响应
```
# HTTP 请求
Hypertext Transfer Protocol
    GET /index.html HTTP/1.1\r\n
    Host: example.com\r\n
    User-Agent: curl/7.68.0\r\n

# HTTP 响应
Hypertext Transfer Protocol
    HTTP/1.1 200 OK\r\n
    Content-Type: text/html\r\n
    Content-Length: 612\r\n
```

---

## 5. 常见问题分析

### 问题 1：连接重置（RST）

```
Flags: 0x14 (RST, ACK)
```

**原因**：
- 服务端端口未监听
- 防火墙拦截
- 连接超时

### 问题 2：大量重传（Retransmission）

```
TCP Retransmission
```

**原因**：
- 网络拥塞
- 丢包
- 对方接收缓冲区满

### 问题 3：TCP 窗口为 0

```
[TCP ZeroWindow]
```

**原因**：接收方处理速度跟不上，需要流量控制。

### 问题 4：抓包发现延迟

```
Time: 1.234567
```

**分析**：
1. 对比 `Time` 列
2. 看 SEQ/ACK 差值
3. 定位哪个环节慢

---

## 6. 实用技巧

### 导出特定包
```
# 导出 HTTP 对象
File -> Export Objects -> HTTP
```

### 追踪 TCP 流
```
右键 -> Follow -> TCP Stream
```

### 专家信息
```
Analyze -> Expert Information
查看警告和错误
```

### 统计信息
```
Statistics -> Summary
Statistics -> Conversations
Statistics -> Protocol Hierarchy
```

---

## 7. tcpdump 常用参数

| 参数 | 说明 |
|------|------|
| `-i` | 指定网卡 |
| `-n` | 不解析域名 |
| `-nn` | 不解析协议和端口 |
| `-v` | 详细输出 |
| `-c` | 抓取指定数量包 |
| `-s` | 指定抓取长度 |
| `-w` | 输出到文件 |
| `-r` | 读取文件 |

```bash
# 实战例子：抓取 HTTP 请求和响应
sudo tcpdump -i eth0 -nn -v 'tcp port 80 and (tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x47455420 or tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x48545450)'
```

---

## 总结

| 场景 | 命令/过滤器 |
|------|------------|
| 抓包保存 | `tcpdump -i eth0 -w file.pcap` |
| HTTP 分析 | `ip.addr == x.x.x.x and http` |
| TCP 连接 | `tcp.flags.syn == 1` |
| 错误分析 | `tcp.analysis.retransmission` |

> **调试原则**：先用 tcpdump 粗略抓包，确认问题方向，再用 Wireshark 精细分析。
