// Minimal OpenAI-compatible chat-completions client (Sprint 3 · T07).
//
// Contract: speak the shape every OpenAI-compatible endpoint speaks —
// `POST {endpoint}/chat/completions` with a `messages: [{role, content}]`
// body — so the generator portably talks to local LM Studio, vLLM,
// Groq, Anthropic via its OpenAI-compat shim, etc. No vendor-specific
// logic here. Endpoint / model / API key come from the caller.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface OpenAiCompatClientOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature?: number;
  // Injectable for tests. Defaults to the global `fetch`.
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatClient implements LlmClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature ?? 0;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const url = `${this.endpoint}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      temperature: this.temperature,
      messages
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body
      });
    } catch (err) {
      throw new LlmNetworkError(
        `POST ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new LlmNetworkError(
        `POST ${url}: HTTP ${response.status}: ${text || "<empty body>"}`
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new LlmNetworkError(
        `POST ${url}: response missing \`choices[0].message.content\``
      );
    }
    return content;
  }
}

export class LlmNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmNetworkError";
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// Strip markdown fences if the model wrapped its output in ```toml / ```.
// Some models cannot be talked out of fences even with strict system
// prompts. Pragmatic: unwrap one layer, fail loudly on anything else.
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const firstNl = trimmed.indexOf("\n");
  if (firstNl < 0) {
    return trimmed;
  }
  const body = trimmed.slice(firstNl + 1);
  const end = body.lastIndexOf("```");
  if (end < 0) {
    return body.trim();
  }
  return body.slice(0, end).trim();
}
