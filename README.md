# LLM Manager

一个简洁的个人大模型管理工具，提供统一代理接口，支持模型自动切换、故障转移和用量统计。

## ✨ 特性

- 🤖 支持 OpenAI Chat Completions / Anthropic Messages / OpenAI Responses API
- 🔄 故障自动转移：模型请求失败时自动切换到备用模型
- 🔒 模型锁定机制：失败模型自动锁定 10 分钟
- 📊 实时 Token 用量追踪，按模型分组统计
- 🎨 支持多种 API 格式，自定义模型参数
- 🖱️ 拖拽排序模型优先级

## 🚀 快速开始

![界面预览](imgs/image.png)

### 环境要求

- Node.js >= 22.0.0
- npm >= 10.0.0

### 安装

```bash
npm install -g ai-models-manager
```

### 启动服务

```bash
# 启动服务（默认端口 11888）
ai-server start
```

### 访问地址

- **模型管理页面**: http://localhost:11888

### 默认账号

- **用户名**: `admin`
- **密码**: `admin`

> 首次登录后请及时修改密码！

## 📖 使用方法

### CLI 命令

```bash
ai-server start     # 启动服务
ai-server stop      # 停止服务
ai-server restart   # 重启服务
ai-server status    # 查看状态
ai-server logs      # 查看日志
```

### 添加模型

1. 点击顶部「添加」按钮
2. 选择供应商或选择「自定义」
3. 填写 Base URL 和 API Key
4. 在模型列表中添加模型配置
5. 点击「提交」保存

> 💡 **模型配置参数参考**: [https://models.dev/api.json](https://models.dev/api.json)

### 全局设置

1. 点击顶部「设置」按钮
2. 设置最大内容长度和最大 Token
3. 点击「确定」保存

> 值为 0 时，各模型使用自身配置；值大于 0 时，统一使用此处设置的数值

## 🌐 代理接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/v1/models` | GET | 获取模型列表 |
| `/v1/chat/completions` | POST | Chat Completions 接口 |
| `/v1/responses` | POST | Responses 接口 |
| `/api/tags` | GET | Ollama 模型列表 |
| `/api/show` | POST | Ollama 模型详情 |
| `/api/version` | GET | Ollama 版本信息 |

## 📄 License

ISC