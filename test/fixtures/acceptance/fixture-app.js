import http from 'node:http';

const port = Number(process.env.PORT || process.argv[2]);
const mode = process.env.FIXTURE_MODE || 'success';
const server = http.createServer((req, res) => {
  if (req.url === '/ready') return void res.end('ready');
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/api' });
    return void res.end();
  }
  if (req.url === '/large') return void res.end('x'.repeat(16_384));
  if (req.url === '/api') {
    res.setHeader('content-type', 'application/json');
    return void res.end(JSON.stringify({ ok: mode !== 'wrong', secret: 'token=fixture-secret' }));
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(
    `<title>Fixture</title><main><h1>${mode === 'broken-ui' ? 'Broken' : 'Ready'}</h1><button id="go">Go</button></main>`,
  );
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
