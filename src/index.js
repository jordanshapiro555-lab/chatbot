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
