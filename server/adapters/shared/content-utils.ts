/** Strip [CLAWTAP_REF:...] and [CODETAP_REF:...] markers from message text. */
const MARKER_REGEX = /^(?:\[(?:CLAWTAP_REF|CODETAP_REF):[^\]]+\]|\d+\])(?:\\n|\n)?/;

export function stripMarker(text: string): string {
  return text.replace(MARKER_REGEX, '');
}
