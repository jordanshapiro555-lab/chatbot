const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m?.content) return String(m.content);
  }
  return "";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    if (request.method === "GET") {
      return new Response("worker alive", {
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    if (request.method !== "POST") {
      return new Response("POST only", { status: 405, headers: corsHeaders });
    }

    try {
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

      const userText = getLastUserMessage(messages).toLowerCase().slice(0, 200);

      const terms = userText
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6);

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

      console.log("Search terms:", terms);
      console.log("Rows found:", rows.length);

      const context =
        rows.length > 0
          ? rows.map((r, i) => `Source ${i + 1}: ${r.title}\n${r.content}`).join("\n\n---\n\n")
          : "No relevant knowledge found.";

      const ragSystem = {
        role: "system",
        content:
          "Answer using ONLY the KNOWLEDGE below. If the answer is not in the knowledge, say 'I don't know.'\n\n" +
          "KNOWLEDGE:\n" +
          context,
      };

      const finalMessages = [ragSystem, ...messages];

      const aiResult = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: finalMessages,
        max_tokens: 350,
      });

      return new Response(JSON.stringify(aiResult), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
