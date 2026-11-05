/**
 * perFileSubquery (docs/plan.md, round X1): for a question that names two or more files, the
 * clause that asks about each file, so the search inside that file uses its own words. A clause is
 * a sentence, or a part of one after a comma before and, but, while or whereas, a semicolon, or a
 * colon; Chinese sentences also split at the full-width comma and colon. A clause belongs to a file
 * when it names that file's group (file name, title or type word, namedFileGroups) and no other
 * named group: the lead-in Compare A and B names both, so it belongs to neither. A file without a
 * clause of its own uses the whole question. No model is involved.
 */
import { namedFileGroups, type FileIdentity } from '../browse/identifiers.js';

/**
 * Sentence ends: . ? ! followed by white space or the end (a file name's .pdf is not one), and the
 * full-width 。？！ anywhere. Clause breaks inside a sentence: ; and a colon before white space, a
 * comma before a coordinating word, and the full-width ；，：.
 */
const SENTENCE_END = /(?<=[.?!])\s+|(?<=[。？！])/u;
const CLAUSE_BREAK = /;\s*|:\s+|,\s+(?=(?:and|but|while|whereas)\s)|[；，：]/u;

/** The question cut into its clauses, trimmed, empty ones left out. */
export function clausesOf(question: string): string[] {
  return question
    .split(SENTENCE_END)
    .flatMap((s) => s.split(CLAUSE_BREAK))
    .map((c) => c.trim())
    .filter((c) => /[\p{L}\p{N}]/u.test(c));
}

export interface FileSubquery {
  documentId: string;
  /** The clauses that name only this file, joined; the whole question when there are none. */
  query: string;
  /** False when the file uses the whole question. */
  attributed: boolean;
}

/**
 * One query per named file, in the order of groups: a file's clauses joined with a space, or the
 * whole question when no clause names it alone. Files of one group (the .pdf and .docx of one
 * document) share their group's clauses.
 */
export function fileSubqueries(question: string, groups: FileIdentity[][], identities: FileIdentity[]): FileSubquery[] {
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((f) => groupOf.set(f.documentId, i)));
  const own = groups.map((): string[] => []);
  for (const clause of clausesOf(question)) {
    const named = new Set<number>();
    for (const g of namedFileGroups(clause, identities))
      for (const f of g) {
        const i = groupOf.get(f.documentId);
        if (i !== undefined) named.add(i);
      }
    if (named.size === 1) own[[...named][0]!]!.push(clause);
  }
  return groups.flatMap((g, i) =>
    g.map((f) => ({
      documentId: f.documentId,
      query: own[i]!.length ? own[i]!.join(' ') : question,
      attributed: own[i]!.length > 0,
    })),
  );
}
