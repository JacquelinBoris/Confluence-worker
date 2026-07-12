// ============================================================
// Confluence — Cloudflare Worker
// Pipeline 100% Groq : vision (llama-4-scout), raisonnement
// (llama-3.3-70b-versatile), calendrier économique avec recherche
// web intégrée (groq/compound). Gratuit, aucune carte bancaire.
// La clé Groq est stockée en secret Cloudflare, jamais exposée au client.
// ============================================================

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_TEXT_MODEL = "llama-3.3-70b-versatile";
const GROQ_COMPOUND_MODEL = "groq/compound";

const TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

// ---------- CORS ----------
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ---------- Schémas JSON (donnés en instructions au modèle, pas de validation stricte côté Groq) ----------
const SCHEMAS = {
  vision: {
    type: "object",
    properties: {
      actif: { type: "string" },
      unite_temps: { type: "string" },
      tendance_visuelle: { type: "string", enum: ["haussière", "baissière", "range", "indéterminée"] },
      bougies_recentes: { type: "string" },
      niveaux_supports_resistances: { type: "array", items: { type: "string" } },
      indicateurs_visibles: { type: "array", items: { type: "string" } },
      figures_visibles: { type: "array", items: { type: "string" } },
      volume_info: { type: "string" },
      qualite_image: { type: "string", enum: ["bonne", "moyenne", "mauvaise"] },
    },
    required: ["actif", "unite_temps", "tendance_visuelle", "qualite_image"],
  },
  economicCalendar: {
    type: "object",
    properties: {
      evenements_a_risque: { type: "array", items: { type: "string" } },
      niveau_risque_calendrier: { type: "string", enum: ["faible", "moyen", "élevé"] },
      recommandation: { type: "string" },
    },
    required: ["niveau_risque_calendrier", "recommandation"],
  },
  priceAction: {
    type: "object",
    properties: {
      structure_marche: { type: "string" },
      signaux_price_action: { type: "array", items: { type: "string" } },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["structure_marche", "biais", "confiance"],
  },
  smartMoney: {
    type: "object",
    properties: {
      order_blocks: { type: "array", items: { type: "string" } },
      zones_liquidite: { type: "array", items: { type: "string" } },
      fvg: { type: "array", items: { type: "string" } },
      bos_choch: { type: "string" },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["biais", "confiance"],
  },
  chartPatterns: {
    type: "object",
    properties: {
      figures_identifiees: { type: "array", items: { type: "string" } },
      objectif_theorique: { type: "string" },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["figures_identifiees", "biais", "confiance"],
  },
  indicators: {
    type: "object",
    properties: {
      interpretation_indicateurs: { type: "array", items: { type: "string" } },
      signaux_convergents_ou_divergents: { type: "string" },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["biais", "confiance"],
  },
  riskManagement: {
    type: "object",
    properties: {
      stop_loss_suggere: { type: "string" },
      take_profit_suggere: { type: "string" },
      ratio_risque_recompense: { type: "string" },
      taille_position_conseillee_pct_capital: { type: "string" },
      avertissement: { type: "string" },
    },
    required: ["stop_loss_suggere", "take_profit_suggere", "avertissement"],
  },
  coach: {
    type: "object",
    properties: {
      actif: { type: "string" },
      timeframe: { type: "string" },
      tendance: { type: "string", enum: ["haussière", "baissière", "range"] },
      supports: { type: "array", items: { type: "string" } },
      resistances: { type: "array", items: { type: "string" } },
      smc_bos_confirme: { type: "boolean" },
      smc_order_block: { type: "string" },
      smc_fvg_detecte: { type: "boolean" },
      chandeliers_patterns: { type: "array", items: { type: "string" } },
      rsi_valeur: { type: "string" },
      rsi_interpretation: { type: "string" },
      score_global_pct: { type: "integer" },
      scenario_privilegie: { type: "string" },
      entree_possible: { type: "string" },
      stop_loss: { type: "string" },
      take_profit: { type: "string" },
      ratio_risque_rendement: { type: "string" },
      risques: { type: "string" },
      alerte_calendrier: { type: "string" },
      annonce_a_risque_imminente: { type: "boolean" },
      synthese: { type: "string" },
    },
    required: [
      "actif", "timeframe", "tendance", "score_global_pct",
      "scenario_privilegie", "entree_possible", "stop_loss", "take_profit", "risques",
    ],
  },
};

// ---------- Instructions système par agent ----------
const PROMPTS = {
  vision: `Tu es IA-1, un agent de VISION spécialisé en lecture de graphiques boursiers/forex/crypto.
Analyse l'image fournie et extrait UNIQUEMENT les faits visibles, sans interprétation stratégique.`,

  priceAction: `Tu es IA-2, spécialiste PRICE ACTION pur (sans indicateurs), dans une équipe de 8 agents.
Tu ne vois pas l'image directement : base-toi uniquement sur les données structurées extraites par
l'agent de vision, fournies ci-dessous en JSON. Identifie : structure de marché, rejets de niveaux,
mèches significatives, zones de rupture potentielles.`,

  smartMoney: `Tu es IA-3, spécialiste SMART MONEY CONCEPTS / ICT, dans la même équipe. Base-toi sur les
données de vision et l'analyse price action fournies en JSON ci-dessous. Identifie : order blocks
probables, zones de liquidité, Fair Value Gaps (FVG), Break of Structure (BOS) / Change of Character (CHOCH).`,

  chartPatterns: `Tu es IA-4, spécialiste des FIGURES CHARTISTES (analyse technique classique), dans la
même équipe. Base-toi sur les données JSON fournies (vision et analyses précédentes). Identifie les
figures potentielles : triangles, épaule-tête-épaule, drapeaux, biseaux, double top/bottom, etc.`,

  indicators: `Tu es IA-5, spécialiste des INDICATEURS TECHNIQUES (RSI, MACD, EMA, Bollinger...), dans la
même équipe. Base-toi sur les données JSON fournies. Si peu d'indicateurs sont visibles selon l'agent de
vision, dis-le clairement plutôt que d'inventer des valeurs.`,

  riskManagement: `Tu es IA-6, spécialiste GESTION DU RISQUE, dans la même équipe. Base-toi sur les biais
de tous les agents précédents (JSON fourni : price action, smart money, figures, indicateurs) pour
proposer une gestion de risque prudente. Ne présente jamais un niveau comme une certitude : ce sont des
scénarios possibles, jamais une garantie de gain.`,

  economicCalendar: `Tu es IA-7, spécialiste du CALENDRIER ÉCONOMIQUE. Utilise ta recherche web pour
identifier les annonces économiques importantes prévues dans les prochaines 24 à 48h pour l'actif donné
(taux directeurs, inflation/CPI, emploi/NFP, décisions de banques centrales, résultats trimestriels si
c'est une action). Indique la date/heure quand tu la trouves. Sois honnête si tu ne trouves rien de
fiable plutôt que d'inventer un événement.

Réponds UNIQUEMENT avec un objet JSON valide respectant ce schéma, sans texte ni markdown autour :
${JSON.stringify(SCHEMAS.economicCalendar)}`,

  coach: `Tu es IA-8, le COACH qui synthétise TOUT le travail de l'équipe (vision, price action, smart
money, figures chartistes, indicateurs, gestion du risque, calendrier économique — tout fourni en JSON
ci-dessous) en UNE fiche de trade claire et actionnable.

Le score_global_pct doit refléter le niveau de confluence réel entre les agents (s'ils sont tous
d'accord sur le même biais avec de bons signaux techniques, le score est élevé ; s'ils se contredisent
ou si les signaux sont faibles, le score doit être bas — ne mets jamais un score élevé par défaut).

Le scenario_privilegie doit être une phrase claire du type "Le marché reste [haussier/baissier] tant
que le prix reste [au-dessus/en-dessous] de [niveau]".

entree_possible, stop_loss et take_profit doivent être des niveaux de prix cohérents avec les supports/
résistances et les order blocks identifiés par les agents précédents — jamais inventés au hasard.

Ne présente jamais ces niveaux comme une certitude : ce sont des scénarios possibles basés sur la
confluence des méthodes, jamais une garantie de gain. Mentionne dans "risques" au moins le risque des
annonces économiques ou d'une invalidation du scénario. Remplis "alerte_calendrier" avec un résumé court
du niveau de risque calendrier identifié par IA-7 — si le risque est élevé, baisse le score_global_pct
en conséquence, même si les signaux techniques sont bons.`,
};

const TEXT_AGENT_ORDER = ["priceAction", "smartMoney", "chartPatterns", "indicators", "riskManagement"];

// ---------- Utilitaire : extraire du JSON même si le modèle ajoute du texte/markdown autour ----------
function extractJson(raw) {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Impossible d'extraire du JSON valide de la réponse.");
  }
}

// ---------- Appel générique à l'API Groq (chat completions) avec retry ----------
async function callGroq({ apiKey, model, messages, useJsonMode, extraBody }) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGroqOnce({ apiKey, model, messages, useJsonMode, extraBody });
    } catch (err) {
      lastError = err;
      const is429 = /\(429\)/.test(err.message);
      const retriable = is429 || /\(50[0-9]\)/.test(err.message);
      if (!retriable || attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, is429 ? 15000 * (attempt + 1) : 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function callGroqOnce({ apiKey, model, messages, useJsonMode, extraBody }) {
  const body = { model, messages, temperature: 0.3, ...(extraBody || {}) };
  if (useJsonMode) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Erreur Groq (${res.status}) : ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("Réponse Groq vide ou mal formée.");
    return extractJson(content);
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Timeout Groq : pas de réponse en ${TIMEOUT_MS / 1000}s.`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------- Agents texte génériques (IA2-IA6, IA8) ----------
async function runTextAgent({ apiKey, agentKey, context }) {
  const systemPrompt = `${PROMPTS[agentKey]}

Réponds STRICTEMENT en JSON valide respectant ce schéma, sans texte ni markdown autour, sans commentaire :
${JSON.stringify(SCHEMAS[agentKey])}`;

  return callGroq({
    apiKey,
    model: GROQ_TEXT_MODEL,
    useJsonMode: true,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Données de l'équipe jusqu'ici (JSON) :\n${JSON.stringify(context, null, 2)}` },
    ],
  });
}

