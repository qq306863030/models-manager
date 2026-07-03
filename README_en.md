# LLM Manager

A lightweight LLM management tool providing unified proxy interfaces with automatic failover and usage tracking.

## ✨ Features

- 🤖 OpenAI Chat Completions / Anthropic Messages / OpenAI Responses API support
- 🔄 Automatic failover: switch to backup model when request fails
- 🔒 Model locking mechanism: failed models auto-lock for 10 minutes
- 📊 Real-time token usage tracking with per-model statistics
- 🎨 Multiple API format support with custom model parameters
- 🖱️ Drag-and-drop model priority sorting

## 🚀 Quick Start

![Interface Preview](imgs/image.png)

### Requirements

- Node.js >= 22.0.0
- npm >= 10.0.0

### Install

```bash
npm install -g ai-models-manager
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

## 🌐 Proxy Interfaces

| Interface | Method | Description |
|-----------|--------|-------------|
| `/v1/models` | GET | Get model list |
| `/v1/chat/completions` | POST | Chat Completions interface |
| `/v1/responses` | POST | Responses interface |
| `/api/tags` | GET | Ollama model list |
| `/api/show` | POST | Ollama model details |
| `/api/version` | GET | Ollama version info |

## 📄 License

ISC