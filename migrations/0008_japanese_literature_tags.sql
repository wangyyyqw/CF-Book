-- 追加标准标签；不重写已应用的历史迁移。

INSERT INTO standard_tags (tag_id, name, dimension, category, parent_id, description, status) VALUES ('PUB_FIELD_0111', '日本文学', 'pub_field', '文学与艺术', 'PUB_FIELD_0050', '日本文学作品、文学传统及相关研究。', 'active'),
('PUB_TOPIC_0201', '推理小说', 'pub_topic', '文学与文化', NULL, '以案件、线索推演、侦查或谜题解答为核心的小说。', 'active');

INSERT OR IGNORE INTO standard_tag_aliases (tag_id, alias) VALUES ('PUB_FIELD_0111', '日本小说'),
('PUB_TOPIC_0201', '侦探小说'),
('PUB_TOPIC_0201', '本格推理');
