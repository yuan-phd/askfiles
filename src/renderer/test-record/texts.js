// Test build only (docs/test-build.md); askfiles-test-record-module. The test UI's texts in the
// two languages the notice is shown in. The notice is the owner's wording (test build brief, item 5).

export const TEXTS = {
  en: {
    noticeTitle: 'This is a test build',
    notice:
      'This test build records your questions and actions on this computer only. Nothing is uploaded. ' +
      'You decide whether to export and share the record. Installing the regular version removes the record.',
    continue: 'Continue',
    legend: 'Test record',
    export: 'Export test record',
    exportTitle: 'Export test record',
    exportNote: 'The file is saved on your Desktop. Choose what it contains.',
    exportQuestions: 'Questions only',
    exportFull: 'Questions with answers and sources',
    cancel: 'Cancel',
    pause: 'Pause recording',
    resume: 'Resume recording',
    clear: 'Clear the record',
    confirmClear: 'Delete everything recorded so far? This cannot be undone.',
    cleared: 'The record is empty.',
    status: (questions, events, paused) =>
      `${questions} ${questions === 1 ? 'question' : 'questions'} and ${events - questions} other ${events - questions === 1 ? 'action' : 'actions'} recorded.` +
      (paused ? ' Recording is paused.' : ''),
    exported: (name, browser) => `Saved "${name}" on your Desktop and showed it in ${browser}.`,
    failed: (message) => `That did not work: ${message}`,
    finder: 'Finder',
    explorer: 'File Explorer',
    about: 'Test build. It records your questions and actions on this computer only; see Settings, Test record.',
  },
  zh: {
    noticeTitle: '这是测试版',
    notice:
      '此测试版只在这台电脑上记录您的问题和操作。不会上传任何内容。' +
      '是否导出和分享这份记录由您决定。安装正式版会删除这份记录。',
    continue: '继续',
    legend: '测试记录',
    export: '导出测试记录',
    exportTitle: '导出测试记录',
    exportNote: '文件会保存到桌面。请选择文件包含的内容。',
    exportQuestions: '只含问题',
    exportFull: '问题以及回答和来源',
    cancel: '取消',
    pause: '暂停记录',
    resume: '继续记录',
    clear: '清除记录',
    confirmClear: '删除目前记录的全部内容？此操作无法撤销。',
    cleared: '记录已清空。',
    status: (questions, events, paused) =>
      `已记录 ${questions} 个问题和 ${events - questions} 个其他操作。` + (paused ? '记录已暂停。' : ''),
    exported: (name, browser) => `已将“${name}”保存到桌面，并在${browser}中显示。`,
    failed: (message) => `操作未成功：${message}`,
    finder: '访达',
    explorer: '文件资源管理器',
    about: '测试版。它只在这台电脑上记录您的问题和操作；见设置中的“测试记录”。',
  },
};
