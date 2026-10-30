import { resolve } from 'node:path';
export const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
export const EMBEDDING_KEY = `${EMBEDDING_MODEL}@${EMBEDDING_REVISION}:q8:mean:384`;
export async function loadEmbeddingModel(directory, download = false) {
  const { AutoTokenizer, AutoModel, FeatureExtractionPipeline, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = download;
  const options = { revision: EMBEDDING_REVISION,
    cache_dir: directory, local_files_only: !download, dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } };
  // 显式加载避免 pipeline 的组件探测忽略 revision/cache_dir，确保离线使用固定模型。
  const modelPath = download ? EMBEDDING_MODEL : resolve(directory, EMBEDDING_MODEL, EMBEDDING_REVISION).replaceAll('\\', '/');
  const [tokenizer, model] = await Promise.all([AutoTokenizer.from_pretrained(modelPath, options), AutoModel.from_pretrained(modelPath, options)]);
  return new FeatureExtractionPipeline({ task: 'feature-extraction', tokenizer, model });
}
