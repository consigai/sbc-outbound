/* consigai/outbound#795: a failed InfluxDB write must never crash the SBC process */
const test = require('tape');
const path = require('path');
const {execFile} = require('child_process');
const fakeInflux = require('./fake-influx');
const createTimeSeries = require('../../lib/time-series');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeLogger = () => {
  const warnings = [];
  const noop = () => {};
  return {warnings, info: noop, debug: noop, error: noop, warn: (obj, msg) => warnings.push({obj, msg})};
};
const cdr = () => ({direction: 'inbound', host: '10.0.0.1', trunk: 'sqm', service_provider_sid: 'sp',
  account_sid: 'acct', answered: true, attempted_at: Date.now(), duration: 1, sip_status: 200});
const runOutage = (mode, port) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(__dirname, 'outage.js'), mode, port], {timeout: 30000},
    (err, stdout, stderr) => resolve({code: err ? err.code : 0, stdout, stderr}));
});

test('time-series: influx refusing connections after a task replacement does not exit the process', async(t) => {
  const {code, stdout, stderr} = await runOutage('refused', 18611);
  t.equal(code, 0, `process survived (stderr: ${stderr.slice(0, 300)})`);
  const out = JSON.parse(stdout.trim().split('\n').pop());
  t.ok(out.warnings.some((w) => w.code === 'ECONNREFUSED'), 'ECONNREFUSED logged at warn');
  t.end();
});

test('time-series: influx that accepts and hangs times out without exiting the process', async(t) => {
  const {code, stdout, stderr} = await runOutage('hang', 18612);
  t.equal(code, 0, `process survived (stderr: ${stderr.slice(0, 300)})`);
  const out = JSON.parse(stdout.trim().split('\n').pop());
  t.ok(out.warnings.some((w) => /timed out/i.test(w.code)), 'request timeout logged at warn');
  t.end();
});

test('time-series: writers resolve while influx is down, then recover on new connections', async(t) => {
  const port = 18613;
  const logger = makeLogger();
  const ts = createTimeSeries(logger, {host: '127.0.0.1', port, commitSize: 1, requestTimeout: 500});

  await ts.writeCdrs(cdr());
  await ts.writeAlerts({alert_type: ts.AlertType.ACCOUNT_CALL_LIMIT, service_provider_sid: 'sp',
    account_sid: 'acct', count: 1});
  t.pass('writes resolved with influx down at startup');
  t.ok(logger.warnings.length >= 2, 'failures logged at warn');

  await sleep(11000); // let the influx client's host backoff (max 10s) expire
  const influx = await fakeInflux(port);
  await ts.writeCdrs(cdr());
  await ts.writeCdrs(cdr());
  await ts.writeCallCount({service_provider_sid: 'sp', account_sid: 'acct', calls_in_progress: 2});
  t.equal(influx.state.writes, 3, 'writes succeed once influx is back');
  t.ok(influx.state.connections >= 4, 'each request opens a new connection (no stale pooled socket)');
  await influx.close();
  t.end();
});

test('time-series: buffer is capped while influx is unreachable', async(t) => {
  const logger = makeLogger();
  const ts = createTimeSeries(logger, {host: '127.0.0.1', port: 18614, commitSize: 100, maxBuffer: 3});
  for (let i = 0; i < 5; i++) await ts.writeCdrs(cdr());
  t.ok(logger.warnings.some((w) => /buffer full/.test(w.msg)), 'dropped points are logged');
  t.end();
});
