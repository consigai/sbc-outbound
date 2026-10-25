/* Minimal InfluxDB 1.x stand-in: answers SHOW DATABASES and /write, or accepts and hangs */
const http = require('http');

module.exports = (port, mode = 'ok') => new Promise((resolve, reject) => {
  const sockets = new Set();
  const state = {mode, writes: 0, points: 0, queries: 0, hung: 0, connections: 0};
  const srv = http.createServer((req, res) => {
    if (state.mode === 'hang') {
      state.hung++;
      return;
    }
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      if (req.url.startsWith('/write')) {
        state.writes++;
        state.points += body.split('\n').filter((l) => l.length).length;
        res.writeHead(204);
        return res.end();
      }
      state.queries++;
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({results: [{statement_id: 0, series: [{name: 'databases', columns: ['name'],
        values: [['cdrs'], ['alerts'], ['call_counts'], ['sp_call_counts'], ['app_call_counts']]}]}]}));
    });
  });
  srv.on('connection', (s) => {
    state.connections++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  srv.on('error', reject);
  srv.listen(port, '127.0.0.1', () => resolve({
    state,
    setMode: (m) => state.mode = m,
    close: () => new Promise((r) => {
      srv.close(() => r());
      sockets.forEach((s) => s.destroy());
    })
  }));
});
