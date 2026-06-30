import express, { Application, Request, Response, NextFunction } from 'express';
import path from 'path';
import morgan from 'morgan';
import usersRouter from './routes/users';
import settingsRouter from './routes/settings';
import modelsRouter from './routes/models';
import tokenStatsRouter from './routes/tokenStats';
import llmModelsRouter from './routes/llmModels';
import proxyRouter, { userRouter } from './routes/proxy';
import authRouter from './routes/auth';

const app: Application = express();
const PORT = process.env.PORT || 11888;

// CORS 中间件 - 支持跨域请求（包括流式响应）
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, OpenAI-Organization, OpenAI-Project');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type, X-Request-ID');
  
  // 处理预检请求
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

// API 路由
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/models', modelsRouter);
app.use('/api/token-stats', tokenStatsRouter);
app.use('/api/llm-models', llmModelsRouter);

// 服务端配置（供前端读取）
app.get('/api/config', (_req: Request, res: Response) => {
  res.json({ port: PORT });
});

// Proxy 代理路由（OpenAI/Ollama 兼容接口）
// 放在 API 路由之后、SPA fallback 之前
// 确保 /v1/* 和 /api/tags|show|version 不被 SPA fallback 拦截
app.use(proxyRouter);

// 用户名前缀的代理路由：/:username/v1/* 和 /:username/api/*
// 挂载到 /:username，Express 自动剥离 /:username 前缀，内部 router 收到 /v1/models
app.use('/:username', userRouter);

// 生产环境：托管前端静态文件
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// SPA fallback：所有非 API 路由返回 index.html（排除 /v1）
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
    return next();
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// 错误处理中间件
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error('错误:', err.message);
  // 响应已发出时，只能结束连接，不能再写状态码
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(500).send(JSON.stringify({ success: false, message: err.message || '服务器内部错误' }));
});

// 全局未捕获异常处理，防止进程崩溃
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`API 地址: http://localhost:${PORT}/api`);
  console.log(`代理接口: http://localhost:${PORT}/v1/models 等`);
});

export default app;
