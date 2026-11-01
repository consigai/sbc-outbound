/* consigai/consig-cdk-jam#155: a Valkey failover must not fail writes or leave a client on the demoted primary */
const test = require('tape');
const fs = require('fs');
const path = require('path');
const createFakeValkey = require('./fake-valkey');
const {reconnectOnError, followFailover} = require('../../lib/redis-failover');

const ROOT = path.join(__dirname, '..', '..');
const noop = () => {};
const makeLogger = () => {
  const warnings = [];
  return {warnings, info: noop, debug: noop, error: noop, warn: (obj, msg) => warnings.push({obj, msg})};
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the same helpers the service uses, pointed at the fake */
const connect = async(fake, port, {follow = true} = {}) => {
  const logger = makeLogger();
  const helpers = require('@jambonz/realtimedb-helpers')({host: '127.0.0.1', port}, logger);
  if (follow) followFailover(helpers.client, logger);
  await helpers.client.ping();
  return {...helpers, logger};
};

test('reconnectOnError: reconnect and resend on READONLY and LOADING only', (t) => {
  t.equal(reconnectOnError(new Error('READONLY You can\'t write against a read only replica.')), 2);
  t.equal(reconnectOnError(new Error('LOADING Redis is loading the dataset in memory')), 2);
  t.equal(reconnectOnError(new Error('WRONGTYPE Operation against a key holding the wrong kind of value')), false);
  t.equal(reconnectOnError(new Error('ERR unknown command')), false);
  t.equal(reconnectOnError(new Error('MOVED READONLY')), false, 'matches the error code, not any mention');
  t.equal(reconnectOnError({}), false);
  t.end();
});

for (const closeAfterReadonly of [false, true]) {
  const flavor = closeAfterReadonly ? 'ElastiCache (drops the connection)' : 'Valkey (keeps the connection)';

  test(`failover, ${flavor}: the write is resent to the new primary and later writes never see READONLY`,
    async(t) => {
      const fake = createFakeValkey({closeAfterReadonly});
      const port = await fake.listen();
      const {client, addKey, logger} = await connect(fake, port);
      try {
        t.equal(await addKey('before', 'x', 60), 'OK', 'write before the failover');
        fake.failover();
        t.equal(await addKey('during', 'x', 60), 'OK', 'write that hits the demoted primary still succeeds');
        t.equal(fake.state.readonlyReplies, 1, 'exactly one READONLY reply');
        t.ok(logger.warnings.some((w) => w.obj.command === 'set'), 'the reconnect is logged with the command');
        for (let i = 0; i < 5; i++) await addKey(`after${i}`, 'x', 60);
        t.equal(fake.state.readonlyReplies, 1, 'no READONLY after the reconnect');
        t.equal(fake.state.applied.filter((w) => w.epoch === 1).length, 6, 'every later write reached the new primary');
        t.equal(client.status, 'ready');
      } finally {
        client.disconnect();
        await fake.close();
      }
      t.end();
    });
}

test('failover, Valkey: without followFailover the client stays on the demoted primary (Oct 31 behavior)',
  async(t) => {
    const fake = createFakeValkey();
    const port = await fake.listen();
    const {client} = await connect(fake, port, {follow: false});
    try {
      fake.failover();
      for (let i = 0; i < 3; i++) {
        await client.setex(`k${i}`, 60, 'x').then(() => t.fail('write succeeded'),
          (err) => t.ok(err.message.startsWith('READONLY'), `write ${i + 1} rejected with READONLY`));
      }
      await sleep(50);
      t.equal(fake.state.connections, 1, 'never reconnected');
    } finally {
      client.disconnect();
      await fake.close();
    }
    t.end();
  });

test('every client the service creates follows a failover', (t) => {
  const sources = [];
  const walk = (dir) => fs.readdirSync(dir, {withFileTypes: true}).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) sources.push(p);
  });
  walk(path.join(ROOT, 'lib'));
  sources.push(path.join(ROOT, 'app.js'));
  let creates = 0;
  for (const file of sources) {
    const src = fs.readFileSync(file, 'utf8');
    const made = (src.match(/require\('@jambonz\/(realtimedb-helpers|speech-utils)'\)\(/g) || []).length;
    const followed = (src.match(/followFailover\(/g) || []).length;
    creates += made;
    if (made) t.ok(followed >= made, `${path.relative(ROOT, file)}: ${made} client(s), ${followed} followFailover call(s)`);
  }
  t.ok(creates > 0, `found ${creates} Redis client(s)`);
  t.end();
});
