// ============================================================================
//  Fonction Edge `app` — API unique de la liste de naissance
//
//  Déployée sur Supabase, slug `app`, verify_jwt = FALSE (le site est public,
//  l'authentification de l'espace parents se fait par `parent_code`).
//
//  Cette fonction est le SEUL chemin d'accès à la base : elle utilise
//  SUPABASE_SERVICE_ROLE_KEY, qui contourne RLS. Voir supabase/schema.sql.
//
//  Reproduction fidèle de la version 17 en production, à une différence près :
//  la clé Resend et le destinataire, qui étaient codés en dur, passent par des
//  variables d'environnement (voir .env.example). Comportement identique.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,apikey,authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json" } });

/** Parse un prix ou un montant saisi librement ("39,90 €", "1 200.50") en nombre. */
function money(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(/\s/g, "").replace(/[^\d.,-]/g, "").replace(",", "."));
  return isFinite(n) && n > 0 ? n : 0;
}

async function checkCode(code) {
  const { data } = await supa.from("config").select("parent_code").eq("id", 1).single();
  return !!(data && code && data.parent_code === code);
}

function abs(u, base) {
  try { return new URL(u, base).href; } catch (_) { return u; }
}

function dec(s) {
  return s.replace(/&amp;/g, "&").replace(/&#x2f;/gi, "/").replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Récupère l'og:image et le titre d'une fiche produit marchande. */
async function scrape(u) {
  const res = await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    },
    redirect: "follow",
  });
  const h = await res.text();
  const p = (re) => { const m = h.match(re); return m ? m[1] : null; };
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

