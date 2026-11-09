// An invented library for the large-library graph (docs/graph.md, Large libraries): by default 900
// browse documents of a made-up water cooperative in nested folders, with headings drawn from
// shared, department and folder pools so the documents link the way a real library does: mostly
// within a department, some across. Everything here is invented (CLAUDE.md rule 10). Deterministic
// from the seed; nothing is written to disk.
//
// The browse helpers are passed in, so the vitest tests use src/main and the Playwright specs
// dist/main: inventLibrary({ normalizeHeading, documentId }).

/** mulberry32, as src/main/graph/layout.ts. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON = [
  'Purpose',
  'Scope',
  'Definitions',
  'Responsibilities',
  'Review and Approval',
  'Related Documents',
  'Contacts',
  'Revision History',
];

/** First-level subfolders of the linked folder, their share of the documents, nested folders and topics. */
const DEPARTMENTS = [
  {
    name: 'Finance',
    weight: 9,
    sub: ['2023/Budgets', '2024/Budgets', '2025/Budgets', '2024/Audits', '2025/Audits'],
    topics: [
      'Capital Budget',
      'Operating Budget',
      'Tariff Review',
      'Cash Flow Forecast',
      'Internal Audit',
      'Asset Register',
    ],
    headings: [
      'Budget Summary',
      'Revenue Assumptions',
      'Operating Costs',
      'Capital Programme',
      'Reserves',
      'Variance Analysis',
      'Audit Findings',
      'Management Response',
      'Depreciation',
      'Debt Service',
      'Grant Income',
      'Tariff Structure',
      'Sensitivity Analysis',
      'Approval Thresholds',
    ],
  },
  {
    name: 'Facilities',
    weight: 7,
    sub: ['North Depot', 'South Depot', 'Head Office'],
    topics: ['Depot Maintenance', 'Fire Safety Plan', 'Cleaning Schedule', 'Vehicle Fleet', 'Building Inspection'],
    headings: [
      'Site Layout',
      'Inspection Checklist',
      'Maintenance Schedule',
      'Fire Exits',
      'Emergency Lighting',
      'Waste Storage',
      'Vehicle Checks',
      'Key Holders',
      'Contractor Access',
      'Defect Reporting',
      'Heating and Ventilation',
      'Accessibility',
    ],
  },
  {
    name: 'People',
    weight: 8,
    sub: ['Policies', 'Onboarding', 'Reviews/2024', 'Reviews/2025'],
    topics: [
      'Leave Policy',
      'Flexible Working',
      'Induction Pack',
      'Performance Review',
      'Code of Conduct',
      'Overtime Rules',
    ],
    headings: [
      'Eligibility',
      'Annual Leave',
      'Sick Leave',
      'Working Hours',
      'Probation',
      'Objectives',
      'Training Needs',
      'Grievances',
      'Disciplinary Steps',
      'Expenses',
      'Equal Opportunities',
      'Wellbeing Support',
      'Notice Periods',
    ],
  },
  {
    name: 'Procurement',
    weight: 7,
    sub: ['Tenders/2024', 'Tenders/2025', 'Contracts', 'Suppliers'],
    topics: [
      'Pipe Supply Tender',
      'Chemicals Framework',
      'Meter Contract',
      'Supplier Assessment',
      'Purchase Order Guide',
    ],
    headings: [
      'Specification',
      'Evaluation Criteria',
      'Award Decision',
      'Contract Value',
      'Payment Terms',
      'Delivery Schedule',
      'Warranty',
      'Insurance',
      'Conflicts of Interest',
      'Supplier Questions',
      'Price Schedule',
      'Social Value',
    ],
  },
  {
    name: 'Governance',
    weight: 6,
    sub: ['Board Minutes/2024', 'Board Minutes/2025', 'Committees'],
    topics: ['Board Meeting', 'Audit Committee', 'Risk Committee', 'Members Assembly', 'Annual Report'],
    headings: [
      'Attendees',
      'Apologies',
      'Minutes of the Last Meeting',
      'Matters Arising',
      'Chair Report',
      'Risk Register',
      'Decisions',
      'Action Items',
      'Any Other Business',
      'Date of Next Meeting',
      'Declarations of Interest',
    ],
  },
  {
    name: 'Operations',
    weight: 10,
    sub: ['Pumping Stations/East', 'Pumping Stations/West', 'Network', 'Incidents/2024', 'Incidents/2025'],
    topics: [
      'Pump Station Procedure',
      'Valve Exercising',
      'Burst Main Response',
      'Pressure Management',
      'Incident Report',
      'Flushing Programme',
    ],
    headings: [
      'Isolation Procedure',
      'Permit to Work',
      'Pump Start Up',
      'Pump Shut Down',
      'Pressure Readings',
      'Customer Notification',
      'Root Cause',
      'Corrective Actions',
      'Telemetry Alarms',
      'Standby Generator',
      'Chlorine Residuals',
      'Valve Locations',
      'Lessons Learned',
      'Timeline of Events',
    ],
  },
  {
    name: 'Training',
    weight: 5,
    sub: ['Courses', 'Handouts', 'Assessments'],
    topics: [
      'Confined Space Course',
      'First Aid Handout',
      'Manual Handling',
      'Water Hygiene Course',
      'Driver Training',
    ],
    headings: [
      'Learning Outcomes',
      'Course Outline',
      'Assessment',
      'Equipment Needed',
      'Safety Briefing',
      'Practical Exercise',
      'Certificate',
      'Refresher Interval',
      'Trainer Notes',
      'Further Reading',
    ],
  },
  {
    name: 'Communications',
    weight: 4,
    sub: ['Newsletters', 'Press', 'Website'],
    topics: ['Members Newsletter', 'Press Release', 'Website Update', 'Customer Letter', 'Social Media Plan'],
    headings: [
      'Key Messages',
      'Audience',
      'Channels',
      'Timing',
      'Spokesperson',
      'Questions and Answers',
      'Approval Route',
      'Images',
      'Translations',
    ],
  },
  {
    name: 'Research',
    weight: 5,
    sub: ['Water Quality', 'Demand Studies', 'Leakage'],
    topics: ['Water Quality Study', 'Demand Forecast', 'Leakage Survey', 'Catchment Monitoring', 'Lead Pipe Study'],
    headings: [
      'Method',
      'Sampling Points',
      'Results',
      'Discussion',
      'Limitations',
      'Recommendations',
      'Data Sources',
      'Statistical Approach',
      'Seasonal Trends',
      'Appendix Tables',
      'Peer Review',
    ],
  },
  {
    name: 'IT',
    weight: 5,
    sub: ['Systems', 'Security', 'Service Desk'],
    topics: ['Backup Procedure', 'Access Control Policy', 'Telemetry System', 'Password Standard', 'Laptop Setup'],
    headings: [
      'System Overview',
      'User Accounts',
      'Backups',
      'Restore Test',
      'Patching',
      'Incident Handling',
      'Remote Access',
      'Data Retention',
      'Change Requests',
      'Service Levels',
    ],
  },
];

