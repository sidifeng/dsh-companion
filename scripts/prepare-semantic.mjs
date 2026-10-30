import { resolve } from 'node:path';
import { loadEmbeddingModel, EMBEDDING_KEY } from '../src/embedding-model.js';
const directory = resolve(process.argv[2] || '.local/runtime/models');
console.log(`准备本机语义模型：${EMBEDDING_KEY}`);
const pipe = await loadEmbeddingModel(directory, true);
const result = await pipe(['我喜欢在山里徒步', '平时爱去爬山'], { pooling: 'mean', normalize: true });
console.log(JSON.stringify({ directory, dimensions: result.dims, ready: true }));
await pipe.dispose();