/** Notification e-mail via Resend. Silencieuse en cas d'échec ou de clé absente. */
async function notify(subject, lines) {
  const key = Deno.env.get("RESEND_API_KEY") || "";
  const to = Deno.env.get("NOTIFY_EMAIL") || "";
  const from = Deno.env.get("NOTIFY_FROM") || "Liste de naissance <onboarding@resend.dev>";
  if (!key || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "authorization": "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ from: from, to: [to], subject: subject, text: lines.filter(Boolean).join("\n") }),
    });
  } catch (_) {}
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // ---- GET ?action=state : tout ce dont le site a besoin au chargement ----
  if (req.method === "GET" && url.searchParams.get("action") === "state") {
    const { data: gifts } = await supa.from("gifts")
      .select("id,name,description,price,url,image,category,emoji,parent_bought,reserved_by,pos,fit,posy,funded,essential")
      .order("pos", { ascending: true })
      .order("created_at", { ascending: true });
    const { data: cfg } = await supa.from("config")
      .select("iban,beneficiary,term_date,message,wero,word_title,hero_sub,merci,cagnotte_url,notes,cat_order")
      .eq("id", 1).single();
    return json({ gifts: gifts || [], config: cfg || {} });
  }

  // ---- GET ?action=scrape_all : récupération des photos par lots de 10 ----
  if (req.method === "GET" && url.searchParams.get("action") === "scrape_all") {
    if (!(await checkCode(url.searchParams.get("code")))) return json({ error: "unauthorized" }, 403);
    const { data: gifts } = await supa.from("gifts").select("id,url").neq("url", "").eq("image", "").limit(10);
    let updated = 0;
    if (gifts && gifts.length) {
      await Promise.all(gifts.map(async (g) => {
        try {
          const r = await scrape(g.url);
          if (r.image) { await supa.from("gifts").update({ image: r.image }).eq("id", g.id); updated++; }
          else { await supa.from("gifts").update({ image: "-" }).eq("id", g.id); }
        } catch (_) {
          try { await supa.from("gifts").update({ image: "-" }).eq("id", g.id); } catch (_) {}
        }
      }));
    }
    const { count } = await supa.from("gifts").select("id", { count: "exact", head: true }).neq("url", "").eq("image", "");
    return json({ updated, remaining: count || 0 });
  }

  // ---- GET nu : ancien mode « site servi depuis la base ». Périmé : la
  //      production est servie par Netlify. Conservé pour compatibilité. ----
  if (req.method === "GET") {
    const { data } = await supa.from("site").select("html").eq("id", 1).single();
    return new Response((data && data.html) || "", { headers: { ...CORS, "content-type": "text/html; charset=utf-8" } });
  }

  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
    const a = b.action;

    // ======================= ACTIONS PUBLIQUES =============================

    // Réservation d'un cadeau. Le .is("reserved_by", null) rend l'opération
    // atomique : deux invités simultanés ne peuvent pas réserver le même objet.
    if (a === "reserve") {
      if (!b.name || !b.id) return json({ error: "missing" }, 400);
      const { data } = await supa.from("gifts")
        .update({ reserved_by: String(b.name).slice(0, 60), reserved_at: new Date().toISOString() })
        .eq("id", b.id).is("reserved_by", null).select();
      if (!data || !data.length) return json({ error: "already reserved" }, 409);
      const gname = (data[0] && data[0].name) || "un cadeau";
      await notify("Nouvelle réservation sur la liste", [
        "Action : réservation d'un cadeau",
        "Cadeau : " + gname,
        "Par : " + String(b.name),
        b.message ? "Message : " + String(b.message) : "",
      ]);
      if (b.message) {
        await supa.from("contributions").insert({
          name: String(b.name).slice(0, 60), message: String(b.message).slice(0, 500),
          method: "", action: "reservation", amount: "", gift_id: b.id,
        });
      }
      return json({ ok: true });
    }

    // Participation au financement. Cumule `funded` et bascule en réservé
    // dès que le prix est atteint.
    if (a === "contribute") {
      const gid = b.gift_id || null;
      await supa.from("contributions").insert({
        name: String(b.name || "").slice(0, 60),
        message: String(b.message || "").slice(0, 500),
        method: String(b.method || "").slice(0, 20),
        action: String(b.act || "cagnotte").slice(0, 20),
        amount: String(b.amount || "").slice(0, 20),
        gift_id: gid,
      });
      let atteint = false;
      if (gid) {
        try {
          const { data: g } = await supa.from("gifts").select("price,funded,reserved_by").eq("id", gid).single();
          const ajout = money(b.amount);
          if (g && !g.reserved_by && ajout > 0) {
            const avant = money(g.funded);
            const total = avant + ajout;
            const prix = money(g.price);
            const u = { funded: total };
            if (prix > 0 && total >= prix) {
              u.reserved_by = avant > 0 ? "plusieurs participants" : (String(b.name || "").trim().slice(0, 60) || "un participant");
              u.reserved_at = new Date().toISOString();
              atteint = true;
            }
            await supa.from("gifts").update(u).eq("id", gid);
          }
        } catch (_) {}
      }
      await notify("Nouvelle participation à la cagnotte", [
        "Action : participation à la cagnotte",
        b.item ? "Pour : " + String(b.item) : "",
        "Par : " + (String(b.name || "") || "Anonyme"),
        b.amount ? "Montant : " + String(b.amount) : "",
        b.method ? "Moyen : " + String(b.method) : "",
        b.message ? "Message : " + String(b.message) : "",
        atteint ? "Le montant total est atteint : le cadeau passe en réservé." : "",
      ]);
      return json({ ok: true, complete: atteint });
    }

    if (a === "guestbook") {
      await supa.from("contributions").insert({
        name: String(b.name || "").slice(0, 60),
        message: String(b.message || "").slice(0, 500),
        method: "", action: String(b.act || "mot").slice(0, 20), amount: "",
      });
      await notify("Nouveau mot dans le livre d'or", [
        "Action : " + String(b.act || "mot"),
        "Par : " + (String(b.name || "") || "Anonyme"),
        b.message ? "Message : " + String(b.message) : "",
      ]);
      return json({ ok: true });
    }

    if (a === "login") return (await checkCode(b.code)) ? json({ ok: true }) : json({ error: "bad code" }, 403);

    // ============ TOUT CE QUI SUIT EXIGE LE CODE PARENT ====================
    if (!(await checkCode(b.code))) return json({ error: "unauthorized" }, 403);

    if (a === "messages") {
      const { data } = await supa.from("contributions")
        .select("name,message,method,action,amount,created_at")
        .order("created_at", { ascending: false }).limit(300);
      return json({ messages: data || [] });
    }

    if (a === "scrape") {
      try { return json(await scrape(String(b.url))); } catch (_) { return json({ image: "", title: "" }); }
    }

    if (a === "add") {
      if (!b.name) return json({ error: "name required" }, 400);
      const { data: mx } = await supa.from("gifts").select("pos").order("pos", { ascending: false }).limit(1);
      const nextPos = (mx && mx[0] ? mx[0].pos : 0) + 1;
      const fit = (b.fit === "cover" ? "cover" : "contain");
      let posy = Number(b.posy);
      if (!isFinite(posy) || posy < 0 || posy > 100) posy = 50;
      const { error } = await supa.from("gifts").insert({
        name: String(b.name).slice(0, 120),
        description: b.description || "", price: b.price || "", url: b.url || "", image: b.image || "",
        category: b.category || "Cadeaux", emoji: b.emoji || "🎁",
        parent_bought: !!b.parent_bought, essential: !!b.essential,
        funded: money(b.funded), pos: nextPos, fit: fit, posy: Math.round(posy),
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // Réordonnancement atomique — voir reorder_gifts() dans schema.sql.
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

    if (a === "free") {
      await supa.from("gifts").update({ reserved_by: null, reserved_at: null }).eq("id", b.id);
      return json({ ok: true });
    }

    if (a === "delete") {
      await supa.from("gifts").delete().eq("id", b.id);
      return json({ ok: true });
    }

    if (a === "clear_image") {
      await supa.from("gifts").update({ image: "" }).eq("id", b.id);
      return json({ ok: true });
    }

    // Accepte une URL http(s) ou une data-URI (import de photo depuis l'appareil).
    if (a === "set_image") {
      if (!b.id) return json({ error: "id required" }, 400);
      const im = String(b.image || "").trim();
      if (im && !/^https?:\/\//i.test(im) && !/^data:image\//i.test(im)) {
        return json({ error: "adresse d'image invalide" }, 400);
      }
      const { error } = await supa.from("gifts").update({ image: im }).eq("id", b.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (a === "edit") {
      if (!b.id) return json({ error: "id required" }, 400);
      const u = {};
      if (b.name !== undefined) {
        const n = String(b.name).trim().slice(0, 120);
        if (!n) return json({ error: "name required" }, 400);
        u.name = n;
      }
      if (b.price !== undefined) u.price = String(b.price).slice(0, 40);
      if (b.category !== undefined) u.category = String(b.category).slice(0, 60) || "Cadeaux";
      if (b.url !== undefined) u.url = String(b.url).slice(0, 600);
      if (b.description !== undefined) u.description = String(b.description).slice(0, 600);
      if (b.emoji !== undefined) u.emoji = String(b.emoji).slice(0, 8);
      if (b.fit !== undefined) u.fit = (b.fit === "cover" ? "cover" : "contain");
      if (b.posy !== undefined) {
        const py = Number(b.posy);
        if (isFinite(py) && py >= 0 && py <= 100) u.posy = Math.round(py);
      }
      if (b.parent_bought !== undefined) u.parent_bought = !!b.parent_bought;
      if (b.essential !== undefined) u.essential = !!b.essential;
      if (b.funded !== undefined) u.funded = money(b.funded);
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
      const { data } = await supa.from("gifts").update({ reserved_by: null, reserved_at: null })
        .not("reserved_by", "is", null).select("id");
      return json({ ok: true, freed: (data || []).length });
    }

    if (a === "wipe") {
      if (b.confirm !== "SUPPRIMER") return json({ error: "confirmation required" }, 400);
      const { data } = await supa.from("gifts").delete()
        .neq("id", "00000000-0000-0000-0000-000000000000").select("id");
      return json({ ok: true, deleted: (data || []).length });
    }

    if (a === "save_config") {
      const u = {
        iban: b.iban, wero: b.wero, beneficiary: b.beneficiary, message: b.message,
        word_title: b.word_title, hero_sub: b.hero_sub, merci: b.merci, cagnotte_url: b.cagnotte_url,
      };
      if (b.term_date) u.term_date = b.term_date;
      if (b.new_code) u.parent_code = String(b.new_code).slice(0, 40);
      if (b.notes && typeof b.notes === "object" && !Array.isArray(b.notes)) {
        const n = {};
        for (const k of Object.keys(b.notes)) {
          const t = String(b.notes[k] == null ? "" : b.notes[k]).slice(0, 2000).trim();
          if (t) n[String(k).slice(0, 60)] = t;
        }
        u.notes = n;
      }
      if (Array.isArray(b.cat_order)) {
        u.cat_order = b.cat_order.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 40);
      }
      await supa.from("config").update(u).eq("id", 1);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  }

  return json({ error: "method" }, 405);
});
