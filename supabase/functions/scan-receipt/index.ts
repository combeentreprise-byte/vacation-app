// Extracts the total amount + currency from a photographed receipt via
// OpenAI's gpt-4o-mini (vision + structured outputs), so the client can
// prefill a log entry instead of the user typing the amount by hand.
//
// No auth check of its own is needed here: Supabase's function gateway
// rejects requests with no/invalid Supabase JWT by default (verify_jwt),
// and the client's supabase.functions.invoke() attaches the caller's own
// session token automatically — an unauthenticated request never reaches
// this code. This function doesn't touch the database at all, just proxies
// to OpenAI and hands back the extracted numbers.

import { PostHog } from "npm:posthog-node@5";

// Supabase's edge runtime global: keeps the worker alive for a promise after
// the response has gone out.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const POSTHOG_PROJECT_TOKEN = Deno.env.get("POSTHOG_PROJECT_TOKEN");
const POSTHOG_HOST = Deno.env.get("POSTHOG_HOST");
const posthog =
  POSTHOG_PROJECT_TOKEN && POSTHOG_HOST
    ? new PostHog(POSTHOG_PROJECT_TOKEN, {
        host: POSTHOG_HOST,
        privacyMode: false,
      })
    : undefined;

if (!POSTHOG_PROJECT_TOKEN || !POSTHOG_HOST) {
  const missingVariable = !POSTHOG_PROJECT_TOKEN ? "POSTHOG_PROJECT_TOKEN" : "POSTHOG_HOST";
  console.error(
    `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`
  );
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Both fields nullable so the model can honestly say "couldn't read this"
// instead of guessing — the client falls back to manual entry either way.
const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    amount: {
      type: ["number", "null"],
      description:
        "The final total amount actually charged on the receipt (the grand total, after tax/tip if shown), or null if it can't be confidently read.",
    },
    currency: {
      type: ["string", "null"],
      description:
        "The ISO 4217 currency code the amount is in (e.g. USD, EUR, GBP), inferred from symbols or text on the receipt, or null if it can't be determined.",
    },
  },
  required: ["amount", "currency"],
  additionalProperties: false,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function getAuthenticatedUserId(req: Request) {
  // The Supabase function gateway has already verified this JWT. Its `sub`
  // matches the UUID the app identifies with in the React Native client.
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return undefined;

  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decodedPayload = atob(normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, "="));
    const { sub } = JSON.parse(decodedPayload);
    return typeof sub === "string" ? sub : undefined;
  } catch {
    return undefined;
  }
}

type OpenAIUsage = { input_tokens?: number; output_tokens?: number };

type GenerationCapture = {
  distinctId: string | undefined;
  traceId: string;
  input: unknown;
  latencyMs: number;
  httpStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
  outputText?: string;
  error?: string;
};

// The receipt photo itself never goes to PostHog: it's someone's private
// receipt, and as base64 it's far over PostHog's event size limit anyway.
function withoutImages(input: unknown) {
  return JSON.parse(JSON.stringify(input), (key, value) =>
    key === "image_url" ? "[receipt photo omitted]" : value
  );
}

