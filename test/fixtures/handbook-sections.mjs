// The handbook as the folder watcher will hand it to the server: one document per section, with
// section title, index and page range. Section 1 is longer than the 1000 character chunk size, so
// upstream splits it into sub-chunks that share the section keys and the page merges them.
const leave = [
  'Every employee of Northwind receives 27 days of paid annual leave per year.',
  'Leave is requested in the staff portal at least two weeks before the first day off.',
  'Requests for more than ten consecutive working days need the approval of the department head.',
  'Public holidays that fall within a period of annual leave do not count as leave days.',
  'Part-time employees receive annual leave in proportion to their contracted hours.',
  'New employees accrue annual leave from their first day at a rate of 2.25 days per full month.',
  'Leave cannot be taken during the first month of employment except for documented emergencies.',
  'Sick days during annual leave are converted back to leave days when a medical certificate is sent.',
  'Unused leave can be carried over until the end of March of the next year and then expires.',
  'Employees who leave the company are paid out for accrued annual leave that was not taken.',
  'Managers plan the team calendar so that at least half of each team is present in every week.',
  'Annual leave during the December closing week is mandatory and deducted from the allowance.',
  'Questions about the remaining allowance are answered by the human resources team within two days.',
].join(' ');

export const SECTION_DOCS = [
  {
    name: 'handbook-s1',
    sectionTitle: '1 Annual leave',
    sectionIndex: 1,
    pageStart: 1,
    pageEnd: 2,
    text: `1 Annual leave\n\n${leave}`,
  },
  {
    name: 'handbook-s2',
    sectionTitle: '2 Expense claims',
    sectionIndex: 2,
    pageStart: 3,
    pageEnd: 3,
    text: '2 Expense claims\n\nExpense claims are submitted through the finance portal within 30 days. Receipts above 50 euros must be attached as a scanned copy.',
  },
];
