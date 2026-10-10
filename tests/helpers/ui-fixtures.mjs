// 响应式验收只使用虚构数据，不读取账号、密钥或生产书目。
export const uiUser = { id: 'ui-admin', username: 'admin', display_name: '测试管理员', role: 'admin' };

export const uiDimensions = [
  ['book_type', '书籍类型'], ['pub_field', '出版书-学科/领域'],
  ['pub_topic', '出版书-主题/内容'], ['web_genre', '网文-题材'], ['web_element', '网文-情节设定'],
].map(([dimension, name_zh]) => ({ dimension, name_zh, description: '' }));

export const uiTags = uiDimensions.flatMap(({ dimension }, group) =>
  Array.from({ length: 6 }, (_, index) => ({
    tag_id: `${dimension.toUpperCase()}_${String(index + 1).padStart(4, '0')}`,
    name: dimension === 'book_type' ? ['出版书', '网文'][index % 2] : ['历史', '文学', '旅行', '科幻', '漫画', '自然'][index],
    dimension,
    category: '内容分类',
    description: '用于测试布局的标签定义。',
    parent_id: null,
    status: index === 5 ? 'disabled' : 'active',
    usage_count: index % 3,
    count: index % 3,
    aliases: index === 0 ? [`别名${group}`, 'alias_without_breaks_'.repeat(8)] : [],
  })));

export const uiShelves = Array.from({ length: 5 }, (_, index) => ({
  id: `shelf-${index}`, name: ['待读', '旅行阅读', '家庭成员推荐', '待补封面与待人工确认', '漫画收藏'][index],
  scope: index < 3 ? 'shared' : 'personal', owner: index < 3 ? '' : uiUser.username, book_count: 6,
}));

export const uiBooks = Array.from({ length: 36 }, (_, index) => ({
  id: `book-${index}`, title: ['山河之间', '长夜书简', '海风与旅人', '时间的纹理', '自然与万物', '城市漫游'][index % 6],
  author: ['林远', '周南', '陈野'][index % 3], description: '虚构书目，仅用于布局与交互验收。',
  format: 'epub', file_size: 536870912, file_name: 'a_very_long_filename_'.repeat(12) + '.epub',
  upload_id: `upload-${index}`, publisher: '示例出版社', isbn: '', language: '中文',
  cover: index % 5 === 0 ? '' : `/__ui__/cover-${index % 6}.svg`,
  tag_details: [uiTags[0], uiTags[6], uiTags[12]],
  my_rating: 8, my_status: index % 3 === 0 ? 'reading' : 'unread', my_favorite: index % 4 === 0,
  rating_avg: 8.5, rating_count: index % 3, ratings: [], shelf_ids: ['shelf-0'],
}));

export const uiUploads = ['completed', 'completed', 'active', 'aborted'].map((status, index) => ({
  upload_id: `upload-${index}`, filename: 'unbroken_filename_'.repeat(15) + `${index}.epub`,
  total_size: 536870912, total_chunks: 32, uploaded_chunks: status === 'completed' ? 32 : 7, status,
}));

export const uiUploadTasks = ['completed', 'failed', 'paused'].map((status, index) => ({
  id: `task-${index}`, uploadId: `upload-${index}`, filename: uiUploads[index].filename, status,
  size: 536870912, totalBytes: 536870912, uploadedBytes: status === 'completed' ? 536870912 : 117440512,
  chunkSize: 16777216, totalChunks: 32, doneChunks: status === 'completed' ? 32 : 7,
  failedChunks: status === 'failed' ? [8, 11] : [], hasCover: index !== 0,
  meta: { author: index === 0 ? '' : '示例作者', description: '示例简介' },
  verify: status === 'completed' ? { checked: true, total: 32, ok: 32, bad: 0 } : null,
  error: status === 'failed' ? '分块传输失败，请稍后重试。' : '',
  createdAt: 1791580000000 + index, updatedAt: 1791580000000 + index,
}));

export function uiApiResponse(path, query, pagePath) {
  if (path === '/api/auth/me') return {
    ok: true,
    user: pagePath.startsWith('/login') ? null : uiUser,
    needsSetup: false,
    multiUser: true,
    userCount: pagePath.startsWith('/login') ? undefined : 2,
  };
  if (path === '/api/books') {
    const limit = Number(query.get('limit')) || 18;
    const offset = Number(query.get('offset')) || 0;
    const rows = uiBooks.filter((book) => !query.get('q') || book.title.includes(query.get('q')));
    return { ok: true, books: rows.slice(offset, offset + limit), total: rows.length, hasMore: offset + limit < rows.length };
  }
  if (/^\/api\/books\/[^/]+$/.test(path)) return {
    ok: true, book: {
      ...uiBooks[1],
      title: 'long_unbroken_book_title_'.repeat(10),
      author: 'author_'.repeat(12),
      my_comment: '这是我的阅读笔记，用于验收评论文本域与展示布局。'.repeat(2),
      ratings: [
        { user_id: uiUser.id, username: uiUser.username, display_name: uiUser.display_name,
          rating: 8.5, status: 'reading', is_favorite: 1, comment: '很值得一读的书，细节丰富。' },
        { user_id: 'ui-member', username: 'member', display_name: '家庭成员',
          rating: 7, status: 'read', is_favorite: 0, comment: 'comment_without_breaks_'.repeat(6) },
      ],
      rating_avg: 7.8, rating_count: 2,
    },
  };
  if (path === '/api/tags/admin') return { ok: true, dimensions: uiDimensions, tags: uiTags };
  if (path === '/api/tags') return {
    ok: true, untaggedCount: 2,
    dimensions: uiDimensions.map((item) => ({ ...item, tags: uiTags.filter((tag) => tag.dimension === item.dimension) })),
  };
  if (path === '/api/shelves') return { ok: true, shelves: uiShelves };
  if (path === '/api/library/facets') return {
    ok: true,
    tags: {
      untaggedCount: 2,
      dimensions: uiDimensions.map((item) => ({
        ...item,
        tags: uiTags.filter((tag) => tag.dimension === item.dimension),
      })),
    },
    shelves: uiShelves,
  };
  if (path === '/api/upload/list') return { ok: true, uploads: uiUploads };
  if (path === '/api/users') return { ok: true, users: [uiUser, {
    id: 'ui-member', username: 'a_very_long_username_without_breaks', display_name: '家庭成员', role: 'member', disabled: 0,
  }] };
  if (path === '/api/ai/provider') return { ok: true, configured: false, format: 'openai', baseUrl: '', model: '' };
  if (path === '/api/ai/classify') return {
    ok: true, usedNeurons: 1800, dailyLimit: 10000, requests: 10, completed: 8, failed: 2, pending: 12, totalBooks: 36,
  };
  if (path === '/api/backup/preview') return {
    ok: true, createdAt: 1791580000, total: 60,
    summary: { books: { incoming: 36, current: 36 }, chunks: { incoming: 24, current: 24 } },
  };
  if (path === '/api/library/stats') return {
    ok: true,
    totals: { books: 36, size: 19327352832 },
    formats: [{ name: 'epub', count: 30, size: 16106127360 }, { name: '', count: 6, size: 3221225472 }],
    languages: [{ name: '中文', count: 30, size: 16106127360 }, { name: '', count: 6, size: 3221225472 }],
    tags: uiTags.filter((tag) => tag.status === 'active').map((tag, index) => ({
      tag_id: tag.tag_id, name: tag.name, dimension: tag.dimension,
      count: (index % 4) + 1, size: ((index % 4) + 1) * 536870912,
    })),
  };
  return { ok: true };
}
