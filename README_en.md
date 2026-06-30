# LLM Manager - AI Model Management Platform

A lightweight personal LLM management tool providing unified proxy interfaces with automatic failover and usage tracking. Users can customize model priority order — when the primary model fails due to quota limits, rate limits, or requires cooldown, the system automatically switches to the next model; models with errors are locked for 10 minutes, then unlocked and retried.

## Features

### 🤖 Model Proxy
- OpenAI Chat Completions API support
- Anthropic Messages API support
- OpenAI Responses API support
- Ollama compatible interface support
- Automatic failover: switch to backup model when request fails
- Model locking mechanism: failed models auto-lock for 10 minutes

### 📊 Usage Statistics
- Real-time token usage tracking
- Per-model statistics grouping
- Daily/Weekly/Monthly trend charts

### ⚙️ Flexible Configuration
- Multiple API format support
- Custom model parameters (max content length, max tokens)
- Model enable/disable control
- Drag-and-drop model sorting

### 🔧 Global Settings
- Unified max content length and max tokens settings
- Settings value > 0 overrides all model parameters
- Settings value = 0 uses model's own configuration

## Quick Start

### Requirements

- Node.js >= 18.0.0
- npm >= 9.0.0

### Port Configuration

- **Backend service port**: 11888
- **Frontend dev port**: 5173 (API requests proxied to 11888 in dev mode)
- Port can be modified via environment variable `PORT`

### Install Dependencies

```bash
npm install
```

### Development Mode

```bash
# Start both backend and frontend dev servers
npm run dev

# Start backend only
npm run dev:server

# Start frontend only
npm run dev:client
```

### Production Deployment

```bash
# 1. Build the project
npm run build

# 2. Start the service (using PM2)
ai-server start

# Or use npm script
npm start
```

## Usage

### CLI Commands

Install global command:
```bash
npm link
```

Available commands:
```bash
ai-server start     # Start service (4 instances)
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

### Global Settings

1. Click the "Settings" button in the header
2. Set max content length and max tokens
3. Click "Confirm" to save

**Note:**
- When value is 0, each model uses its own configuration
- When value is greater than 0, all models uniformly use the configured value

### Proxy Interfaces

After starting the service, the following proxy interfaces are available:

| Interface | Method | Description |
|-----------|--------|-------------|
| `/v1/models` | GET | Get model list |
| `/v1/chat/completions` | POST | Chat Completions interface |
| `/v1/responses` | POST | Responses interface |
| `/api/tags` | GET | Ollama model list |
| `/api/show` | POST | Ollama model details |
| `/api/version` | GET | Ollama version info |

## License

ISC