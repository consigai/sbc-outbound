/* A minimal RESP server that fails over the way ElastiCache does (consigai/consig-cdk-jam#155).
 failover() turns every open connection into a connection to the demoted primary: writes get
 READONLY. New connections reach the new primary, as the primary endpoint's DNS name does after
 a failover. With closeAfterReadonly the server drops the connection after the READONLY reply,
 which ElastiCache does; Valkey itself keeps it open. Only the commands the tests use exist. */
const net = require('net');

const WRITES = new Set(['set', 'setex', 'del', 'zadd', 'zrem', 'zremrangebyscore', 'sadd', 'srem',
  'incr', 'decr', 'hset', 'hmset', 'expire', 'pexpire']);

const encode = (v) => {
  if (v === null || v === undefined) return '$-1\r\n';
  if (typeof v === 'number') return `:${v}\r\n`;
  if (Array.isArray(v)) return `*${v.length}\r\n${v.map(encode).join('')}`;
  return `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
};

/* returns [args, rest] for one complete RESP array, or null if more data is needed */
const parseCommand = (buf) => {
  if (buf.length === 0 || buf[0] !== 0x2a) return null;
  let pos = buf.indexOf('\r\n');
  if (pos < 0) return null;
  const count = parseInt(buf.slice(1, pos).toString(), 10);
  const args = [];
  pos += 2;
  for (let i = 0; i < count; i++) {
    const end = buf.indexOf('\r\n', pos);
    if (end < 0) return null;
    const len = parseInt(buf.slice(pos + 1, end).toString(), 10);
    if (buf.length < end + 2 + len + 2) return null;
    args.push(buf.slice(end + 2, end + 2 + len).toString());
    pos = end + 2 + len + 2;
  }
  return [args, buf.slice(pos)];
};

function createFakeValkey({closeAfterReadonly = false} = {}) {
  const state = {epoch: 0, store: new Map(), readonlyReplies: 0, applied: [], connections: 0, sockets: new Set()};

  const execute = (args) => {
    const [name, ...rest] = args;
    switch (name) {
      case 'ping': return '+PONG\r\n';
      case 'info': return encode('# Server\r\nredis_version:8.0.1\r\n# Replication\r\nrole:master\r\nloading:0\r\n');
      case 'client': case 'select': return '+OK\r\n';
      case 'get': return encode(state.store.has(rest[0]) ? state.store.get(rest[0]) : null);
      case 'zscan': return encode(['0', []]);
      case 'smembers': return encode([]);
      case 'set': state.store.set(rest[0], rest[1]); return '+OK\r\n';
      case 'setex': state.store.set(rest[0], rest[2]); return '+OK\r\n';
      default: return WRITES.has(name) ? ':1\r\n' : encode(null);
    }
  };

  const server = net.createServer((socket) => {
    const epoch = state.epoch;
    let buf = Buffer.alloc(0);
    state.connections++;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      let parsed;
      while ((parsed = parseCommand(buf))) {
        const [args] = parsed;
        buf = parsed[1];
        args[0] = args[0].toLowerCase();
        if (epoch < state.epoch && WRITES.has(args[0])) {
          state.readonlyReplies++;
          socket.write('-READONLY You can\'t write against a read only replica.\r\n');
          if (closeAfterReadonly) return socket.end();
          continue;
        }
        if (WRITES.has(args[0])) state.applied.push({epoch: state.epoch, command: args[0]});
        socket.write(execute(args));
      }
    });
  });

  return {
    state,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    failover: () => { state.epoch++; },
    close: () => new Promise((resolve) => {
      state.sockets.forEach((s) => s.destroy());
      server.close(resolve);
    }),
  };
}

module.exports = createFakeValkey;
