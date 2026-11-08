# Library profiles

Session N. A profile says what kinds of document a library holds: the type names, a colour per type, keyword cues per type, the band order of the layered graph and the edge rules it draws (docs/graph.md). Files in config/profiles, one JSON per profile, read at launch (src/main/graph/profiles.ts, loadProfiles, which refuses a broken file with the reason). Shipped in app.asar.

| Profile | Types | Edges |
| --- | --- | --- |
| legal-finance (Legal and finance, the default) | regulation, guidance, template, contract, record, data, other | shared headings, explicit references with clause references, version chains |
| team-work (Team work) | meeting, report, ticket, spec, other | project names from titles, ticket ids, title mentions, date adjacency |
| general (General) | book, article, note, reference | title mentions, relatedness by shared rare terms; shared headings off |

legal-finance and team-work have a type `other` for documents the signals cannot place (kind other), so a guess is never shown as a finding. The brief lists six legal-finance types without it; the decision is noted in the PR. general sends kind other to note.

## File format

```json
{
  "id": "legal-finance",
  "name": "Legal and finance",
  "description": "One sentence for the library menu.",
  "types": [{ "name": "regulation", "label": "Regulation", "color": "#4a7cff" }],
  "kinds": { "normative": "regulation", "explanatory": "guidance", "template": "template", "record": "record", "data": "data", "other": "other" },
  "cues": { "contract": ["contract", "agreement", "合同", "协议"] },
  "bands": ["regulation", "guidance", "contract", "template", "record", "data", "other"],
  "edges": { "headings": true, "references": true, "clauseReferences": true, "versions": true, "related": false, "projects": false, "tickets": false, "dates": false },
  "long": { "kind": "explanatory", "type": "book", "minWords": 20000 }
}
```

- types: name in lower case letters, digits and -; colour #rrggbb, a mid tone readable on the light and the dark background.
- kinds: the type of each structural kind (docs/graph.md, Kinds); all six are required.
- cues: words in a file name that name a type, matched as whole words in Latin script (a plural s allowed) and anywhere in Chinese. When several match, the one ending last wins, then the longer one: a title's head noun comes last in both languages, so Records Management Guidance is guidance and 违法行为记录管理办法 is a regulation, not a record.
- bands: the layered layout's rows, top to bottom; types not listed go last.
- edges: which rules run (docs/graph.md, Edges).
- long (optional): a document of this kind with at least minWords words gets this type (general: a long explanatory text is a book).

## How a type is chosen

1. The user's choice for this document in this profile, from the type dropdown on the Library page; detection never replaces it. Stored in the library record, `typeOverrides[profile][document id]`; the dropdown's first entry, Detected: <type>, removes it. The Library page shows the type with (detected) after it when detection chose it (Regulation (detected)) and alone when the user set it (Regulation); the wording is the same in every profile.
2. A spreadsheet (xlsx, xlsm, xls, csv) is always the data kind's type, whatever its name says.
3. A title cue.
4. The long rule.
5. The type of the structural kind.

## Choosing and changing a profile

A library gets its profile when it is created (the Kind of documents list next to the new library's name; legal-finance by default for now) and changes it in the library menu (Kind of documents). A change rebuilds the types and edges from the browse index; nothing is indexed again. Overrides are kept per profile, so going back restores them. A library whose stored profile is no longer shipped uses the default.
