const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function textResp(t, status = 200) {
  return new Response(t, { status, headers: { ...corsHeaders, "Content-Type": "text/plain" } });
}

function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m?.content) return String(m.content);
  }
  return "";
}

// Embedding model (768 dims)
async function embed(env, text) {
  const out = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text });
  const vec = out?.data?.[0];
  if (!vec) throw new Error("Embedding failed");
  return vec;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

function requireAdmin(request, env) {
  const tok = request.headers.get("X-Admin-Token") || "";
  return !!env.ADMIN_TOKEN && tok === env.ADMIN_TOKEN;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    if (!env.AI) return json({ error: "Missing Workers AI binding env.AI" }, 500);
    if (!env.DB) return json({ error: "Missing D1 binding env.DB" }, 500);

    const url = new URL(request.url);

    if (request.method === "GET") return textResp("worker alive");

    // ADMIN: embed everything in kb into kb_embeddings
    if (request.method === "POST" && url.pathname === "/embed_all") {
      if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

      const { results } = await env.DB.prepare("SELECT id, title, content FROM kb").all();
      const rows = results || [];

      let embedded = 0;

      for (const r of rows) {
        const vec = await embed(env, `${r.title}\n\n${r.content}`);
        await env.DB.prepare(
          `INSERT INTO kb_embeddings (kb_id, embedding, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(kb_id) DO UPDATE SET embedding=excluded.embedding, updated_at=datetime('now')`
        ).bind(r.id, JSON.stringify(vec)).run();
        embedded++;
      }

      return json({ ok: true, embedded });
    }

    // CHAT
    if (request.method !== "POST") return textResp("POST only", 405);

    const body = await request.json().catch(() => ({}));
    const messages = body?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Body must include { messages: [...] }" }, 400);
    }

    const question = getLastUserMessage(messages).slice(0, 2000);
    if (!question) return json({ error: "No user message found" }, 400);

    // Embed user question
    const qVec = await embed(env, question);

    // Load embeddings + kb rows
    const { results: joinRows } = await env.DB.prepare(`
      SELECT kb.id, kb.title, kb.content, emb.embedding
      FROM kb kb
      LEFT JOIN kb_embeddings emb ON emb.kb_id = kb.id
    `).all();

    const candidates = (joinRows || [])
      .map((r) => {
        let v = null;
        try { v = r.embedding ? JSON.parse(r.embedding) : null; } catch {}
        return { id: r.id, title: r.title, content: r.content, vec: v };
      })
      .filter((c) => Array.isArray(c.vec) && c.vec.length);

    // If no embeddings exist yet, tell user to run /embed_all
    if (candidates.length === 0) {
      return json({
        error: "No embeddings found. Run POST /embed_all with X-Admin-Token first.",
      }, 500);
    }

    // Score + topK
    const scored = candidates
      .map((c) => ({ ...c, score: cosineSim(qVec, c.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    const context = scored.length
      ? scored.map((r, i) => `Source ${i + 1} (score ${r.score.toFixed(3)}): ${r.title}\n${r.content}`).join("\n\n---\n\n")
      : "No relevant knowledge found.";

    const ragSystem = {
      role: "system",
      content:
        "Use the KNOWLEDGE below when answering. If it does not contain the answer, say you don't know.\n\n" +
        "KNOWLEDGE:\n" + context,
    };

    const finalMessages = [ragSystem, ...messages];

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: finalMessages,
      max_tokens: 400,
    });

    return json({
      answer: result?.response ?? result,
      retrieved: scored.map((r) => ({ id: r.id, title: r.title, score: r.score })),
    });
  },
};