// ---------- Pipeline complet ----------
async function runPipeline(apiKey, imageBase64, mimeType) {
  const results = {};

  // IA-1 Vision (llama-4-scout, multimodal)
  results.vision = await callGroq({
    apiKey,
    model: GROQ_VISION_MODEL,
    useJsonMode: true,
    messages: [
      {
        role: "system",
        content: `${PROMPTS.vision}

Réponds STRICTEMENT en JSON valide respectant ce schéma, sans texte ni markdown autour :
${JSON.stringify(SCHEMAS.vision)}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyse ce graphique et extrait les données visibles." },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      },
    ],
  });

  // IA-2 à IA-6 (llama-3.3-70b-versatile, raisonnement texte, chacun voit le contexte accumulé)
  for (const key of TEXT_AGENT_ORDER) {
    results[key] = await runTextAgent({ apiKey, agentKey: key, context: results });
  }

  // IA-7 Calendrier économique (groq/compound, recherche web intégrée)
  results.economicCalendar = await callGroq({
    apiKey,
    model: GROQ_COMPOUND_MODEL,
    messages: [
      {
        role: "user",
        content: `${PROMPTS.economicCalendar}\n\nActif à analyser : ${results.vision.actif || "inconnu"}.`,
      },
    ],
  });

  // IA-8 Coach (llama-3.3-70b-versatile, voit absolument tout)
  results.coach = await runTextAgent({ apiKey, agentKey: "coach", context: results });

  return results;
}

// ---------- Point d'entrée du Worker ----------
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Méthode non autorisée." }), {
        status: 405, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
    if (!env.GROQ_API_KEY) {
      return new Response(JSON.stringify({ error: "GROQ_API_KEY non configurée sur le Worker." }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    try {
      const { imageBase64, mimeType } = await request.json();
      if (!imageBase64 || !mimeType) {
        return new Response(JSON.stringify({ error: "Image (base64) et mimeType requis." }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      const results = await runPipeline(env.GROQ_API_KEY, imageBase64, mimeType);

      return new Response(JSON.stringify({ success: true, results }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || "Erreur pendant l'analyse." }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
  },
};