function captureGeneration({
  distinctId,
  traceId,
  input,
  latencyMs,
  httpStatus,
  inputTokens,
  outputTokens,
  outputText,
  error,
}: GenerationCapture) {
  // Receipt scans are independent, one-shot generations. A null session ID
  // explicitly marks that there is no multi-turn conversation to group.
  if (!posthog || !distinctId) return;

  try {
    posthog.capture({
      distinctId,
      event: "$ai_generation",
      properties: {
        $ai_trace_id: traceId,
        $ai_session_id: null,
        $ai_span_id: crypto.randomUUID(),
        $ai_span_name: "receipt_scan",
        $ai_model: "gpt-4o-mini",
        $ai_provider: "openai",
        $ai_input: withoutImages(input),
        ...(typeof inputTokens === "number" ? { $ai_input_tokens: inputTokens } : {}),
        ...(typeof outputTokens === "number" ? { $ai_output_tokens: outputTokens } : {}),
        ...(outputText ? { $ai_output_choices: [{ role: "assistant", content: outputText }] } : {}),
        $ai_latency: latencyMs / 1000,
        ...(typeof httpStatus === "number" ? { $ai_http_status: httpStatus } : {}),
        $ai_base_url: "https://api.openai.com/v1",
        $ai_request_url: "https://api.openai.com/v1/responses",
        $ai_is_error: Boolean(error),
        ...(error ? { $ai_error: error } : {}),
      },
    });
    // Sent after the response has gone out, so a slow or unreachable PostHog
    // never delays a scan.
    EdgeRuntime.waitUntil(
      posthog.flush().catch((error) => console.error("PostHog AI observability flush failed", error))
    );
  } catch (error) {
    // Observability must not interfere with receipt scanning.
    console.error("PostHog AI observability capture failed", error);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not configured");
    return jsonResponse({ error: "Receipt scanning isn't configured" }, 500);
  }

  let image: unknown;
  try {
    ({ image } = await req.json());
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  if (typeof image !== "string" || !image) {
    return jsonResponse({ error: "Missing image" }, 400);
  }

  // The client sends a raw base64 string (from expo-camera's
  // takePictureAsync({ base64: true })) — the Responses API wants a data URL.
  const imageUrl = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
  const input = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "This is a photo of a receipt. Extract the final total amount actually charged and the currency it's in. If either can't be confidently read, return null for it rather than guessing.",
        },
        { type: "input_image", image_url: imageUrl, detail: "high" },
      ],
    },
  ];
  const distinctId = getAuthenticatedUserId(req);
  const traceId = crypto.randomUUID();
  const startedAt = performance.now();

  let openaiResponse: Response;
  try {
    openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input,
        text: {
          format: {
            type: "json_schema",
            name: "receipt_total",
            schema: RECEIPT_SCHEMA,
            strict: true,
          },
        },
      }),
    });
  } catch (error) {
    captureGeneration({
      distinctId,
      traceId,
      input,
      latencyMs: performance.now() - startedAt,
      error: "OpenAI request failed",
    });
    console.error("OpenAI request failed", error);
    return jsonResponse({ error: "Couldn't reach the scanning service" }, 502);
  }

  if (!openaiResponse.ok) {
    captureGeneration({
      distinctId,
      traceId,
      input,
      latencyMs: performance.now() - startedAt,
      httpStatus: openaiResponse.status,
      error: "OpenAI responded with an error",
    });
    console.error("OpenAI request failed", openaiResponse.status, await openaiResponse.text());
    return jsonResponse({ error: "Couldn't scan this receipt" }, 502);
  }

  const result = await openaiResponse.json();
  const usage = result.usage as OpenAIUsage | undefined;
  const outputText = result.output
    ?.flatMap((item: { content?: { type: string; text?: string }[] }) => item.content ?? [])
    .find((content: { type: string }) => content.type === "output_text")?.text;

  if (!outputText) {
    captureGeneration({
      distinctId,
      traceId,
      input,
      latencyMs: performance.now() - startedAt,
      httpStatus: openaiResponse.status,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      error: "OpenAI response did not include output text",
    });
    console.error("No output_text in OpenAI response", JSON.stringify(result));
    return jsonResponse({ error: "Couldn't read this receipt" }, 502);
  }

  captureGeneration({
    distinctId,
    traceId,
    input,
    latencyMs: performance.now() - startedAt,
    httpStatus: openaiResponse.status,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    outputText,
  });

  let parsed: { amount: number | null; currency: string | null };
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    console.error("Failed to parse model output as JSON", outputText, error);
    return jsonResponse({ error: "Couldn't read this receipt" }, 502);
  }

  return jsonResponse(parsed);
});
