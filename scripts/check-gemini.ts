// Ground-truth check: does GEMINI_MODEL exist and return a function call?
// Run: npm run check:gemini   (never prints the key)
import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  if (!apiKey) {
    console.log('RESULT: GEMINI_API_KEY missing. The app will use the offline heuristic agent.');
    return;
  }
  const ai = new GoogleGenAI({ apiKey });

  try {
    const info = await ai.models.get({ model });
    console.log(`Model found: ${info.name} (${info.displayName ?? 'no display name'})`);
  } catch (e) {
    console.log(`RESULT: model "${model}" is not available: ${(e as Error).message.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  try {
    const res = await ai.models.generateContent({
      model,
      contents: 'Dispute D-1 for $42 has delivery confirmation with signature. Record your decision.',
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'setDecision',
                description: 'Record the decision for a dispute.',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {
                    disputeId: { type: 'string' },
                    decision: { type: 'string', enum: ['fight', 'refund', 'concede'] },
                    winProbability: { type: 'number' },
                    rationale: { type: 'string' },
                  },
                  required: ['disputeId', 'decision', 'winProbability', 'rationale'],
                },
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
      },
    });
    const calls = res.functionCalls ?? [];
    console.log(`RESULT: ${calls.length} function call(s) in ${Date.now() - started} ms`);
    console.log(JSON.stringify(calls, null, 2));
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    console.log(`Parts carry thoughtSignature: ${parts.some((p) => Boolean(p.thoughtSignature))}`);
    if (!calls.length) process.exitCode = 1;
  } catch (e) {
    console.log(`RESULT: generateContent failed: ${(e as Error).message.slice(0, 400)}`);
    process.exitCode = 1;
  }
}

main();
