import type { HandoffDraft } from '../integrations/openai.ts';

/**
 * Even with a signed BAA, the AI only needs to know which notes belong to the
 * same person, not who that person is. Residents become R1, R2, ... in the
 * prompt, their names are masked inside note text, and the labels are mapped
 * back to names only on the way out, inside our own function.
 */

export type HandoffNote = {
  residentId: string;
  firstName: string;
  lastName: string;
  kind: string;
  body: string;
  occurredAt: string;
};

export type Pseudonymized = {
  prompt: string;
  labels: Map<string, { residentId: string; displayName: string }>;
  noteCount: number;
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function pseudonymize(notes: HandoffNote[]): Pseudonymized {
  const labelByResident = new Map<string, string>();
  const labels = new Map<string, { residentId: string; displayName: string }>();
  const names: { pattern: RegExp; label: string }[] = [];

  for (const note of notes) {
    if (labelByResident.has(note.residentId)) continue;
    const label = `R${labelByResident.size + 1}`;
    labelByResident.set(note.residentId, label);
    labels.set(label, { residentId: note.residentId, displayName: `${note.firstName} ${note.lastName.charAt(0)}.` });
    // Full name first so "Ruth Baker" becomes one label, not "R1 R1".
    for (const name of [`${note.firstName} ${note.lastName}`, note.lastName, note.firstName]) {
      if (name.trim().length >= 2) names.push({ pattern: new RegExp(`\\b${escape(name.trim())}\\b`, 'gi'), label });
    }
  }

  const lines = notes.map((note) => {
    let body = note.body;
    for (const { pattern, label } of names) body = body.replace(pattern, label);
    return `[${note.occurredAt}] ${labelByResident.get(note.residentId)} (${note.kind}): ${body}`;
  });

  return { prompt: lines.join('\n'), labels, noteCount: notes.length };
}

export type ReidentifiedDraft = {
  summary: string;
  followUps: { resident: string; residentId?: string; action: string }[];
};

/** Puts names back into the draft for the staff member who asked for it. */
export function reidentify(draft: HandoffDraft, labels: Pseudonymized['labels']): ReidentifiedDraft {
  const swap = (text: string) => text.replace(/\bR(\d+)\b/g, (match) => labels.get(match)?.displayName ?? match);
  return {
    summary: swap(draft.summary),
    followUps: draft.followUps.map((f) => ({
      resident: labels.get(f.resident)?.displayName ?? f.resident,
      residentId: labels.get(f.resident)?.residentId,
      action: swap(f.action),
    })),
  };
}
