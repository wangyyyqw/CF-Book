export const TAG_CATEGORIES = [
  { key: 'topic', label: '题材' },
  { key: 'genre', label: '体裁' },
  { key: 'subject', label: '学科' },
  { key: 'content', label: '内容' },
  { key: 'audience', label: '受众' },
  { key: 'style', label: '风格' },
  { key: 'other', label: '其他' },
];

export const TAG_CATEGORY_LABELS = Object.fromEntries(TAG_CATEGORIES.map((item) => [item.key, item.label]));
export const TAG_CATEGORY_ORDER = TAG_CATEGORIES.map((item) => item.key);

const TAG_GROUPS = {
  topic: ['科幻', '奇幻', '武侠', '仙侠', '言情', '悬疑', '推理', '惊悚', '恐怖', '冒险', '历史小说', '战争', '社会派', '反乌托邦', '末世', '穿越', '都市', '校园', '职场'],
  genre: ['文学', '小说', '诗歌', '散文', '随笔', '戏剧', '童话', '寓言', '纪实文学', '传记', '回忆录', '漫画', '教材', '工具书'],
  subject: ['历史', '哲学', '心理学', '经济', '管理', '计算机', '编程', '医学', '教育', '艺术', '法律', '政治', '社会学', '人类学', '宗教', '科普', '军事', '地理', '建筑', '摄影', '音乐', '设计', '数学', '物理', '化学', '生物', '工程', '语言学习'],
  content: ['成长', '家庭', '女性'],
  audience: ['儿童', '青少年', '考试'],
  style: ['现实主义'],
  other: ['其他'],
};

export const BOOK_TAGS = TAG_CATEGORIES.flatMap(({ key }) => TAG_GROUPS[key]);
export const GENERIC_TAGS = new Set(['文学', '小说', '其他']);

const TAG_CATEGORY_BY_NAME = Object.fromEntries(
  Object.entries(TAG_GROUPS).flatMap(([category, names]) => names.map((name) => [name, category]))
);

// 图书馆主题词和小说站常用词统一映射到书库标准标签，不直接把外部自由标签写入 D1。
export const EXTERNAL_TAG_ALIASES = {
  'science fiction': '科幻', 'sci-fi': '科幻', 'fantasy': '奇幻', wuxia: '武侠', 'martial arts': '武侠',
  xianxia: '仙侠', cultivation: '仙侠', romance: '言情', 'romance novel': '言情', thriller: '惊悚',
  mystery: '悬疑', detective: '推理', 'crime fiction': '推理', horror: '恐怖', adventure: '冒险',
  'historical fiction': '历史小说', 'war fiction': '战争', dystopia: '反乌托邦', dystopian: '反乌托邦',
  'post-apocalyptic': '末世', apocalyptic: '末世', 'time travel': '穿越', transmigration: '穿越',
  'urban fiction': '都市', 'campus novel': '校园', 'workplace fiction': '职场', 'historical novel': '历史小说',
  history: '历史', historical: '历史', biography: '传记', memoir: '回忆录', philosophy: '哲学',
  psychology: '心理学', economics: '经济', finance: '经济', management: '管理', business: '管理',
  programming: '编程', coding: '编程', computer: '计算机', software: '计算机', medicine: '医学',
  medical: '医学', education: '教育', textbook: '教材', law: '法律', legal: '法律', politics: '政治',
  political: '政治', sociology: '社会学', anthropology: '人类学', religion: '宗教', theology: '宗教',
  military: '军事', 'popular science': '科普', comics: '漫画', manga: '漫画', children: '儿童',
  juvenile: '儿童', 'young adult': '青少年', teen: '青少年', 'language learning': '语言学习',
  poetry: '诗歌', poem: '诗歌', drama: '戏剧', play: '戏剧', 'fairy tale': '童话', essays: '散文',
  essay: '散文', literature: '文学', classic: '文学', fiction: '小说', '纪实': '纪实文学', reportage: '纪实文学', nonfiction: '纪实文学',
  '现实主义': '现实主义', '诡秘': '奇幻', '哈利·波特': '奇幻', '哈利波特': '奇幻', '选集': '纪实文学', '人类简史': '历史',
};

export function tagCategory(name) {
  return TAG_CATEGORY_BY_NAME[name] || 'other';
}

export function tagCategoryLabel(category) {
  return TAG_CATEGORY_LABELS[category] || TAG_CATEGORY_LABELS.other;
}
