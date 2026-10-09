const fs = require('node:fs');

const source = fs.readFileSync('max_service/app.py', 'utf8');
for (const token of [
  'async def read_history(self, callback: Any) -> Any:',
  'return await self.read(callback, history=True)',
  'payload = await service.read_history(collect)',
]) {
  if (!source.includes(token)) throw new Error(`missing MAX history sidecar contract: ${token}`);
}
if (source.includes('history_lock') || source.includes('read_lock')) {
  throw new Error('MAX provider reads must not bypass the shared scheduler with a second lock');
}

console.log('max-history-sidecar-contract-ok');
