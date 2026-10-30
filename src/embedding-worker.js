import { parentPort, workerData } from 'node:worker_threads';
import { loadEmbeddingModel } from './embedding-model.js';
const pipe = await loadEmbeddingModel(workerData.directory);
parentPort.postMessage({ ready: true });
let queue = Promise.resolve();
parentPort.on('message', ({ id, texts }) => {
  queue = queue.then(async () => {
    try {
      const output = await pipe(texts, { pooling: 'mean', normalize: true, truncation: true, max_length: 256 });
      parentPort.postMessage({ id, vectors: output.tolist() });
    } catch { parentPort.postMessage({ id, error: 'EMBEDDING_FAILED' }); }
  });
});
