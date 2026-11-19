// A name's possessive, for a line that names whose something is: an
// apostrophe alone after a final s (The Lees' cover), 's otherwise (Anna's
// cover). One copy, so every such line agrees (CK-99).
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`
}
