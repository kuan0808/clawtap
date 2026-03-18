export function extractTextFromBlocks(content: any[]): string {
  return content.map((b: any) => typeof b === 'string' ? b : b.text || '').join('\n');
}

const CLAWTAP_REF_REGEX = /^\[CLAWTAP_REF:[^\]]+\](?:\\n|\n)?/;

export function stripMarker(text: string): string {
  return text.replace(CLAWTAP_REF_REGEX, '');
}
