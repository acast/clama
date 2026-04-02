const DEFAULT_BASE_URL = "http://localhost:11434/v1";

export function getConfig() {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    model: process.env.OLLAMA_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-oss:20b-cloud",
    apiKey: process.env.OLLAMA_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    temperature: Number(process.env.OLLAMA_TEMPERATURE ?? process.env.OPENAI_TEMPERATURE ?? "0.2"),
  };
}

export async function chatCompletion({ baseUrl, apiKey, model, messages, temperature = 0.2 }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Ollama response did not include assistant content.");
  }
  return content;
}
