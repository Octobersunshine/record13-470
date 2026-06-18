const net = require('net');
const { EventEmitter } = require('events');

class PortForwarder extends EventEmitter {
  constructor() {
    super();
    this.rules = new Map();
  }

  createRule({ localPort, targetHost, targetPort, name }) {
    return new Promise((resolve, reject) => {
      if (this.rules.has(localPort)) {
        return reject(new Error(`端口 ${localPort} 已被占用`));
      }

      const server = net.createServer((clientSocket) => {
        const targetSocket = net.connect({
          host: targetHost,
          port: targetPort
        });

        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);

        clientSocket.on('error', (err) => {
          this.emit('error', { localPort, error: err });
          targetSocket.destroy();
        });

        targetSocket.on('error', (err) => {
          this.emit('error', { localPort, error: err });
          clientSocket.destroy();
        });

        clientSocket.on('close', () => targetSocket.destroy());
        targetSocket.on('close', () => clientSocket.destroy());
      });

      server.listen(localPort, () => {
        const rule = {
          id: `rule_${Date.now()}_${localPort}`,
          name: name || `转发 ${localPort} -> ${targetHost}:${targetPort}`,
          localPort,
          targetHost,
          targetPort,
          server,
          createdAt: new Date().toISOString(),
          status: 'running'
        };
        this.rules.set(localPort, rule);
        this.emit('created', rule);
        resolve(this._serializeRule(rule));
      });

      server.on('error', (err) => {
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

      rule.server.close(() => {
        this.rules.delete(localPort);
        this.emit('deleted', { localPort });
        resolve({ success: true, localPort });
      });

      rule.server.on('error', (err) => reject(err));
    });
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
      status: rule.status
    };
  }
}

module.exports = PortForwarder;
