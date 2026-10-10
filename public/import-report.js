// 批量上传结束后的导入报告：统计结果并支持按类别筛选任务。
// 纯函数模块，便于在 Node 里测试。

export const REPORT_FILTERS = [
  { key: '', label: '全部' },
  { key: 'completed', label: '成功' },
  { key: 'failed', label: '失败' },
  { key: 'missing-cover', label: '缺少封面' },
  { key: 'incomplete-meta', label: '元数据不完整' },
];

// 缺少作者或简介的书需要人工补充元数据
export function isMetadataIncomplete(meta) {
  if (!meta) return true;
  return !String(meta.author || '').trim() || !String(meta.description || '').trim();
}

export function matchesFilter(task, filter) {
  switch (filter) {
    case 'completed':
      return task.status === 'completed';
    case 'failed':
      return task.status === 'failed';
    case 'missing-cover':
      return task.status === 'completed' && task.hasCover === false;
    case 'incomplete-meta':
      return task.status === 'completed' && isMetadataIncomplete(task.meta);
    default:
      return true;
  }
}

export function buildImportReport(tasks) {
  const report = { total: tasks.length, completed: 0, failed: 0, missingCover: 0, incompleteMeta: 0 };
  for (const task of tasks) {
    if (task.status === 'completed') report.completed += 1;
    if (task.status === 'failed') report.failed += 1;
    if (matchesFilter(task, 'missing-cover')) report.missingCover += 1;
    if (matchesFilter(task, 'incomplete-meta')) report.incompleteMeta += 1;
  }
  return report;
}
