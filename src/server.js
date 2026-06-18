const express = require('express');
const PortForwarder = require('./portForwarder');

const app = express();
const API_PORT = process.env.API_PORT || 3001;
const MAX_RULES = parseInt(process.env.MAX_RULES, 10) || 100;
const MAX_CONN_PER_RULE = parseInt(process.env.MAX_CONN_PER_RULE, 10) || 100;
const MAX_TOTAL_CONN = parseInt(process.env.MAX_TOTAL_CONN, 10) || 5000;

const portForwarder = new PortForwarder({
  maxRules: MAX_RULES,
  maxConnectionsPerRule: MAX_CONN_PER_RULE,
  maxTotalConnections: MAX_TOTAL_CONN
});

app.use(express.json());

portForwarder.on('error', ({ localPort, error, side }) => {
  const sideLabel = side ? `[${side}]` : '';
  console.error(`[转发规则 ${localPort}]${sideLabel} 错误:`, error.message);
});

portForwarder.on('connectionRejected', ({ localPort, reason, active, limit }) => {
  const reasonText = reason === 'perRuleLimit' ? '单规则连接数上限' : '全局连接数上限';
  console.warn(`[转发规则 ${localPort}] 连接被拒绝 (${reasonText}): ${active}/${limit}`);
});

portForwarder.on('created', (rule) => {
  console.info(`[转发规则] 已创建: ${rule.localPort} -> ${rule.targetHost}:${rule.targetPort}`);
});

portForwarder.on('deleted', ({ localPort }) => {
  console.info(`[转发规则] 已删除: 端口 ${localPort}`);
});

portForwarder.on('paused', ({ localPort }) => {
  console.info(`[转发规则] 已暂停: 端口 ${localPort}`);
});

portForwarder.on('resumed', (rule) => {
  console.info(`[转发规则] 已启用: ${rule.localPort} -> ${rule.targetHost}:${rule.targetPort}`);
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

    if (typeof targetHost !== 'string' || targetHost.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'targetHost 必须是非空字符串'
      });
    }

    const rule = await portForwarder.createRule({
      localPort,
      targetHost,
      targetPort,
      name
    });

    res.status(201).json({
      success: true,
      data: rule,
      message: `转发规则已创建: ${localPort} -> ${targetHost}:${targetPort}`,
      limits: portForwarder.getStats()
    });
  } catch (err) {
    const isLimitError = err.message.includes('已达上限');
    res.status(isLimitError ? 429 : 500).json({
      success: false,
      message: err.message,
      limits: isLimitError ? portForwarder.getStats() : undefined
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
      message: `转发规则已删除: 端口 ${localPort}`,
      limits: portForwarder.getStats()
    });
  } catch (err) {
    res.status(404).json({
      success: false,
      message: err.message
    });
  }
});

