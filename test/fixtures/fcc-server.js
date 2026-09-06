import { createServer } from 'node:http';

const [port, token, behavior = 'ready'] = process.argv.slice(2);
if (behavior === 'exit') process.exit(7);
const server = createServer((req, res) => {
  if (behavior === 'hang') return;
  if (req.url === '/health') res.end('{"status":"healthy"}');
  else if (req.url === '/v1/messages' && req.method === 'HEAD') {
    res
      .writeHead(
        behavior === 'no-auth' || req.headers.authorization === `Bearer ${token}` ? 204 : 401,
      )
      .end();
  } else res.writeHead(404).end();
});
server.listen(Number(port), '127.0.0.1');
process.stdin.once('data', () => server.close(() => process.exit(0)));
process.stdin.once('end', () => server.close(() => process.exit(0)));
