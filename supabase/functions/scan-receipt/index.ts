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

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

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
        input: [
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
        ],
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
    console.error("OpenAI request failed", error);
    return jsonResponse({ error: "Couldn't reach the scanning service" }, 502);
  }

  if (!openaiResponse.ok) {
    console.error("OpenAI request failed", openaiResponse.status, await openaiResponse.text());
    return jsonResponse({ error: "Couldn't scan this receipt" }, 502);
  }

  const result = await openaiResponse.json();
  const outputText = result.output
    ?.flatMap((item: { content?: { type: string; text?: string }[] }) => item.content ?? [])
    .find((content: { type: string }) => content.type === "output_text")?.text;

  if (!outputText) {
    console.error("No output_text in OpenAI response", JSON.stringify(result));
    return jsonResponse({ error: "Couldn't read this receipt" }, 502);
  }

  let parsed: { amount: number | null; currency: string | null };
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    console.error("Failed to parse model output as JSON", outputText, error);
    return jsonResponse({ error: "Couldn't read this receipt" }, 502);
  }

  return jsonResponse(parsed);
});
