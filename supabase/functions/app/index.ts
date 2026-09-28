// ============================================================================
//  Fonction Edge `app` — API unique de la liste de naissance
//  Version 18 — multi-utilisateurs
//
//  Déployée sur Supabase, slug `app`, verify_jwt = FALSE (le site est public,
//  l'authentification se fait par JWT signé avec JWT_SECRET).
//
//  Cette fonction est le SEUL chemin d'accès à la base : elle utilise
//  SUPABASE_SERVICE_ROLE_KEY, qui contourne RLS. Voir supabase/schema.sql.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const JWT_SECRET     = Deno.env.get("JWT_SECRET") || "liste-naissance-secret-change-me";
// BYPASS_DOMAIN : si défini, les e-mails se terminant par @<BYPASS_DOMAIN>
// contournent la validation de format et ne reçoivent pas de notifications.
// Exemple : "test.local"  → test@test.local est accepté.
// Laisser vide (absent) en production.
const BYPASS_DOMAIN  = (Deno.env.get("BYPASS_DOMAIN") || "").trim().toLowerCase();

function isBypass(email: string): boolean {
  if (!BYPASS_DOMAIN) return false;
  return email.endsWith("@" + BYPASS_DOMAIN);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,apikey,authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json" } });

// ── JWT minimal (HMAC-SHA256) ────────────────────────────────────────────────

async function hmac(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body   = b64url({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 30 });
  const sig    = await hmac(JWT_SECRET, `${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  try {
    const [header, body, sig] = token.split(".");
    const expected = await hmac(JWT_SECRET, `${header}.${body}`);
    if (sig !== expected) return null;
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function hashPassword(pwd: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(pwd + JWT_SECRET));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function money(v: unknown): number {
  const n = parseFloat(String(v == null ? "" : v).replace(/\s/g, "").replace(/[^\d.,-]/g, "").replace(",", "."));
  return isFinite(n) && n > 0 ? n : 0;
}

function abs(u: string, base: string): string {
  try { return new URL(u, base).href; } catch { return u; }
}

function dec(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#x2f;/gi, "/").replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function scrape(u: string): Promise<{ image: string; title: string }> {
  const res = await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    },
    redirect: "follow",
  });
  const h = await res.text();
  const p = (re: RegExp) => { const m = h.match(re); return m ? m[1] : null; };
  let img = p(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i)
    || p(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || p(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    || p(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i)
    || p(/<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i)
    || p(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
  if (!img) {
    const m = h.match(/"image"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/i)
      || h.match(/"image"\s*:\s*\[\s*"(https?:\\?\/\\?\/[^"]+)"/i);
    if (m) img = m[1].replace(/\\\//g, "/");
  }
  let title = p(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || p(/<title[^>]*>([^<]+)<\/title>/i);
  if (img) img = abs(dec(img.trim()), res.url || u);
  if (title) title = dec(title.trim());
  return { image: img || "", title: title || "" };
}

// to : destinataire explicite (e-mail du propriétaire de la liste).
// Si absent, repli sur NOTIFY_EMAIL (liste legacy).
// Si le destinataire est un e-mail bypass (domaine test), la notification est silencieuse.
async function notify(subject: string, lines: string[], to?: string): Promise<void> {
  const key      = Deno.env.get("RESEND_API_KEY") || "";
  const fallback = Deno.env.get("NOTIFY_EMAIL") || "";
  const dest     = to || fallback;
  const from     = Deno.env.get("NOTIFY_FROM") || "Liste de naissance <onboarding@resend.dev>";
  if (!key || !dest || isBypass(dest)) return;          // silencieux pour les comptes test
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "authorization": "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [dest], subject, text: lines.filter(Boolean).join("\n") }),
    });
  } catch { /* silencieux */ }
}

// Récupère l'e-mail du propriétaire d'une liste à partir de son user_id.
// Pour la liste legacy (uid = null), retourne undefined → repli sur NOTIFY_EMAIL.
async function ownerEmail(uid: string | null): Promise<string | undefined> {
  if (!uid) return undefined;
  const { data } = await supa.from("users").select("email").eq("id", uid).single();
  return (data?.email as string) || undefined;
}

// Récupère le user_id depuis le JWT dans l'Authorization header
async function userFromReq(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || req.headers.get("x-user-token") || "";
  const token = auth.replace(/^bearer\s+/i, "");
  if (!token) return null;
  const payload = await verifyJwt(token);
  return (payload?.sub as string) || null;
}

// ── Ancienne auth par parent_code (compatibilité liste mono-user) ────────────

async function checkCode(code: unknown, userId: string | null): Promise<boolean> {
  if (!userId) {
    // Legacy : cherche dans config sans user_id
    const { data } = await supa.from("config").select("parent_code").is("user_id", null).eq("id", 1).single();
    return !!(data && code && data.parent_code === code);
  }
  const { data } = await supa.from("config").select("parent_code").eq("user_id", userId).single();
  return !!(data && code && data.parent_code === code);
}

// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // ── GET ?action=state&slug=xxx ───────────────────────────────────────────
  if (req.method === "GET" && url.searchParams.get("action") === "state") {
    const slug = url.searchParams.get("slug");
    let userId: string | null = null;

    if (slug) {
      const { data: u } = await supa.from("users").select("id").eq("slug", slug).single();
      userId = u?.id || null;
    }

    let giftsQ = supa.from("gifts")
      .select("id,name,description,price,url,image,category,emoji,parent_bought,reserved_by,pos,fit,posy,funded,essential");

    if (userId) {
      giftsQ = giftsQ.eq("user_id", userId);
    } else {
      giftsQ = giftsQ.is("user_id", null);
    }

    const { data: gifts } = await giftsQ
      .order("pos", { ascending: true })
      .order("created_at", { ascending: true });

    let cfgQ = supa.from("config")
      .select("iban,beneficiary,term_date,message,wero,word_title,hero_sub,merci,cagnotte_url,notes,cat_order,hero_pattern");

    if (userId) {
      cfgQ = cfgQ.eq("user_id", userId);
    } else {
      cfgQ = cfgQ.is("user_id", null);
    }

    const { data: cfg } = await cfgQ.limit(1).single();
    return json({ gifts: gifts || [], config: cfg || {} });
  }

  // ── GET ?action=scrape_all ───────────────────────────────────────────────
  if (req.method === "GET" && url.searchParams.get("action") === "scrape_all") {
    const userId = await userFromReq(req);
    const code   = url.searchParams.get("code");
    const authed = userId ? true : await checkCode(code, null);
    if (!authed) return json({ error: "unauthorized" }, 403);

    let q = supa.from("gifts").select("id,url").neq("url", "").eq("image", "").limit(10);
    if (userId) q = q.eq("user_id", userId); else q = q.is("user_id", null);
    const { data: gifts } = await q;

    let updated = 0;
    if (gifts && gifts.length) {
      await Promise.all(gifts.map(async (g) => {
        try {
          const r = await scrape(g.url);
          if (r.image) { await supa.from("gifts").update({ image: r.image }).eq("id", g.id); updated++; }
          else { await supa.from("gifts").update({ image: "-" }).eq("id", g.id); }
        } catch { try { await supa.from("gifts").update({ image: "-" }).eq("id", g.id); } catch { /**/ } }
      }));
    }
    let countQ = supa.from("gifts").select("id", { count: "exact", head: true }).neq("url", "").eq("image", "");
    if (userId) countQ = countQ.eq("user_id", userId); else countQ = countQ.is("user_id", null);
    const { count } = await countQ;
    return json({ updated, remaining: count || 0 });
  }

  // ── GET nu : legacy ──────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { data } = await supa.from("site").select("html").eq("id", 1).single();
    return new Response((data && data.html) || "", { headers: { ...CORS, "content-type": "text/html; charset=utf-8" } });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    let b: Record<string, unknown>;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const a = b.action as string;

    // ── AUTH : register ───────────────────────────────────────────────────
    if (a === "register") {
      const email    = String(b.email || "").trim().toLowerCase();
      const password = String(b.password || "");
      const prenom1  = String(b.prenom1 || "").trim().slice(0, 40);
      const prenom2  = String(b.prenom2 || "").trim().slice(0, 40);
      const termDate = b.term_date ? String(b.term_date) : null;

      if (!email || !password || !prenom1 || !prenom2)
        return json({ error: "missing_fields" }, 400);
      // Les adresses bypass (@BYPASS_DOMAIN) ne doivent pas passer la validation
      // de format stricte mais doivent quand même contenir un @.
      if (!isBypass(email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return json({ error: "invalid_email" }, 400);
      if (password.length < 6)
        return json({ error: "password_too_short" }, 400);

      const { data: existing } = await supa.from("users").select("id").eq("email", email).single();
      if (existing) return json({ error: "email_exists" }, 409);

      const hash = await hashPassword(password);
      const { data: slugData } = await supa.rpc("make_slug", { p1: prenom1, p2: prenom2 });
      const slug = slugData as string;

      const { data: user, error: uErr } = await supa.from("users").insert({
        email, password_hash: hash, slug, prenom1, prenom2,
        term_date: termDate,
      }).select("id,slug").single();

      if (uErr || !user) return json({ error: uErr?.message || "register_failed" }, 400);

      // Créer la ligne config associée
      await supa.from("config").insert({
        id: 1, user_id: user.id,
        beneficiary: `${prenom1} & ${prenom2}`,
        term_date: termDate || "2026-12-31",
        word_title: `Merci d'être là pour ${prenom1 === prenom2 ? "eux" : "eux"}`,
        hero_sub: `Nous attendons notre bébé. Voici notre liste de naissance.`,
        merci: `Merci pour lui ❤️`,
      });

      const token = await signJwt({ sub: user.id, email, slug: user.slug });
      return json({ ok: true, token, slug: user.slug, user_id: user.id });
    }

    // ── AUTH : login ──────────────────────────────────────────────────────
    if (a === "login") {
      // Login JWT (nouveau système)
      if (b.email) {
        const email    = String(b.email).trim().toLowerCase();
        const password = String(b.password || "");
        const hash     = await hashPassword(password);
        const { data: user } = await supa.from("users")
          .select("id,email,slug").eq("email", email).eq("password_hash", hash).single();
        if (!user) return json({ error: "bad_credentials" }, 403);
        const token = await signJwt({ sub: user.id, email: user.email, slug: user.slug });
        return json({ ok: true, token, slug: user.slug, user_id: user.id });
      }
      // Legacy : login par parent_code
      const userId = await userFromReq(req);
      return (await checkCode(b.code, userId))
        ? json({ ok: true })
        : json({ error: "bad code" }, 403);
    }

    // ── AUTH : me (vérifie le token) ───────────────────────────────────────
    if (a === "me") {
      const userId = await userFromReq(req);
      if (!userId) return json({ error: "unauthorized" }, 401);
      const { data: user } = await supa.from("users")
        .select("id,email,slug,prenom1,prenom2,term_date,setup_done").eq("id", userId).single();
      if (!user) return json({ error: "not_found" }, 404);
      return json({ ok: true, user });
    }

    // ── AUTH : setup_done ─────────────────────────────────────────────────
    if (a === "setup_done") {
      const userId = await userFromReq(req);
      if (!userId) return json({ error: "unauthorized" }, 401);
      await supa.from("users").update({ setup_done: true }).eq("id", userId);
      return json({ ok: true });
    }

    // ======================= ACTIONS PUBLIQUES ==============================
    // Pour les actions publiques, on identifie la liste par le slug dans b.slug
    // ou par le user_id dans le token

    async function resolveUserId(): Promise<string | null> {
      const fromToken = await userFromReq(req);
      if (fromToken) return fromToken;
      if (b.slug) {
        const { data } = await supa.from("users").select("id").eq("slug", String(b.slug)).single();
        return data?.id || null;
      }
      return null; // liste legacy (user_id IS NULL)
    }

    if (a === "reserve") {
      if (!b.name || !b.id) return json({ error: "missing" }, 400);
      const uid = await resolveUserId();
      let q = supa.from("gifts")
        .update({ reserved_by: String(b.name).slice(0, 60), reserved_at: new Date().toISOString() })
        .eq("id", b.id).is("reserved_by", null);
      const { data } = await q.select();
      if (!data || !data.length) return json({ error: "already reserved" }, 409);
      const gname = (data[0] && data[0].name) || "un cadeau";
      await notify("🎁 Cadeau réservé sur votre liste", [
        "Cadeau : " + gname,
        "Par : " + String(b.name),
        b.message ? "Message : " + String(b.message) : "",
      ], await ownerEmail(uid));
      if (b.message) {
        await supa.from("contributions").insert({
          name: String(b.name).slice(0, 60), message: String(b.message).slice(0, 500),
          method: "", action: "reservation", amount: "", gift_id: b.id,
          user_id: uid,
        });
      }
      return json({ ok: true });
    }

    if (a === "contribute") {
      const uid  = await resolveUserId();
      const gid  = b.gift_id || null;
      await supa.from("contributions").insert({
        name: String(b.name || "").slice(0, 60),
        message: String(b.message || "").slice(0, 500),
        method: String(b.method || "").slice(0, 20),
        action: String(b.act || "cagnotte").slice(0, 20),
        amount: String(b.amount || "").slice(0, 20),
        gift_id: gid,
        user_id: uid,
      });
      let atteint = false;
      if (gid) {
        try {
          const { data: g } = await supa.from("gifts").select("price,funded,reserved_by").eq("id", gid).single();
          const ajout = money(b.amount);
          if (g && !g.reserved_by && ajout > 0) {
            const avant = money(g.funded);
            const total = avant + ajout;
            const prix  = money(g.price);
            const u: Record<string, unknown> = { funded: total };
            if (prix > 0 && total >= prix) {
              u.reserved_by = avant > 0 ? "plusieurs participants" : (String(b.name || "").trim().slice(0, 60) || "un participant");
              u.reserved_at = new Date().toISOString();
              atteint = true;
            }
            await supa.from("gifts").update(u).eq("id", gid);
          }
        } catch { /**/ }
      }
      await notify("💌 Nouvelle participation à la cagnotte", [
        b.item ? "Pour : " + String(b.item) : "",
        "Par : " + (String(b.name || "") || "Anonyme"),
        b.amount ? "Montant : " + String(b.amount) : "",
        atteint ? "✅ Le montant total est atteint : le cadeau passe en réservé." : "",
      ], await ownerEmail(uid));
      return json({ ok: true, complete: atteint });
    }

    if (a === "guestbook") {
      const uid = await resolveUserId();
      await supa.from("contributions").insert({
        name: String(b.name || "").slice(0, 60),
        message: String(b.message || "").slice(0, 500),
        method: "", action: String(b.act || "mot").slice(0, 20), amount: "",
        user_id: uid,
      });
      await notify("💬 Nouveau message sur votre liste", [
        "Par : " + (String(b.name || "") || "Anonyme"),
        b.message ? "Message : " + String(b.message) : "",
      ], await ownerEmail(uid));
      return json({ ok: true });
    }

    // ============ ACTIONS PROTÉGÉES =========================================
    // Authentification : JWT (nouveau) ou parent_code (legacy)

    const jwtUserId = await userFromReq(req);
    const legacyOk  = !jwtUserId && (await checkCode(b.code, null));
    if (!jwtUserId && !legacyOk) return json({ error: "unauthorized" }, 403);

    // userId effectif pour toutes les requêtes protégées
    const uid = jwtUserId; // null = legacy (user_id IS NULL)

    function giftFilter(q: ReturnType<typeof supa.from>) {
      return uid ? q.eq("user_id", uid) : q.is("user_id", null);
    }
    function cfgFilter(q: ReturnType<typeof supa.from>) {
      return uid ? q.eq("user_id", uid) : q.is("user_id", null);
    }

    if (a === "messages") {
      let q = supa.from("contributions")
        .select("name,message,method,action,amount,created_at")
        .order("created_at", { ascending: false }).limit(300);
      if (uid) q = q.eq("user_id", uid); else q = q.is("user_id", null);
      const { data } = await q;
      return json({ messages: data || [] });
    }

    if (a === "scrape") {
      try { return json(await scrape(String(b.url))); } catch { return json({ image: "", title: "" }); }
    }

    if (a === "add") {
      if (!b.name) return json({ error: "name required" }, 400);
      let mxQ = supa.from("gifts").select("pos").order("pos", { ascending: false }).limit(1);
      if (uid) mxQ = mxQ.eq("user_id", uid); else mxQ = mxQ.is("user_id", null);
      const { data: mx } = await mxQ;
      const nextPos = (mx && mx[0] ? mx[0].pos : 0) + 1;
      const fit = (b.fit === "cover" ? "cover" : "contain");
      let posy = Number(b.posy);
      if (!isFinite(posy) || posy < 0 || posy > 100) posy = 50;
      const { error } = await supa.from("gifts").insert({
        name: String(b.name).slice(0, 120),
        description: b.description || "", price: b.price || "", url: b.url || "", image: b.image || "",
        category: b.category || "Cadeaux", emoji: b.emoji || "🎁",
        parent_bought: !!b.parent_bought, essential: !!b.essential,
        funded: money(b.funded), pos: nextPos, fit, posy: Math.round(posy),
        user_id: uid,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (a === "reorder") {
      if (!Array.isArray(b.ids) || !b.ids.length) return json({ error: "ids required" }, 400);
      const { data, error } = await supa.rpc("reorder_gifts", { p_ids: b.ids });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, updated: data || 0 });
    }

    if (a === "toggle_parent") {
      const { data: c } = await supa.from("gifts").select("parent_bought").eq("id", b.id).single();
      await supa.from("gifts").update({ parent_bought: !(c && c.parent_bought) }).eq("id", b.id);
      return json({ ok: true });
    }

    if (a === "toggle_essential") {
      const { data: c } = await supa.from("gifts").select("essential").eq("id", b.id).single();
      if (!c) return json({ error: "not found" }, 404);
      const v = !c.essential;
      await supa.from("gifts").update({ essential: v }).eq("id", b.id);
      return json({ ok: true, essential: v });
    }

    if (a === "free")   { await supa.from("gifts").update({ reserved_by: null, reserved_at: null }).eq("id", b.id); return json({ ok: true }); }
    if (a === "delete") { await supa.from("gifts").delete().eq("id", b.id); return json({ ok: true }); }
    if (a === "clear_image") { await supa.from("gifts").update({ image: "" }).eq("id", b.id); return json({ ok: true }); }

    if (a === "set_image") {
      if (!b.id) return json({ error: "id required" }, 400);
      const im = String(b.image || "").trim();
      if (im && !/^https?:\/\//i.test(im) && !/^data:image\//i.test(im))
        return json({ error: "adresse d'image invalide" }, 400);
      const { error } = await supa.from("gifts").update({ image: im }).eq("id", b.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (a === "edit") {
      if (!b.id) return json({ error: "id required" }, 400);
      const u: Record<string, unknown> = {};
      if (b.name !== undefined) {
        const n = String(b.name).trim().slice(0, 120);
        if (!n) return json({ error: "name required" }, 400);
        u.name = n;
      }
      if (b.price       !== undefined) u.price       = String(b.price).slice(0, 40);
      if (b.category    !== undefined) u.category    = String(b.category).slice(0, 60) || "Cadeaux";
      if (b.url         !== undefined) u.url         = String(b.url).slice(0, 600);
      if (b.description !== undefined) u.description = String(b.description).slice(0, 600);
      if (b.emoji       !== undefined) u.emoji       = String(b.emoji).slice(0, 8);
      if (b.fit         !== undefined) u.fit         = (b.fit === "cover" ? "cover" : "contain");
      if (b.posy !== undefined) {
        const py = Number(b.posy);
        if (isFinite(py) && py >= 0 && py <= 100) u.posy = Math.round(py);
      }
      if (b.parent_bought !== undefined) u.parent_bought = !!b.parent_bought;
      if (b.essential     !== undefined) u.essential     = !!b.essential;
      if (b.funded        !== undefined) u.funded        = money(b.funded);
      if (!Object.keys(u).length) return json({ error: "nothing to update" }, 400);
      const { error } = await supa.from("gifts").update(u).eq("id", b.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (a === "rename") {
      if (!b.id) return json({ error: "id required" }, 400);
      const nm = String(b.name || "").trim().slice(0, 60);
      if (!nm) return json({ error: "name required" }, 400);
      const { data } = await supa.from("gifts").update({ reserved_by: nm })
        .eq("id", b.id).not("reserved_by", "is", null).select();
      if (!data || !data.length) return json({ error: "ce cadeau n'est pas réservé" }, 409);
      return json({ ok: true });
    }

    if (a === "free_all") {
      let q = supa.from("gifts").update({ reserved_by: null, reserved_at: null })
        .not("reserved_by", "is", null);
      if (uid) q = q.eq("user_id", uid); else q = q.is("user_id", null);
      const { data } = await q.select("id");
      return json({ ok: true, freed: (data || []).length });
    }

    if (a === "wipe") {
      if (b.confirm !== "SUPPRIMER") return json({ error: "confirmation required" }, 400);
      let q = supa.from("gifts").delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (uid) q = q.eq("user_id", uid); else q = q.is("user_id", null);
      const { data } = await q.select("id");
      return json({ ok: true, deleted: (data || []).length });
    }

    if (a === "save_config") {
      const u: Record<string, unknown> = {
        wero: b.wero, beneficiary: b.beneficiary, message: b.message,
        word_title: b.word_title, hero_sub: b.hero_sub, merci: b.merci,
        cagnotte_url: b.cagnotte_url,
      };
      if (b.hero_pattern !== undefined) u.hero_pattern = String(b.hero_pattern).slice(0, 60);
      if (b.term_date) u.term_date = b.term_date;
      if (b.new_code) u.parent_code = String(b.new_code).slice(0, 40);
      if (b.notes && typeof b.notes === "object" && !Array.isArray(b.notes)) {
        const n: Record<string, string> = {};
        for (const k of Object.keys(b.notes as object)) {
          const t = String((b.notes as Record<string,unknown>)[k] ?? "").slice(0, 2000).trim();
          if (t) n[String(k).slice(0, 60)] = t;
        }
        u.notes = n;
      }
      if (Array.isArray(b.cat_order)) {
        u.cat_order = (b.cat_order as unknown[]).map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 40);
      }
      if (uid) {
        await supa.from("config").update(u).eq("user_id", uid);
      } else {
        await supa.from("config").update(u).is("user_id", null);
      }
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  }

  return json({ error: "method" }, 405);
});
