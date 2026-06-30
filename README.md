# LLM Manager - AI 模型管理平台

一个简洁的个人大模型管理工具，提供统一代理接口，支持模型自动切换、故障转移和用量统计。用户可自定义模型排序，优先调用指定模型，失败后按序自动切换；模型报错时自动锁定 10 分钟，解锁后重新尝试。

## 功能特性

### 🤖 模型代理
- 支持 OpenAI Chat Completions API
- 支持 Anthropic Messages API
- 支持 OpenAI Responses API
- 支持 Ollama 兼容接口
- 故障自动转移：模型请求失败时自动切换到备用模型
- 模型锁定机制：失败模型自动锁定 10 分钟

### 📊 使用统计
- 实时 Token 用量追踪
- 按模型分组统计
- 日/周/月趋势图表

### ⚙️ 灵活配置
- 支持多种 API 格式
- 自定义模型参数（最大内容长度、最大 Token）
- 模型启用/禁用控制
- 模型拖拽排序

### 🔧 全局设置
- 统一设置最大内容长度和最大 Token
- 设置值 > 0 时覆盖所有模型的对应参数
- 设置值为 0 时使用模型自身配置

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0

### 端口说明

- **后端服务端口**: 11888
- **前端开发端口**: 5173（开发模式自动代理 API 到 11888）
- 端口可通过环境变量 `PORT` 修改

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
# 同时启动后端和前端开发服务器
npm run dev

# 仅启动后端
npm run dev:server

# 仅启动前端
npm run dev:client
```

### 生产部署

```bash
# 1. 构建项目
npm run build

# 2. 启动服务（使用 PM2）
ai-server start

# 或者使用 npm 脚本
npm start
```

## 使用方法

### CLI 命令

安装全局命令：
```bash
npm link
```

可用命令：
```bash
ai-server start     # 启动服务（4个实例）
ai-server stop      # 停止服务
ai-server restart   # 重启服务
ai-server status    # 查看运行状态
ai-server logs      # 查看日志
```

### 添加模型

1. 点击顶部「添加」按钮
2. 选择供应商或选择「自定义」
3. 填写 Base URL 和 API Key
4. 在模型列表中添加模型配置
5. 点击「提交」保存

### 全局设置

1. 点击顶部「设置」按钮
2. 设置最大内容长度和最大 Token
3. 点击「确定」保存

**说明：**
- 值为 0 时，各模型使用自身的配置数值
- 值大于 0 时，所有模型将统一使用此处设置的数值

### 代理接口

服务启动后提供以下代理接口：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/v1/models` | GET | 获取模型列表 |
| `/v1/chat/completions` | POST | Chat Completions 接口 |
| `/v1/responses` | POST | Responses 接口 |
| `/api/tags` | GET | Ollama 模型列表 |
| `/api/show` | POST | Ollama 模型详情 |
| `/api/version` | GET | Ollama 版本信息 |

## License

ISC
