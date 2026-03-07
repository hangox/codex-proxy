import { useState, useMemo, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { CopyButton } from "./CopyButton";

type Protocol = "openai" | "anthropic" | "gemini";
type CodeLang = "python" | "node" | "curl";

const protocols: { id: Protocol; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
];

const langs: { id: CodeLang; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "node", label: "Node.js" },
  { id: "curl", label: "cURL" },
];

function buildExamples(
  baseUrl: string,
  apiKey: string,
  model: string,
  origin: string,
  reasoningEffort: string
): Record<string, string> {
  const effortLine = reasoningEffort && reasoningEffort !== "medium"
    ? `\n    reasoning_effort="${reasoningEffort}",`
    : "";
  const effortJson = reasoningEffort && reasoningEffort !== "medium"
    ? `,\n    "reasoning_effort": "${reasoningEffort}"`
    : "";
  const effortJs = reasoningEffort && reasoningEffort !== "medium"
    ? `\n    reasoning_effort: "${reasoningEffort}",`
    : "";
  return {
    "openai-python": `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",
)

response = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],${effortLine}
)
print(response.choices[0].message.content)`,

    "openai-curl": `curl ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello"}]${effortJson}
  }'`,

    "openai-node": `import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "${baseUrl}",
    apiKey: "${apiKey}",
});

const stream = await client.chat.completions.create({
    model: "${model}",
    messages: [{ role: "user", content: "Hello" }],${effortJs}
    stream: true,
});
for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || "");
}`,

    "anthropic-python": `import anthropic

client = anthropic.Anthropic(
    base_url="${origin}/v1",
    api_key="${apiKey}",
)

message = client.messages.create(
    model="${model}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(message.content[0].text)`,

    "anthropic-curl": `curl ${origin}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${apiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,

    "anthropic-node": `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
    baseURL: "${origin}/v1",
    apiKey: "${apiKey}",
});

const message = await client.messages.create({
    model: "${model}",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
});
console.log(message.content[0].text);`,

    "gemini-python": `from google import genai

client = genai.Client(
    api_key="${apiKey}",
    http_options={"base_url": "${origin}/v1beta"},
)

response = client.models.generate_content(
    model="${model}",
    contents="Hello",
)
print(response.text)`,

    "gemini-curl": `curl "${origin}/v1beta/models/${model}:generateContent?key=${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello"}]}]
  }'`,

    "gemini-node": `import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
    apiKey: "${apiKey}",
    httpOptions: { baseUrl: "${origin}/v1beta" },
});

const response = await ai.models.generateContent({
    model: "${model}",
    contents: "Hello",
});
console.log(response.text);`,
  };
}

interface CodeExamplesProps {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string | null;
}

export function CodeExamples({ baseUrl, apiKey, model, reasoningEffort, serviceTier }: CodeExamplesProps) {
  const t = useT();
  const [protocol, setProtocol] = useState<Protocol>("openai");
  const [codeLang, setCodeLang] = useState<CodeLang>("python");

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  // Build compound model name with suffixes
  const displayModel = useMemo(() => {
    let name = model;
    if (reasoningEffort && reasoningEffort !== "medium") name += `-${reasoningEffort}`;
    if (serviceTier === "fast") name += "-fast";
    return name;
  }, [model, reasoningEffort, serviceTier]);

  // When effort/speed are embedded as suffixes, don't also show separate reasoning_effort param
  const explicitEffort = displayModel === model ? reasoningEffort : "medium";
  const examples = useMemo(
    () => buildExamples(baseUrl, apiKey, displayModel, origin, explicitEffort),
    [baseUrl, apiKey, displayModel, origin, explicitEffort]
  );

  const currentCode = examples[`${protocol}-${codeLang}`] || "Loading...";
  const getCode = useCallback(() => currentCode, [currentCode]);

  return (
    <section class="flex flex-col gap-4">
      <h2 class="text-[0.95rem] font-semibold" style="color: var(--text-primary);">{t("integrationExamples")}</h2>
      <div class="card overflow-hidden">
        {/* Protocol Tabs */}
        <div class="flex" style="border-bottom: 1px solid var(--border); background: var(--bg-input);">
          {protocols.map((p) => (
            <button
              key={p.id}
              onClick={() => setProtocol(p.id)}
              class={`px-6 py-3 text-[0.82rem] font-medium transition-colors duration-150 border-b-2 ${
                protocol === p.id
                  ? "text-primary border-primary font-semibold"
                  : "border-transparent hover:text-primary/70"
              }`}
              style={protocol === p.id
                ? { background: "var(--bg-card)" }
                : { color: "var(--text-secondary)" }
              }
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Language Tabs & Code */}
        <div class="p-5">
          <div class="flex items-center justify-between mb-4">
            <div class="flex gap-1 p-1 rounded-lg" style="background: var(--bg-input);">
              {langs.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setCodeLang(l.id)}
                  class={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-150 ${
                    codeLang === l.id
                      ? "shadow-sm font-semibold"
                      : ""
                  }`}
                  style={codeLang === l.id
                    ? { background: "var(--bg-card)", color: "var(--text-primary)", border: "1px solid var(--border)" }
                    : { color: "var(--text-secondary)", border: "1px solid transparent" }
                  }
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          {/* Code Block */}
          <div class="relative group rounded-lg overflow-hidden font-mono text-xs" style="background: #0d1117; border: 1px solid #21262d;">
            <div class="absolute right-2 top-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <CopyButton getText={getCode} variant="label" />
            </div>
            <div class="p-4 overflow-x-auto">
              <pre class="m-0" style="color: #c9d1d9;"><code>{currentCode}</code></pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
