-- 追加标准标签；不重写已应用的历史迁移。

INSERT INTO standard_tags (tag_id, name, dimension, category, parent_id, description, status) VALUES ('PUB_TOPIC_0202', '犯罪小说', 'pub_topic', '文学与文化', NULL, '以犯罪行为、犯罪者、侦查或司法过程为核心的小说。', 'active'),
('PUB_TOPIC_0203', '科幻小说', 'pub_topic', '文学与文化', NULL, '以科学技术、科学假设或未来社会为重要基础的小说。', 'active'),
('PUB_TOPIC_0204', '心理小说', 'pub_topic', '文学与文化', NULL, '以人物心理活动、意识变化和内心冲突为主要描写对象的小说。', 'active');

INSERT OR IGNORE INTO standard_tag_aliases (tag_id, alias) VALUES ('PUB_FIELD_0050', '世界文学'),
('PUB_TOPIC_0089', '奇幻小说'),
('PUB_TOPIC_0098', '爱情小说'),
('PUB_TOPIC_0081', '现实主义小说');
