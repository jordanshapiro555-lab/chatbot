export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }

    const body = await request.json().catch(() => ({}));
    const message = body.message ?? "";

    return new Response(JSON.stringify({ reply: `You said: ${message}` }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

// Cloudflare Worker (JavaScript)
// Uses Cloudflare AI (free tier available depending on account/region)

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }

    const { messages } = await request.json();

    // Example model (Cloudflare catalog varies). You may need to adjust the model ID in your dashboard.
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages,
      max_tokens: 300,
    });

    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
