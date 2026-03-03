const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Pull the most recent user message for search/debug
function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m?.content) return String(m.content);
  }
  return "";
}

// Basic keyword extraction (v1)
function extractTerms(text, maxTerms = 6) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxTerms);
}

export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (request.method === "GET") {
      return new Response("worker alive", {
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    if (request.method !== "POST") {
      return new Response("POST only", { status: 405, headers: corsHeaders });
    }

    try {
      // Bindings checks
      if (!env.AI) {
        return new Response(JSON.stringify({ error: "Missing AI binding env.AI" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!env.DB) {
        return new Response(JSON.stringify({ error: "Missing D1 binding env.DB" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const body = await request.json();
      const messages = body?.messages;

      if (!Array.isArray(messages) || messages.length === 0) {
        return new Response(JSON.stringify({ error: "Body must include { messages: [...] }" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const userText = getLastUserMessage(messages);
      const terms = extractTerms(userText);

      // Build a simple OR-based LIKE query across title/content
      let where = "";
      const params = [];
      if (terms.length) {
        where =
          "WHERE " +
          terms.map(() => "(lower(title) LIKE ? OR lower(content) LIKE ?)").join(" OR ");
        for (const t of terms) params.push(`%${t}%`, `%${t}%`);
      }

      const sql = `
        SELECT title, content
        FROM kb
        ${where}
        LIMIT 4
      `;

      const results = await env.DB.prepare(sql).bind(...params).all();
      const rows = results?.results || [];

      // 🔎 Debug mode: returns what DB search found (JSON), not streaming
      // Use by asking: "debug_kb secret test phrase"
      if (userText.toLowerCase().includes("debug_kb")) {
        return new Response(JSON.stringify({ terms, rowsFound: rows.length, rows }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const context =
        rows.length > 0
          ? rows.map((r, i) => `Source ${i + 1}: ${r.title}\n${r.content}`).join("\n\n---\n\n")
          : "No relevant knowledge found.";

      // Strict RAG instruction: answer ONLY from knowledge
      const ragSystem = {
        role: "system",
        content:
          "You answer using ONLY the KNOWLEDGE below. " +
          "If the answer is not explicitly in the knowledge, say: 'I don't know based on the provided knowledge.' " +
          "Do not invent facts.\n\n" +
          "KNOWLEDGE:\n" +
          context,
      };

      const finalMessages = [ragSystem, ...messages];

      // ✅ Streaming response (matches your streaming UI)
      const stream = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: finalMessages,
        max_tokens: 450,
        stream: true,
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
