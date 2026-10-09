import { dbGet, dbRun, nowSec } from './db.js';
import { replaceTags } from './tags.js';
import { BOOK_TAGS, EXTERNAL_TAG_ALIASES, GENERIC_TAGS, tagCategory } from './tag-catalog.js';

export const DEFAULT_AI_MODEL = '@cf/meta/llama-3.2-3b-instruct';
export const DEFAULT_DAILY_LIMIT = 10000;
export const MAX_AI_ATTEMPTS = 2;

const MODEL_RATES = {
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 4625, output: 30475 },
  '@cf/meta/llama-3.2-1b-instruct': { input: 2457, output: 18252 },
  '@cf/meta/llama-3.2-3b-instruct': { input: 4625, output: 30475 },
};

export { BOOK_TAGS } from './tag-catalog.js';

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
  if (!force && Number(current?.attempts || 0) >= MAX_AI_ATTEMPTS) {
    throw new Error('AI 分类重试次数已达上限');
  }
  const attempts = Number(current?.attempts || 0) + 1;
  const startedAt = nowSec();
  await dbRun(
    env,
    `INSERT INTO ai_classifications (book_id, status, attempts, updated_at)
     VALUES (?, 'processing', ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET status='processing', attempts=?, error='', updated_at=?`,
    bookId,
    attempts,
    startedAt,
    attempts,
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
      top_k: 20,
      response_format: { type: 'json_object' },
    });
    usage = normalizeUsage(response?.usage);
    const result = normalizeResult(responseText(response), book.title, book.author, source);
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
3. 优先依据书名、作者、出版社和公开书目资料；优先选择具体题材或学科标签，只有无法判断时才使用“文学”“小说”“其他”，不要编造具体事实。
4. title 只保留书名，不要包含作者名、文件扩展名或解释。
书目数据：${JSON.stringify(payload)}`;
}

function normalizeUsage(value) {
  return {
    prompt_tokens: Math.max(0, Number(value?.prompt_tokens ?? value?.input_tokens ?? value?.promptTokens) || 0),
    completion_tokens: Math.max(0, Number(value?.completion_tokens ?? value?.output_tokens ?? value?.completionTokens) || 0),
  };
}

export function normalizeResult(text, fallbackTitle = '', author = '', source = null) {
  const data = parseJsonObject(text);
  const candidateTitle = String(data.title || '').trim();
  const title = isPlausibleTitle(candidateTitle, fallbackTitle, author)
    ? cleanTitleFallback(candidateTitle)
    : cleanTitleFallback(fallbackTitle);
  const inferredTags = inferTags(fallbackTitle, source, author);
  const aiTags = Array.isArray(data.tags)
    ? data.tags.map((tag) => String(tag).trim()).filter((tag) => BOOK_TAGS.includes(tag))
    : [];
  const tags = [...new Set([...inferredTags, ...aiTags])];
  const specific = tags.filter((tag) => !GENERIC_TAGS.has(tag));
  const generic = tags.filter((tag) => GENERIC_TAGS.has(tag));
  const ordered = [];
  for (const tag of [...specific, ...generic]) {
    if (!ordered.some((item) => tagCategory(item) === tagCategory(tag))) ordered.push(tag);
  }
  for (const fallback of ['其他', '小说', '文学']) {
    if (ordered.length >= 3) break;
    if (!ordered.includes(fallback)) ordered.push(fallback);
  }
  return { title, tags: ordered.slice(0, 3) };
}

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  const candidates = [text];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(text.slice(start, end + 1));
        break;
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 继续尝试下一个完整 JSON 对象，兼容思考文本和 Markdown 包裹。
    }
  }
  throw new Error('AI 返回的 JSON 无法解析');
}

function inferTags(title, source, author = '') {
  const values = [title, author, ...(source?.subjects || [])].join(' ').toLowerCase();
  const inferred = [];
  if (['金庸', '古龙', '梁羽生', '武侠', 'wuxia', 'martial arts'].some((keyword) => values.includes(keyword))) inferred.push('武侠');
  for (const [alias, tag] of Object.entries(EXTERNAL_TAG_ALIASES)) {
    if (values.includes(alias.toLowerCase())) inferred.push(tag);
  }
  if (values.includes('魔法') || values.includes('wizard') || values.includes('哈利·波特') || values.includes('诡秘')) inferred.push('奇幻');
  if (values.includes('science') && !values.includes('science fiction')) inferred.push('科普');
  return [...new Set(inferred)];
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
  if (response?.response && typeof response.response === 'object') return response.response;
  if (typeof response?.result?.response === 'string') return response.result.response;
  const choice = response?.choices?.[0];
  return choice?.message?.content || choice?.text || '';
}
