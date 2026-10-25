/*
 * Child process for test/time-series/index.js. Reproduces consigai/outbound#795 with the
 * production config (commitSize 50, timer flush) and NO unhandledRejection handler, so Node's
 * default behavior applies: any unhandled rejection exits the process with code 1.
 * usage: node outage.js <refused|hang> <port>
 */
const fakeInflux = require('./fake-influx');
const [mode, port] = [process.argv[2], parseInt(process.argv[3])];
const warnings = [];
const logger = {
  info: () => {}, debug: () => {}, error: () => {},
  warn: (obj, msg) => warnings.push({code: obj.err && (obj.err.code || obj.err.message), msg})
};
const cdr = () => ({direction: 'inbound', host: '10.0.0.1', trunk: 'sqm', service_provider_sid: 'sp',
  account_sid: 'acct', answered: true, attempted_at: Date.now(), duration: 1, sip_status: 200});

(async() => {
  const influx = await fakeInflux(port);
  const ts = require('../../lib/time-series')(logger, {
    host: '127.0.0.1', port, commitSize: 50, commitInterval: 3, requestTimeout: 1000
  });
  ts.writeCdrs(cdr()).catch(() => process.exit(2));
  await new Promise((r) => setTimeout(r, 3500)); // first timer flush succeeds and initializes the db
  if (influx.state.points !== 1) process.exit(3);

  if (mode === 'hang') influx.setMode('hang'); // accepts the connection, never answers
  else await influx.close(); // ECS replaced the task: old address refuses connections

  ts.writeCdrs(cdr()).catch(() => process.exit(2));
  ts.writeCallCount({service_provider_sid: 'sp', account_sid: 'acct', calls_in_progress: 1})
    .catch(() => process.exit(2));
  await new Promise((r) => setTimeout(r, 4500)); // next timer flush fails against the dead influx
  console.log(JSON.stringify({survived: true, warnings}));
  process.exit(0);
})();
