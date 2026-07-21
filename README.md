# LLM Manager

一个简洁的个人大模型管理工具，提供统一代理接口，支持模型自动切换、故障转移和用量统计。

## ✨ 特性

- 🤖 支持 OpenAI Chat Completions / Anthropic Messages / OpenAI Responses API 三种格式统一代理
- 🔄 故障自动转移：模型请求失败时自动切换到备用模型
- 🔒 模型锁定机制：失败模型自动锁定 10 分钟（时间可设置）
- 📊 实时 Token 用量追踪，按模型分组统计
- 🎨 支持多种 API 格式，自定义模型参数
- 🖱️ 拖拽排序模型优先级
- 🤝 **可在各种 Agent 工具中接入**，替代 `deepseek-copilot-bridge` 等工具，可直接在 **VSCode Copilot** 中接入使用

### 📌 模型调用策略

1. **优先调用**：优先使用指定的模型
2. **按序调用**：按拖拽排序的顺序依次尝试可用模型
3. **自动跳过**：调用时自动忽略锁定和禁用的模型
4. **故障转移**：遇到错误则锁定当前模型并切换到下一个模型

## 🚀 快速开始

![界面预览](imgs/image.png)

### 环境要求

- Node.js >= 22.0.0
- npm >= 10.0.0

### 安装

```bash
npm install -g ai-models-manager --verbose
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
ai-server clear     # 停止并删除 pm2 中的服务
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

### 模型卡片操作

- **锁定按钮**（🔒）：手动锁定模型，锁定期间该模型不会被调用。再次点击可解除锁定
- **禁用按钮**（⛔）：禁用模型，被禁用的模型完全不会参与调用，也不会显示在模型列表中
- **拖拽排序**：在模型列表中拖拽卡片可调整调用顺序，排在上面的模型优先级更高

### 🐳 Docker 部署

```bash
# 1. 创建 docker-compose.yml 文件（内容见下方）
# 2. 启动容器
docker compose up -d

# 3. 查看日志
docker compose logs -f

# 4. 停止容器
docker compose down
```

```yaml
# docker-compose.yml
services:
  ai-manager:
    image: node:24
    container_name: ai-manager
    ports:
      - "11888:11888"
    volumes:
      - ./data/models-manager:/root/.models-manager
    environment:
      - PORT=11888
    command: >
      sh -c "npm install ai-models-manager -g && cd /usr/local/lib/node_modules/ai-models-manager && node dist/app.js"
    restart: unless-stopped
```

> 直接使用 `node dist/app.js` 启动，无需 PM2，容器进程更稳定简洁。


### 📋 Nginx 反向代理配置（推荐）

在生产环境中，建议使用 **Nginx** 作为反向代理，提供 HTTPS、域名绑定和请求体大小限制等功能。

```nginx
# /etc/nginx/conf.d/ai-manager.conf
server {
    listen       80;
    server_name your-domain.com;  # 替换为你的域名

    # 请求体大小限制（根据实际需要调整，默认 1M，大模型部署建议设为 1G 或更大）
    client_max_body_size 1G;

    location / {
        proxy_pass http://127.0.0.1:11888/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **注意**：`client_max_body_size` 用于限制客户端请求体大小。部署大模型文件时，如果超出该限制会返回 **413 Request Entity Too Large** 错误。请根据实际部署文件大小适当调整。

如果使用 Docker 运行 Nginx，将上述配置文件挂载到容器内即可：

```yaml
# docker-compose.nginx.yml 示例
services:
  nginx:
    image: nginx:alpine
    container_name: nginx-proxy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d
      - ./nginx/ssl:/etc/nginx/ssl  # HTTPS 证书（可选）
    restart: unless-stopped
```


## 🌐 代理接口

在管理页面点击「查看接口」可查看完整的代理地址，每个接口地址按用户名隔离（如 `{origin}/{username}/...`）。

### OpenAI 兼容接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/v1/models` | GET | 获取可用模型列表 |
| `/v1/chat/completions` | POST | Chat Completions API（标准 OpenAI 格式） |
| `/v1/responses` | POST | Responses API（新版 OpenAI 格式） |
| `/v1/test` | GET | 模型连通性测试 |

### Anthropic 兼容接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/v1/messages` | POST | Messages API（Anthropic 标准格式） |
| `/v1/anthropic/messages` | POST | Messages API（Anthropic 标准路径别名） |
| `/v1/anthropic` | GET | Anthropic 代理信息，返回端点说明 |

> 💡 Anthropic 接口支持将 OpenAI 格式的模型自动转换为 Anthropic 格式，可直接作为 Claude API 代理使用。

### Ollama 兼容接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/tags` | GET | 获取模型列表 |
| `/api/show` | POST | 获取模型详情 |
| `/api/version` | GET | 版本信息 |

### Agent / IDE 接入

本工具可替代 `deepseek-copilot-bridge`，作为统一的 AI 模型代理网关，直接在以下场景中接入：

- **VSCode Copilot**：在 Copilot 设置中将 API Base URL 指向本服务地址（如 `http://localhost:11888/admin/v1`），即可将 Copilot 的模型请求统一代理到本工具管理的任意模型
- **Cursor / Windsurf** 等 AI IDE：同样通过配置 OpenAI 兼容端点地址即可使用
- **各类 Agent 框架**（LangChain、AutoGPT 等）：使用 OpenAI / Anthropic SDK 直接指向本服务即可

---

## 🧠 MCP（Model Context Protocol）接入

本工具为 **模型记忆** 和 **处置方案** 两大功能提供了 **MCP Streamable HTTP** 服务端，支持 AI 客户端（如 Claude Desktop）通过 MCP 协议直接读写记录。

### MCP 端点

| 功能 | 端点地址 | 说明 |
|------|----------|------|
| 模型记忆 | `POST /{username}/memory/mcp` | 读写用户/AI 记忆 |
| 处置方案 | `POST /{username}/skills/mcp` | 读写处置方案（解决方案） |
| 用户文档 | `POST /{username}/docs/mcp` | 读写用户文档 |

> 端点按用户名隔离，如需 API Key 鉴权，请在管理页面「查看接口」中设置。

### 在 Agent 中配置

```json
{
  "mcpServers": {
    "ai-models-manager-memory": {
      "type": "http",
      "url": "http://localhost:11888/admin/memory/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    },
    "ai-models-manager-skills": {
      "type": "http",
      "url": "http://localhost:11888/admin/skills/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    },
    "ai-models-manager-docs": {
      "type": "http",
      "url": "http://localhost:11888/admin/docs/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    }
  }
}
```

> 如果未设置 API Key，可省略 `headers` 字段。

### 使用示例

配置好后，在对话中直接对 AI 说即可：

**存储记忆**：「帮我使用模型记忆记住我喜欢深色主题」
→ AI 自动调用工具保存到「用户个人偏好」类别

**获取记忆**：「帮我在模型记忆中查询一下我喜欢的主题是什么」
→ AI 自动搜索记忆并返回结果

**记录处置方案**：「记录一下处置方案，下次遇到 Node 内存泄漏就这么排查」
→ AI 将步骤保存为处置方案，方便以后复用

**查询处置方案**：「之前处置方案记过 Node 内存泄漏的处理方法吗？」
→ AI 搜索并返回匹配的处置方案

**存储文档**：「帮我记录一下这份 API 设计文档到我的文档」
→ AI 将内容保存为我的文档，方便随时查阅

**查询文档**：「帮我从我的文档查一下我之前记录的 API 设计文档」
→ AI 搜索并返回匹配的我的文档

## 📄 License

ISC