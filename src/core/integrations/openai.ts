import { IntegrationError, isRetryableStatus, readJson, send, type HttpOptions } from './http.ts';

/**
 * OpenAI Responses API (checked Nov 2026): POST https://api.openai.com/v1/responses
 * with { model, instructions, input, store, text: { format: { type: 'json_schema',
 * name, schema, strict } } }. `store` defaults to true, so this client always
 * sends store: false. The reply's text is in output[].content[] items of type
 * 'output_text'.
 *
 * PHI may only be sent after the provider has signed OpenAI's Business
 * Associate Addendum and the API organization is provisioned for it. The app
 * enforces that with organizations.ai_summaries_enabled, which the database
 * refuses to turn on without a BAA date.
 */
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export type HandoffDraft = {
  summary: string;
  followUps: { resident: string; action: string }[];
};

const HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'follow_ups'],
  properties: {
    summary: { type: 'string', description: 'Three to six short sentences for the next shift.' },
    follow_ups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['resident', 'action'],
        properties: {
          resident: { type: 'string', description: 'The resident label exactly as given, e.g. R1.' },
          action: { type: 'string' },
        },
      },
    },
  },
} as const;

export const HANDOFF_INSTRUCTIONS = [
  'You draft shift handoff notes for staff at a residential care home.',
  'Use only the notes provided. Do not add diagnoses, medication advice or anything not in the notes.',
  'Residents appear only as labels like R1. Keep the labels; never invent names.',
  'List a follow-up only when a note asks for one or describes an unresolved problem.',
  'A staff member will review and edit your draft before anyone relies on it.',
].join(' ');

type OutputItem = { type: string; content?: { type: string; text?: string; refusal?: string }[] };
type ResponseBody = {
  status?: string;
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: OutputItem[];
};

export class OpenAIClient {
  constructor(private readonly config: HttpOptions & { apiKey: string; model: string }) {
    if (!config.model) throw new Error('Set OPENAI_MODEL; the model is configuration, not code.');
  }

  async draftHandoff(input: string): Promise<HandoffDraft> {
    const response = await send(
      'openai',
      OPENAI_RESPONSES_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          instructions: HANDOFF_INSTRUCTIONS,
          input,
          store: false,
          text: { format: { type: 'json_schema', name: 'handoff_draft', schema: HANDOFF_SCHEMA, strict: true } },
        }),
      },
      {
        timeoutMs: 45_000,
        retries: 1,
        ...this.config,
        onError: async (res) => {
          const body = await readJson<{ error?: { code?: string; type?: string } }>(res);
          return new IntegrationError('openai', body?.error?.code ?? body?.error?.type ?? 'request_failed', isRetryableStatus(res.status), res.status);
        },
      },
    );

    const body = await readJson<ResponseBody>(response);
    if (!body) throw new IntegrationError('openai', 'invalid_response', true);
    if (body.status === 'incomplete') {
      throw new IntegrationError('openai', `incomplete_${body.incomplete_details?.reason ?? 'unknown'}`, false);
    }
    if (body.error) throw new IntegrationError('openai', body.error.code ?? 'response_error', false);

    const content = (body.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
    if (content.some((part) => part.type === 'refusal')) throw new IntegrationError('openai', 'refused', false);
    const text = content.find((part) => part.type === 'output_text')?.text;
    if (!text) throw new IntegrationError('openai', 'empty_output', true);

    let parsed: { summary?: unknown; follow_ups?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new IntegrationError('openai', 'invalid_json', true, undefined, { cause: error });
    }
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.follow_ups)) {
      throw new IntegrationError('openai', 'schema_mismatch', true);
    }
    return {
      summary: parsed.summary,
      followUps: parsed.follow_ups
        .filter((f): f is { resident: string; action: string } => typeof f?.resident === 'string' && typeof f?.action === 'string')
        .map((f) => ({ resident: f.resident, action: f.action })),
    };
  }
}
