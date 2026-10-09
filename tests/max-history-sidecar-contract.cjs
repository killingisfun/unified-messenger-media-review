const fs = require('node:fs');

const source = fs.readFileSync('max_service/app.py', 'utf8');
for (const token of [
  'self.history_lock = asyncio.Lock()',
  'async def read_history(self, callback: Any) -> Any:',
  'await asyncio.wait_for(self.history_lock.acquire(), timeout=MAX_HISTORY_QUEUE_TIMEOUT_SECONDS)',
  'return await self.read(callback, history=True)',
  'self.history_lock.release()',
  'payload = await service.read_history(collect)',
]) {
  if (!source.includes(token)) throw new Error(`missing MAX history sidecar contract: ${token}`);
}

console.log('max-history-sidecar-contract-ok');
