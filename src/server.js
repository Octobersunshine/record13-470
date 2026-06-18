const express = require('express');
const PortForwarder = require('./portForwarder');

const app = express();
const portForwarder = new PortForwarder();
const API_PORT = process.env.API_PORT || 3001;

app.use(express.json());

portForwarder.on('error', ({ localPort, error }) => {
  console.error(`[转发规则 ${localPort}] 错误:`, error.message);
});

app.post('/api/forward', async (req, res) => {
  try {
    const { localPort, targetHost, targetPort, name } = req.body;

    if (!localPort || !targetHost || !targetPort) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数: localPort, targetHost, targetPort'
      });
    }

    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      return res.status(400).json({
        success: false,
        message: 'localPort 必须是 1-65535 之间的整数'
      });
    }

    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({
        success: false,
        message: 'targetPort 必须是 1-65535 之间的整数'
      });
    }

    const rule = await portForwarder.createRule({
      localPort,
      targetHost,
      targetPort,
      name
    });

    res.json({
      success: true,
      data: rule,
      message: `转发规则已创建: ${localPort} -> ${targetHost}:${targetPort}`
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.delete('/api/forward/:localPort', async (req, res) => {
  try {
    const localPort = parseInt(req.params.localPort, 10);

    if (isNaN(localPort)) {
      return res.status(400).json({
        success: false,
        message: 'localPort 参数无效'
      });
    }

    await portForwarder.deleteRule(localPort);

    res.json({
      success: true,
      message: `转发规则已删除: 端口 ${localPort}`
    });
  } catch (err) {
    res.status(404).json({
      success: false,
      message: err.message
    });
  }
});

app.get('/api/forward/:localPort', (req, res) => {
  const localPort = parseInt(req.params.localPort, 10);

  if (isNaN(localPort)) {
    return res.status(400).json({
      success: false,
      message: 'localPort 参数无效'
    });
  }

  const rule = portForwarder.getRule(localPort);

  if (!rule) {
    return res.status(404).json({
      success: false,
      message: `未找到端口 ${localPort} 的转发规则`
    });
  }

  res.json({
    success: true,
    data: rule
  });
});

app.get('/api/forward', (req, res) => {
  const rules = portForwarder.getAllRules();

  res.json({
    success: true,
    data: rules,
    count: rules.length
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: '端口转发 API 服务运行正常',
    timestamp: new Date().toISOString(),
    activeRules: portForwarder.getAllRules().length
  });
});

const server = app.listen(API_PORT, () => {
  console.log(`========================================`);
  console.log(`  端口转发 API 服务已启动`);
  console.log(`  监听端口: ${API_PORT}`);
  console.log(`  健康检查: http://localhost:${API_PORT}/health`);
  console.log(`========================================`);
  console.log('');
  console.log('API 接口说明:');
  console.log('  POST   /api/forward       - 创建转发规则');
  console.log('  GET    /api/forward       - 获取所有转发规则');
  console.log('  GET    /api/forward/:port - 获取指定转发规则');
  console.log('  DELETE /api/forward/:port - 删除转发规则');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`错误: 端口 ${API_PORT} 已被占用，请通过环境变量 API_PORT 指定其他端口`);
    console.error(`示例: API_PORT=3002 npm start`);
  } else {
    console.error('服务器启动失败:', err.message);
  }
  process.exit(1);
});