/** The second linked folder: one subfolder per project. */
const PROJECTS = {
  name: 'Projects',
  sub: ['Riverside Main Upgrade', 'Hill Reservoir', 'Meter Replacement', 'Treatment Works Extension'],
  headings: [
    'Project Scope',
    'Programme',
    'Budget',
    'Risks',
    'Stakeholders',
    'Design Decisions',
    'Progress This Month',
    'Health and Safety',
    'Change Log',
    'Handover',
  ],
  topics: ['Progress Report', 'Design Note', 'Risk Workshop', 'Site Diary', 'Handover Plan'],
};

const KINDS = ['Procedure', 'Guidance', 'Report', 'Plan', 'Notes', 'Form', 'Summary', 'Review'];
const EXTS = ['pdf', 'pdf', 'pdf', 'docx', 'docx', 'md', 'xlsx'];
const LONG = [
  'Guidance on the Inspection and Cleaning of Service Reservoirs and Treated Water Storage Tanks',
  'Procedure for the Safe Isolation, Draining and Recommissioning of Trunk Mains after Repair',
  'Report on the Joint Review of Customer Contact Handling during Planned Supply Interruptions',
];
const WORDS =
  'the cooperative team checks each site before work starts and records readings in the log so that members can see progress over the year with clear owners for every step and dates agreed at the monthly meeting'.split(
    ' ',
  );

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function sample(rand, list, n) {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

function sentence(rand, n = 14) {
  const w = Array.from({ length: n }, () => pick(rand, WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(' ')}.`;
}

/**
 * The invented library. count documents in two linked folders (Cooperative Records with ten
 * departments, Projects with four), plus a few at the top of Cooperative Records and a few added to
 * the library directly. Returns BrowseDocument objects, sorted by relPath.
 */
export function inventLibrary({ normalizeHeading, documentId, count = 900, seed = 20261109 } = {}) {
  const rand = seeded(seed);
  const added = Math.round(count * 0.025);
  const top = Math.round(count * 0.008);
  const projects = Math.round(count * 0.08);
  const departments = count - added - top - projects;
  const totalWeight = DEPARTMENTS.reduce((s, d) => s + d.weight, 0);
  const specs = [];
  let left = departments;
  DEPARTMENTS.forEach((d, i) => {
    const n = i === DEPARTMENTS.length - 1 ? left : Math.round((departments * d.weight) / totalWeight);
    left -= n;
    for (let k = 0; k < n; k++) {
      const sub = pick(rand, d.sub);
      specs.push({
        folder: `Cooperative Records/${d.name}/${sub}`,
        dept: d.name,
        sub,
        topics: d.topics,
        pool: d.headings,
      });
    }
  });
  for (let k = 0; k < projects; k++) {
    const sub = pick(rand, PROJECTS.sub);
    specs.push({
      folder: `Projects/${sub}`,
      dept: `Projects/${sub}`,
      sub,
      topics: PROJECTS.topics,
      pool: PROJECTS.headings,
    });
  }
  for (let k = 0; k < top; k++)
    specs.push({
      folder: 'Cooperative Records',
      dept: 'top',
      sub: '',
      topics: ['Strategy', 'Annual Plan', 'Members Charter'],
      pool: COMMON,
    });
  for (let k = 0; k < added; k++)
    specs.push({
      folder: '',
      dept: 'added',
      sub: '',
      topics: ['Meeting Notes', 'Draft Letter', 'Checklist'],
      pool: COMMON,
    });

  const used = new Set();
  const docs = specs.map((s, i) => {
    const year = 2022 + Math.floor(rand() * 4);
    const long = rand() < 0.03;
    const base = long
      ? pick(rand, LONG)
      : `${pick(rand, s.topics)} ${pick(rand, KINDS)}${rand() < 0.5 ? ` ${year}` : ''}`;
    const numbered = rand() < 0.25 ? `${String(1 + Math.floor(rand() * 40)).padStart(2, '0')}_` : '';
    const ext = pick(rand, EXTS);
    let file = `${numbered}${base.replace(/ /g, rand() < 0.4 ? '_' : ' ')}.${ext}`;
    let rel = s.folder ? `${s.folder}/${file}` : file;
    for (let n = 2; used.has(rel); n++) {
      file = `${numbered}${base} ${n}.${ext}`;
      rel = s.folder ? `${s.folder}/${file}` : file;
    }
    used.add(rel);
    const headings = [
      ...COMMON.filter(() => rand() < 0.2),
      ...sample(rand, s.pool, 4 + Math.floor(rand() * 4)),
      ...(s.sub ? [`${s.sub.split('/').pop()} Notes`] : []),
      ...Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, k) => `${pick(rand, s.topics)} Item ${i}-${k}`),
    ];
    return { s, rel, file, headings, i };
  });

  return docs
    .map(({ rel, file, headings, i }) => {
      const p = `/invented/${rel}`;
      const sections = headings.map((h, k) => {
        const text = `${sentence(rand)} ${sentence(rand, 10)}`;
        return {
          index: k + 1,
          title: h,
          level: 1,
          lead: [],
          heading: normalizeHeading(h),
          path: [h],
          pageStart: k + 1,
          pageEnd: k + 1,
          pageLabelStart: null,
          pageLabelEnd: null,
          text,
          parts: [text],
        };
      });
      return {
        version: 3,
        id: documentId(p),
        path: p,
        url: `file://${encodeURI(p)}`,
        relPath: rel,
        title: file,
        size: 1000 + i,
        mtimeMs: Date.parse('2026-01-01T00:00:00Z') + i * 3_600_000,
        hash: `h-${i}`,
        splitKey: 'k',
        indexedAt: '2026-01-01T00:00:00Z',
        outline: sections.map((x) => ({
          title: x.title,
          level: 1,
          sectionIndex: x.index,
          page: x.pageStart,
          pageLabel: null,
          children: [],
        })),
        sections,
      };
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}
