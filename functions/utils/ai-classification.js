import { dbGet, dbRun, nowSec } from './db.js';
import { replaceTags } from './tags.js';

export const DEFAULT_AI_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const DEFAULT_DAILY_LIMIT = 10000;

const MODEL_RATES = {
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 4625, output: 30475 },
  '@cf/meta/llama-3.2-1b-instruct': { input: 2457, output: 18252 },
};

// 统一候选词，避免 AI 为同一类书生成多个近义标签。
export const BOOK_TAGS = [
  '文学', '小说', '科幻', '奇幻', '悬疑', '推理', '历史', '传记', '哲学', '心理学',
  '经济', '管理', '计算机', '医学', '教育', '艺术', '诗歌', '散文', '漫画', '儿童',
  '教材', '工具书', '语言学习', '其他',
];

export function dailyLimit(env) {
  const value = Number(env.AI_DAILY_LIMIT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAILY_LIMIT;
}

export function estimateNeurons(promptTokens, completionTokens, model = DEFAULT_AI_MODEL) {
  const rates = MODEL_RATES[model] || MODEL_RATES[DEFAULT_AI_MODEL];
  return (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000;
}

export async function classifyBook(env, bookId, { force = false } = {}) {
  const book = await dbGet(env, 'SELECT * FROM books WHERE id = ?', bookId);
  if (!book) throw new Error('书籍不存在');
  if (!env.AI) throw new Error('未配置 Workers AI 绑定');

  const current = await dbGet(env, 'SELECT * FROM ai_classifications WHERE book_id = ?', bookId);
  if (!force && current?.status === 'completed') return { skipped: true, bookId };
  const startedAt = nowSec();
  await dbRun(
    env,
    `INSERT INTO ai_classifications (book_id, status, updated_at)
     VALUES (?, 'processing', ?)
     ON CONFLICT(book_id) DO UPDATE SET status='processing', error='', updated_at=?`,
    bookId,
    startedAt,
    startedAt
  );

  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  try {
    const source = await lookupBook(book);
    const prompt = buildPrompt(book, source);
    const model = env.AI_MODEL || DEFAULT_AI_MODEL;
    const response = await env.AI.run(model, {
      messages: [
        { role: 'system', content: '你是中文私人书库整理助手，只输出符合要求的 JSON，不要输出解释。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.1,
      top_p: 0.2,
      response_format: { type: 'json_object' },
    });
    usage = normalizeUsage(response?.usage);
    const result = normalizeResult(responseText(response), book.title, book.author);
    await replaceTags(env, bookId, result.tags);
    await dbRun(
      env,
      `UPDATE books SET title=?, updated_at=? WHERE id=?`,
      result.title || book.title,
      nowSec(),
      bookId
    );
    await dbRun(
      env,
      `UPDATE ai_classifications SET status='completed', cleaned_title=?, tags_json=?, source=?, error='', updated_at=? WHERE book_id=?`,
      result.title || book.title,
      JSON.stringify(result.tags),
      source ? 'openlibrary' : 'metadata',
      nowSec(),
      bookId
    );
    await saveUsage(env, { bookId, model, usage, status: 'completed' });
    return { bookId, title: result.title || book.title, tags: result.tags, usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dbRun(
      env,
      `UPDATE ai_classifications SET status='failed', error=?, updated_at=? WHERE book_id=?`,
      message.slice(0, 500),
      nowSec(),
      bookId
    );
    await saveUsage(env, {
      bookId,
      model: env.AI_MODEL || DEFAULT_AI_MODEL,
      usage,
      status: 'failed',
      error: message,
    });
    throw error;
  }
}

async function saveUsage(env, { bookId, model, usage, status, error = '' }) {
  await dbRun(
    env,
    `INSERT INTO ai_usage
       (id, book_id, model, prompt_tokens, completion_tokens, neurons, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    bookId,
    model,
    usage.prompt_tokens,
    usage.completion_tokens,
    estimateNeurons(usage.prompt_tokens, usage.completion_tokens, model),
    status,
    error.slice(0, 500),
    nowSec()
  );
}

async function lookupBook(book) {
  const params = new URLSearchParams({ title: book.title || book.file_name, limit: '3' });
  if (book.author) params.set('author', book.author);
  try {
    const response = await fetch(`https://openlibrary.org/search.json?${params}&fields=title,author_name,publisher,subject,first_publish_year`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const data = await response.json();
      const doc = data.docs?.[0];
      if (doc) return {
        title: doc.title || '',
        authors: (doc.author_name || []).slice(0, 3),
        publishers: (doc.publisher || []).slice(0, 3),
        subjects: (doc.subject || []).slice(0, 8),
        year: doc.first_publish_year || '',
      };
    }
  } catch {
    // 书目服务不可用时，仍使用本地元数据完成分类。
  }
  return null;
}

function buildPrompt(book, source) {
  const payload = {
    title: book.title || book.file_name,
    author: book.author,
    publisher: book.publisher,
    isbn: book.isbn,
    filename: book.file_name,
    public_catalog: source,
  };
  return `整理下面这本书。只输出 JSON 对象，键必须是 title 和 tags，值必须替换为这本书的真实结果，禁止输出“清理后的书名”“标签1”等示例占位词。
JSON 结构：{"title":"实际书名","tags":["实际标签1","实际标签2","实际标签3"]}
规则：
1. 删除书名中的套装、上下册、全套、插图、珍藏版、精装版、电子版、扫描版、网盘版等版本或营销描述；不要删除真正的系列名或副标题。
2. tags 必须恰好 3 个，且只能从候选词中选择：${BOOK_TAGS.join('、')}。
3. 优先依据书名、作者、出版社和公开书目资料；无法确定时使用“其他”，不要编造具体事实。
4. title 只保留书名，不要包含作者名、文件扩展名或解释。
书目数据：${JSON.stringify(payload)}`;
}

function normalizeUsage(value) {
  return {
    prompt_tokens: Math.max(0, Number(value?.prompt_tokens) || 0),
    completion_tokens: Math.max(0, Number(value?.completion_tokens) || 0),
  };
}

function normalizeResult(text, fallbackTitle = '', author = '') {
  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*|\s*```$/gi, '')
    .trim();
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 返回的 JSON 无法解析');
    try {
      data = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new Error('AI 返回的 JSON 无法解析');
    }
  }
  const candidateTitle = String(data.title || '').trim();
  const title = isPlausibleTitle(candidateTitle, fallbackTitle, author)
    ? candidateTitle
    : cleanTitleFallback(fallbackTitle);
  const tags = [...new Set(Array.isArray(data.tags) ? data.tags.map((tag) => String(tag).trim()).filter((tag) => BOOK_TAGS.includes(tag)) : [])];
  for (const fallback of ['其他', '小说', '文学']) {
    if (tags.length >= 3) break;
    if (!tags.includes(fallback)) tags.push(fallback);
  }
  return { title, tags: tags.slice(0, 3) };
}

function isPlausibleTitle(candidate, original, author = '') {
  if (!candidate || /^(清理后的书名|书名|未知书名|未命名)$/i.test(candidate)) return false;
  const source = String(original || '').replace(/\.[^.]+$/, '').trim();
  if (!source) return true;
  if (author && candidate.includes(author.replace(/[（(].*$/, '').trim())) return false;
  const overlap = [...new Set(candidate.replace(/[^\p{L}\p{N}]/gu, ''))]
    .filter((char) => source.includes(char)).length;
  return overlap >= Math.min(2, candidate.length);
}

function cleanTitleFallback(title) {
  return String(title || '未命名')
    .replace(/\s*[（(\[][^）)\]]*(?:套装|上下册|全套|插图|珍藏|精装|电子版|扫描版|网盘)[^）)\]]*[）)\]]/gi, '')
    .replace(/\s*(?:套装|上下册|全套|插图珍藏版|珍藏版|精装版|电子版|扫描版|网盘版)\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || '未命名';
}

function responseText(response) {
  if (typeof response === 'string') return response;
  if (typeof response?.response === 'string') return response.response;
  const choice = response?.choices?.[0];
  return choice?.message?.content || choice?.text || '';
}
