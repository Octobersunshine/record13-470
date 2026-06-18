const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_MAX_RULES = 100;
const DEFAULT_MAX_CONNECTIONS_PER_RULE = 100;
const DEFAULT_MAX_TOTAL_CONNECTIONS = 5000;

class PortForwarder extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rules = new Map();
    this.maxRules = options.maxRules ?? DEFAULT_MAX_RULES;
    this.maxConnectionsPerRule = options.maxConnectionsPerRule ?? DEFAULT_MAX_CONNECTIONS_PER_RULE;
    this.maxTotalConnections = options.maxTotalConnections ?? DEFAULT_MAX_TOTAL_CONNECTIONS;
    this.totalActiveConnections = 0;
  }

  setMaxRules(limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('maxRules 必须是大于 0 的整数');
    }
    this.maxRules = limit;
  }

  getMaxRules() {
    return this.maxRules;
  }

  setMaxConnectionsPerRule(limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('maxConnectionsPerRule 必须是大于 0 的整数');
    }
    this.maxConnectionsPerRule = limit;
  }

  getMaxConnectionsPerRule() {
    return this.maxConnectionsPerRule;
  }

  setMaxTotalConnections(limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('maxTotalConnections 必须是大于 0 的整数');
    }
    this.maxTotalConnections = limit;
  }

  getMaxTotalConnections() {
    return this.maxTotalConnections;
  }

  getStats() {
    return {
      ruleCount: this.rules.size,
      maxRules: this.maxRules,
      totalActiveConnections: this.totalActiveConnections,
      maxTotalConnections: this.maxTotalConnections,
      maxConnectionsPerRule: this.maxConnectionsPerRule
    };
  }

  _attachServerEvents(rule) {
    const { localPort, targetHost, targetPort } = rule;
    const server = net.createServer();
    rule.server = server;

    server.on('connection', (clientSocket) => {
      if (rule.status !== 'running') {
        clientSocket.destroy();
        return;
      }

      if (rule.activeConnections >= this.maxConnectionsPerRule) {
        this.emit('connectionRejected', {
          localPort,
          reason: 'perRuleLimit',
          active: rule.activeConnections,
          limit: this.maxConnectionsPerRule
        });
        clientSocket.destroy();
        return;
      }

      if (this.totalActiveConnections >= this.maxTotalConnections) {
        this.emit('connectionRejected', {
          localPort,
          reason: 'totalLimit',
          active: this.totalActiveConnections,
          limit: this.maxTotalConnections
        });
        clientSocket.destroy();
        return;
      }

      rule.activeConnections++;
      rule.totalConnections++;
      this.totalActiveConnections++;

      let clientBytes = 0;
      let targetBytes = 0;

      const targetSocket = net.connect({
        host: targetHost,
        port: targetPort
      });

      const cleanup = () => {
        clientSocket.destroy();
        targetSocket.destroy();
      };

      clientSocket.on('data', (chunk) => {
        clientBytes += chunk.length;
      });

      targetSocket.on('data', (chunk) => {
        targetBytes += chunk.length;
      });

      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);

      const handleClose = () => {
        if (rule.activeConnections > 0) rule.activeConnections--;
        if (this.totalActiveConnections > 0) this.totalActiveConnections--;
        rule.totalBytesTransferred += clientBytes + targetBytes;
        cleanup();
      };

      clientSocket.on('error', (err) => {
        this.emit('error', { localPort, error: err, side: 'client' });
        handleClose();
      });

      targetSocket.on('error', (err) => {
        this.emit('error', { localPort, error: err, side: 'target' });
        handleClose();
      });

      clientSocket.on('close', handleClose);
      targetSocket.on('close', handleClose);
    });

    server.on('error', (err) => {
      if (rule.status !== 'starting' && rule.status !== 'resuming') {
        this.emit('error', { localPort, error: err, side: 'server' });
      }
    });
  }

  createRule({ localPort, targetHost, targetPort, name }) {
    return new Promise((resolve, reject) => {
      if (this.rules.size >= this.maxRules) {
        return reject(new Error(`转发规则已达上限 (${this.rules.size}/${this.maxRules})，请先删除部分规则`));
      }

      if (this.rules.has(localPort)) {
        return reject(new Error(`端口 ${localPort} 已被占用`));
      }

      const rule = {
        id: `rule_${Date.now()}_${localPort}`,
        name: name || `转发 ${localPort} -> ${targetHost}:${targetPort}`,
        localPort,
        targetHost,
        targetPort,
        server: null,
        createdAt: new Date().toISOString(),
        status: 'starting',
        activeConnections: 0,
        totalConnections: 0,
        totalBytesTransferred: 0
      };

      this.rules.set(localPort, rule);
      this._attachServerEvents(rule);

      rule.server.listen(localPort, () => {
        rule.status = 'running';
        this.emit('created', this._serializeRule(rule));
        resolve(this._serializeRule(rule));
      });

      rule.server.once('error', (err) => {
        if (rule.status === 'starting') {
          this.rules.delete(localPort);
          reject(err);
        }
      });
    });
  }

  pauseRule(localPort) {
    return new Promise((resolve, reject) => {
      const rule = this.rules.get(localPort);
      if (!rule) {
        return reject(new Error(`未找到端口 ${localPort} 的转发规则`));
      }
      if (rule.status === 'paused') {
        return reject(new Error(`端口 ${localPort} 的转发规则已处于暂停状态`));
      }
      if (rule.status !== 'running') {
        return reject(new Error(`端口 ${localPort} 的转发规则当前状态 (${rule.status})，无法暂停`));
      }

      rule.status = 'pausing';
      rule.server.close(() => {
        rule.server = null;
        rule.status = 'paused';
        this.emit('paused', { localPort });
        resolve(this._serializeRule(rule));
      });

      rule.server.once('error', (err) => {
        rule.status = 'running';
        reject(err);
      });
    });
  }

  resumeRule(localPort) {
    return new Promise((resolve, reject) => {
      const rule = this.rules.get(localPort);
      if (!rule) {
        return reject(new Error(`未找到端口 ${localPort} 的转发规则`));
      }
      if (rule.status === 'running') {
        return reject(new Error(`端口 ${localPort} 的转发规则已处于运行状态`));
      }
      if (rule.status !== 'paused') {
        return reject(new Error(`端口 ${localPort} 的转发规则当前状态 (${rule.status})，无法启用`));
      }

      rule.status = 'resuming';
      this._attachServerEvents(rule);

      rule.server.listen(localPort, () => {
        rule.status = 'running';
        this.emit('resumed', this._serializeRule(rule));
        resolve(this._serializeRule(rule));
      });

      rule.server.once('error', (err) => {
        rule.status = 'paused';
        rule.server = null;
        reject(err);
      });
    });
  }

  deleteRule(localPort) {
    return new Promise((resolve, reject) => {
      const rule = this.rules.get(localPort);
      if (!rule) {
        return reject(new Error(`未找到端口 ${localPort} 的转发规则`));
      }

      rule.status = 'stopping';

      const finishDelete = () => {
        this.rules.delete(localPort);
        this.emit('deleted', { localPort });
        resolve({ success: true, localPort });
      };

      if (rule.server) {
        rule.server.close(finishDelete);
        rule.server.once('error', (err) => {
          if (this.rules.has(localPort)) {
            rule.status = rule.status === 'paused' ? 'paused' : 'running';
          }
          reject(err);
        });
      } else {
        finishDelete();
      }
    });
  }

  deleteAllRules() {
    return Promise.all(
      Array.from(this.rules.keys()).map(port => this.deleteRule(port))
    );
  }

  getRule(localPort) {
    const rule = this.rules.get(localPort);
    return rule ? this._serializeRule(rule) : null;
  }

  getAllRules() {
    return Array.from(this.rules.values()).map(rule => this._serializeRule(rule));
  }

  _serializeRule(rule) {
    return {
      id: rule.id,
      name: rule.name,
      localPort: rule.localPort,
      targetHost: rule.targetHost,
      targetPort: rule.targetPort,
      createdAt: rule.createdAt,
      status: rule.status,
      activeConnections: rule.activeConnections,
      totalConnections: rule.totalConnections,
      totalBytesTransferred: rule.totalBytesTransferred
    };
  }
}

module.exports = PortForwarder;
