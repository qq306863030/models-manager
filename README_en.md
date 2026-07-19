# LLM Manager

A lightweight LLM management tool providing unified proxy interfaces with automatic failover and usage tracking.

## ✨ Features

- 🤖 Unified proxy for OpenAI Chat Completions / Anthropic Messages / OpenAI Responses API
- 🔄 Automatic failover: switch to backup model when request fails
- 🔒 Model locking mechanism: failed models auto-lock for 10 minutes (configurable)
- 📊 Real-time token usage tracking with per-model statistics
- 🎨 Multiple API format support with custom model parameters
- 🖱️ Drag-and-drop model priority sorting
- 🤝 **Integrates with various Agent tools**, replaces `deepseek-copilot-bridge`, can be directly used in **VSCode Copilot**

### 📌 Model Calling Strategy

1. **Priority Call**: Prefer to use the specified model
2. **Sequential Call**: Try available models in drag-and-drop order
3. **Auto Skip**: Automatically skip locked and disabled models during calls
4. **Failover**: Lock current model on error and switch to the next model

## 🚀 Quick Start

![Interface Preview](imgs/image.png)

### Requirements

- Node.js >= 22.0.0
- npm >= 10.0.0

### Install

```bash
npm install -g ai-models-manager --verbose
```

### Start Service

```bash
# Start service (default port 11888)
ai-server start
```

### Access URLs

- **Model Management Page**: http://localhost:11888

### Default Account

- **Username**: `admin`
- **Password**: `admin`

> Please change the password after first login!

## 📖 Usage

### CLI Commands

```bash
ai-server start     # Start service
ai-server stop      # Stop service
ai-server restart   # Restart service
ai-server status    # Check status
ai-server logs      # View logs
ai-server clear     # Stop and remove the server from pm2
```

### Add Model

1. Click the "Add" button in the header
2. Select a vendor or choose "Custom"
3. Fill in Base URL and API Key
4. Add model configurations in the model list
5. Click "Submit" to save

> 💡 **Model Configuration Parameters Reference**: [https://models.dev/api.json](https://models.dev/api.json)

### Global Settings

1. Click the "Settings" button in the header
2. Set max content length and max tokens
3. Click "Confirm" to save

> When value is 0, each model uses its own configuration; when value is greater than 0, all models uniformly use the configured value

### Model Card Operations

- **Lock Button** (🔒): Manually lock a model. Locked models will not be called. Click again to unlock
- **Disable Button** (⛔): Disable a model. Disabled models will not participate in any calls and will not appear in the model list
- **Drag-and-Drop Sorting**: Drag cards in the model list to adjust call order, models higher up have higher priority

### 🐳 Docker Deployment

```bash
# 1. Create docker-compose.yml (see content below)
# 2. Start the container
docker compose up -d

# 3. View logs
docker compose logs -f

# 4. Stop the container
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

> Uses `node dist/app.js` directly, no PM2 needed — simpler and more stable for container deployment.


### 📋 Nginx Reverse Proxy Configuration (Recommended)

In production environments, it's recommended to use **Nginx** as a reverse proxy for HTTPS, domain binding, and request body size limiting.

```nginx
# /etc/nginx/conf.d/ai-manager.conf
server {
    listen       80;
    server_name your-domain.com;  # Replace with your domain

    # Request body size limit (adjust as needed, default is 1M, recommend 1G or larger for large model deployment)
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

> **Note**: `client_max_body_size` limits the client request body size. If exceeded during deployment, Nginx returns a **413 Request Entity Too Large** error. Adjust according to your actual deployment file size.

If running Nginx with Docker, mount the configuration file into the container:

```yaml
# docker-compose.nginx.yml example
services:
  nginx:
    image: nginx:alpine
    container_name: nginx-proxy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d
      - ./nginx/ssl:/etc/nginx/ssl  # HTTPS certificates (optional)
    restart: unless-stopped
```


## 🌐 Proxy Interfaces

Click "View API" on the management page to see the full proxy addresses. Each user gets isolated endpoints (e.g. `{origin}/{username}/...`).

### OpenAI Compatible Interfaces

| Interface | Method | Description |
|-----------|--------|-------------|
| `/v1/models` | GET | Get available model list |
| `/v1/chat/completions` | POST | Chat Completions API (standard OpenAI format) |
| `/v1/responses` | POST | Responses API (new OpenAI format) |
| `/v1/test` | GET | Model connectivity test |

### Anthropic Compatible Interfaces

| Interface | Method | Description |
|-----------|--------|-------------|
| `/v1/messages` | POST | Messages API (Anthropic standard format) |
| `/v1/anthropic/messages` | POST | Messages API (Anthropic standard path alias) |
| `/v1/anthropic` | GET | Anthropic proxy info and endpoint documentation |

> 💡 Anthropic interfaces support automatic conversion from OpenAI format models, allowing direct use as a Claude API proxy.

### Ollama Compatible Interfaces

| Interface | Method | Description |
|-----------|--------|-------------|
| `/api/tags` | GET | Get model list |
| `/api/show` | POST | Get model details |
| `/api/version` | GET | Version info |

### Agent / IDE Integration

This tool replaces `deepseek-copilot-bridge` as a unified AI model proxy gateway for:

- **VSCode Copilot**: Set API Base URL to this service (e.g. `http://localhost:11888/admin/v1`) to proxy all Copilot model requests through managed models
- **Cursor / Windsurf** and other AI IDEs: Configure OpenAI-compatible endpoint address to use
- **Various Agent frameworks** (LangChain, AutoGPT, etc.): Point OpenAI/Anthropic SDK directly to this service

## 📄 License

ISC