app.delete('/api/forward', async (req, res) => {
  try {
    await portForwarder.deleteAllRules();
    res.json({
      success: true,
      message: '所有转发规则已删除',
      limits: portForwarder.getStats()
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.post('/api/forward/:localPort/pause', async (req, res) => {
  try {
    const localPort = parseInt(req.params.localPort, 10);

    if (isNaN(localPort)) {
      return res.status(400).json({
        success: false,
        message: 'localPort 参数无效'
      });
    }

    const rule = await portForwarder.pauseRule(localPort);

    res.json({
      success: true,
      data: rule,
      message: `转发规则已暂停: 端口 ${localPort}`
    });
  } catch (err) {
    const isConflict = err.message.includes('已处于') || err.message.includes('状态') || err.message.includes('无法');
    const statusCode = err.message.includes('未找到') ? 404 : (isConflict ? 409 : 500);
    res.status(statusCode).json({
      success: false,
      message: err.message
    });
  }
});

app.post('/api/forward/:localPort/resume', async (req, res) => {
  try {
    const localPort = parseInt(req.params.localPort, 10);

    if (isNaN(localPort)) {
      return res.status(400).json({
        success: false,
        message: 'localPort 参数无效'
      });
    }

    const rule = await portForwarder.resumeRule(localPort);

    res.json({
      success: true,
      data: rule,
      message: `转发规则已启用: 端口 ${localPort}`
    });
  } catch (err) {
    const isConflict = err.message.includes('已处于') || err.message.includes('状态') || err.message.includes('无法');
    const statusCode = err.message.includes('未找到') ? 404 : (isConflict ? 409 : 500);
    res.status(statusCode).json({
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
    count: rules.length,
    limits: portForwarder.getStats()
  });
});

app.get('/api/stats', (req, res) => {
  const rules = portForwarder.getAllRules();
  const stats = portForwarder.getStats();

  const totalBytes = rules.reduce((sum, r) => sum + r.totalBytesTransferred, 0);
  const totalConnections = rules.reduce((sum, r) => sum + r.totalConnections, 0);

  res.json({
    success: true,
    data: {
      ...stats,
      totalConnectionsHandled: totalConnections,
      totalBytesTransferred: totalBytes
    }
  });
});

app.put('/api/config/limits', (req, res) => {
  try {
    const { maxRules, maxConnectionsPerRule, maxTotalConnections } = req.body;
    const changes = [];

    if (maxRules !== undefined) {
      portForwarder.setMaxRules(maxRules);
      changes.push(`maxRules=${maxRules}`);
    }

    if (maxConnectionsPerRule !== undefined) {
      portForwarder.setMaxConnectionsPerRule(maxConnectionsPerRule);
      changes.push(`maxConnectionsPerRule=${maxConnectionsPerRule}`);
    }

    if (maxTotalConnections !== undefined) {
      portForwarder.setMaxTotalConnections(maxTotalConnections);
      changes.push(`maxTotalConnections=${maxTotalConnections}`);
    }

    if (changes.length === 0) {
      return res.status(400).json({
        success: false,
        message: '未提供任何可配置参数: maxRules, maxConnectionsPerRule, maxTotalConnections'
      });
    }

    res.json({
      success: true,
      message: `已更新限制: ${changes.join(', ')}`,
      limits: portForwarder.getStats()
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err.message
    });
  }
});

app.get('/api/config/limits', (req, res) => {
  res.json({
    success: true,
    data: portForwarder.getStats()
  });
});

app.get('/health', (req, res) => {
  const stats = portForwarder.getStats();
  const ruleUsage = stats.maxRules > 0 ? Math.round((stats.ruleCount / stats.maxRules) * 100) : 0;
  const connUsage = stats.maxTotalConnections > 0 ? Math.round((stats.totalActiveConnections / stats.maxTotalConnections) * 100) : 0;

  res.json({
    success: true,
    message: '端口转发 API 服务运行正常',
    timestamp: new Date().toISOString(),
    limits: stats,
    usage: {
      rulesPercent: ruleUsage,
      connectionsPercent: connUsage
    }
  });
});

const server = app.listen(API_PORT, () => {
  const stats = portForwarder.getStats();
  console.log(`========================================`);
  console.log(`  端口转发 API 服务已启动`);
  console.log(`  监听端口: ${API_PORT}`);
  console.log(`  健康检查: http://localhost:${API_PORT}/health`);
  console.log(`----------------------------------------`);
  console.log(`  资源限制配置:`);
  console.log(`    - 最大规则数: ${stats.maxRules}`);
  console.log(`    - 单规则最大连接数: ${stats.maxConnectionsPerRule}`);
  console.log(`    - 全局最大连接数: ${stats.maxTotalConnections}`);
  console.log(`========================================`);
  console.log('');
  console.log('API 接口说明:');
  console.log('  POST   /api/forward              - 创建转发规则');
  console.log('  GET    /api/forward              - 获取所有转发规则');
  console.log('  GET    /api/forward/:port        - 获取指定转发规则');
  console.log('  DELETE /api/forward/:port        - 删除转发规则');
  console.log('  DELETE /api/forward              - 删除所有转发规则');
  console.log('  POST   /api/forward/:port/pause  - 暂停转发规则');
  console.log('  POST   /api/forward/:port/resume - 启用转发规则');
  console.log('  GET    /api/stats                - 全局统计信息');
  console.log('  GET    /api/config/limits        - 获取当前资源限制');
  console.log('  PUT    /api/config/limits        - 修改资源限制');
  console.log('  GET    /health                   - 健康检查');
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
