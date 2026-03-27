/** Parse Claude's AskUserQuestion nested input structure into a flat format */
export function parseAskQuestionInput(input: any): {
  question: string;
  header?: string;
  options?: { label: string; value: string }[];
} {
  const q = input?.questions?.[0] || input || {};
  const question = q.question || q.text || input?.question || input?.text || '';
  const header = q.header;
  const rawOpts = q.options || input?.options;
  const options = Array.isArray(rawOpts) && rawOpts.length > 0
    ? rawOpts.map((o: any, i: number) => ({
        value: typeof o === 'string' ? String(i) : (o.value ?? String(i)),
        label: typeof o === 'string' ? o : (o.label || o.text || `Option ${i + 1}`),
      }))
    : undefined;
  return { question, header, options };
}
