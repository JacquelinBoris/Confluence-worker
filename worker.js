// ============================================================
// Confluence — Cloudflare Worker
// Fait tourner le pipeline des 8 agents Gemini côté serveur.
// Gratuit, aucune carte bancaire requise (Cloudflare Workers Free).
// La clé Gemini est stockée en secret Cloudflare, jamais exposée au client.
// ============================================================

const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const AGENT_TIMEOUT_MS = 40000; // 40s par défaut
const AGENT_TIMEOUT_OVERRIDES = { economicCalendar: 45000, coach: 55000 }; // ces agents réfléchissent plus longtemps
const MAX_RETRIES = 2; // Google a un bug connu de 404 intermittent sur ce modèle, on retente

// ---------- CORS ----------
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ---------- Schémas JSON stricts pour chaque agent ----------
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
      evolution_video: { type: "string" },
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
Analyse l'image fournie et extrait UNIQUEMENT les faits visibles, sans interprétation stratégique.
Si une courte vidéo du graphique est aussi fournie, utilise-la pour décrire la dynamique récente du
marché (accélération, ralentissement, rejet en direct d'un niveau) dans le champ evolution_video. Si
aucune vidéo n'est fournie, indique 'aucune vidéo fournie' dans ce champ.`,
  priceAction: `Tu es IA-2, spécialiste PRICE ACTION pur (sans indicateurs), dans une équipe de 8 agents qui
analysent successivement le même graphique. Base-toi sur l'image et l'analyse de vision déjà fournies
dans cette conversation. Identifie : structure de marché, rejets de niveaux, mèches significatives,
zones de rupture potentielles.`,
  smartMoney: `Tu es IA-3, spécialiste SMART MONEY CONCEPTS / ICT, dans la même équipe. Base-toi sur
l'image et les analyses précédentes (vision, price action). Identifie : order blocks probables, zones
de liquidité, Fair Value Gaps (FVG), Break of Structure (BOS) / Change of Character (CHOCH).`,
  chartPatterns: `Tu es IA-4, spécialiste des FIGURES CHARTISTES (analyse technique classique), dans la
même équipe. Base-toi sur l'image et toutes les analyses précédentes. Identifie les figures potentielles :
triangles, épaule-tête-épaule, drapeaux, biseaux, double top/bottom, etc.`,
  indicators: `Tu es IA-5, spécialiste des INDICATEURS TECHNIQUES (RSI, MACD, EMA, Bollinger...), dans la
même équipe. Base-toi sur l'image et les analyses précédentes. Si peu d'indicateurs sont visibles sur le
graphique, dis-le clairement plutôt que d'inventer des valeurs.`,
  riskManagement: `Tu es IA-6, spécialiste GESTION DU RISQUE, dans la même équipe. Base-toi sur les biais
de tous les agents précédents (price action, smart money, figures, indicateurs) pour proposer une gestion
de risque prudente. Ne présente jamais un niveau comme une certitude : ce sont des scénarios possibles,
jamais une garantie de gain.`,
  economicCalendar: `Tu es IA-7, spécialiste du CALENDRIER ÉCONOMIQUE, dans la même équipe. Utilise l'outil
google_search pour identifier les annonces économiques importantes prévues dans les prochaines 24 à 48h
pour l'actif identifié par l'agent de vision (taux directeurs, inflation/CPI, emploi/NFP, décisions de
banques centrales, résultats trimestriels si c'est une action). Indique la date/heure quand tu la trouves.
Sois honnête si tu ne trouves rien de fiable plutôt que d'inventer un événement.`,
  coach: `Tu es IA-8, le COACH qui synthétise TOUT le travail de l'équipe (vision, price action, smart
money, figures chartistes, indicateurs, gestion du risque, calendrier économique) en UNE fiche de trade
claire et actionnable.

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

const AGENT_ORDER = ["priceAction", "smartMoney", "chartPatterns", "indicators", "riskManagement", "economicCalendar", "coach"];
const AGENT_TOOLS = { economicCalendar: [{ type: "google_search" }] };

// ---------- Appel Gemini avec timeout ----------
async function callInteraction({ apiKey, systemInstruction, input, previousInteractionId, tools, schema, agentKey }) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callInteractionOnce({ apiKey, systemInstruction, input, previousInteractionId, tools, schema, agentKey });
    } catch (err) {
      lastError = err;
      // Ne retente que sur les erreurs transitoires connues (404 intermittent, 429, 5xx)
      const retriable = /\(404\)|\(429\)|\(50[0-9]\)/.test(err.message);
      if (!retriable || attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function callInteractionOnce({ apiKey, systemInstruction, input, previousInteractionId, tools, schema, agentKey }) {
  const timeoutMs = AGENT_TIMEOUT_OVERRIDES[agentKey] || AGENT_TIMEOUT_MS;
  const body = {
    model: GEMINI_MODEL,
    system_instruction: systemInstruction,
    input,
    response_format: { type: "text", mime_type: "application/json", schema },
  };
  if (previousInteractionId) body.previous_interaction_id = previousInteractionId;
  if (tools) body.tools = tools;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Erreur Gemini (${res.status}) : ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const textStep = (data.steps || []).find(s => s.type === "model_output");
    const textBlock = textStep && textStep.content && textStep.content.find(c => c.type === "text");
    if (!textBlock) throw new Error("Réponse Gemini vide ou mal formée.");
    return { id: data.id, json: JSON.parse(textBlock.text) };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Timeout : l'agent n'a pas répondu en ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runPipeline(apiKey, imageBase64, mimeType, videoBase64, videoMimeType) {
  const results = {};

  const visionInput = [
    { type: "text", text: "Analyse ce graphique et extrait les données visibles." },
    { type: "image", data: imageBase64, mime_type: mimeType },
  ];
  if (videoBase64 && videoMimeType) {
    visionInput.push({ type: "video", data: videoBase64, mime_type: videoMimeType });
  }

  const visionRes = await callInteraction({
    apiKey, systemInstruction: PROMPTS.vision, input: visionInput, schema: SCHEMAS.vision, agentKey: "vision",
  });
  results.vision = visionRes.json;
  let previousInteractionId = visionRes.id;

  for (const key of AGENT_ORDER) {
    const stepRes = await callInteraction({
      apiKey,
      systemInstruction: PROMPTS[key],
      input: "Analyse le graphique selon ta spécialité, en tenant compte des analyses précédentes de l'équipe.",
      previousInteractionId,
      tools: AGENT_TOOLS[key],
      schema: SCHEMAS[key],
      agentKey: key,
    });
    results[key] = stepRes.json;
    previousInteractionId = stepRes.id;
  }

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

    if (!env.GEMINI_API_KEY) {
      return new Response(JSON.stringify({ error: "GEMINI_API_KEY non configurée sur le Worker." }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    try {
      const { imageBase64, mimeType, videoBase64, videoMimeType } = await request.json();
      if (!imageBase64 || !mimeType) {
        return new Response(JSON.stringify({ error: "Image (base64) et mimeType requis." }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      const results = await runPipeline(env.GEMINI_API_KEY, imageBase64, mimeType, videoBase64, videoMimeType);

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
