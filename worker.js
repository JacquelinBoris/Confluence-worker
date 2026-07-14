// ============================================================
// Confluence — Cloudflare Worker (v3)
// 17 agents, 100% Groq, gratuit, aucune carte bancaire.
// Architecture "par étape" : le client appelle ce Worker UNE FOIS PAR AGENT
// (au lieu d'un seul gros appel qui fait tout). Ça permet :
//  - un vrai suivi de progression (pas une animation simulée)
//  - de ne réessayer que l'agent en échec, sans perdre le travail déjà fait
// La clé Groq est stockée en secret Cloudflare, jamais exposée au client.
// ============================================================

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_VISION_MODEL = "qwen/qwen3.6-27b";
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
const GROQ_COMPOUND_MODEL = "groq/compound"; // recherche web intégrée

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

// ---------- Ordre officiel du pipeline (utilisé aussi côté client) ----------
const PIPELINE_ORDER = [
  "vision", "priceAction", "smartMoney", "chartPatterns", "indicators", "riskManagement",
  "economicCalendar", "volumeLiquidity", "multiTimeframe", "volatility", "marketSentiment",
  "correlation", "fakeSignalDetection", "probabilityEngine", "backtesting", "consensusEngine", "coach",
];

// Agents qui utilisent la recherche web (groq/compound)
const WEB_SEARCH_AGENTS = new Set(["economicCalendar", "marketSentiment"]);

// ---------- Schémas JSON (donnés en instruction au modèle) ----------
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
  economicCalendar: {
    type: "object",
    properties: {
      evenements_a_risque: { type: "array", items: { type: "string" } },
      niveau_risque_calendrier: { type: "string", enum: ["faible", "moyen", "élevé"] },
      recommandation: { type: "string" },
    },
    required: ["niveau_risque_calendrier", "recommandation"],
  },
  volumeLiquidity: {
    type: "object",
    properties: {
      analyse_volume: { type: "string" },
      zones_liquidite_supplementaires: { type: "array", items: { type: "string" } },
      anomalies_volume: { type: "string" },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["analyse_volume", "biais", "confiance"],
  },
  multiTimeframe: {
    type: "object",
    properties: {
      avertissement: { type: "string", description: "rappel qu'une seule unité de temps est analysée" },
      timeframes_a_verifier: { type: "array", items: { type: "string" } },
      coherence_probable: { type: "string" },
    },
    required: ["avertissement", "timeframes_a_verifier"],
  },
  volatility: {
    type: "object",
    properties: {
      regime_volatilite: { type: "string", enum: ["faible", "normal", "élevé"] },
      range_estime: { type: "string" },
      impact_sur_stop_loss: { type: "string" },
    },
    required: ["regime_volatilite", "impact_sur_stop_loss"],
  },
  marketSentiment: {
    type: "object",
    properties: {
      sentiment_general: { type: "string", enum: ["haussier", "baissier", "neutre", "mixte"] },
      resume: { type: "string" },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["sentiment_general", "resume"],
  },
  correlation: {
    type: "object",
    properties: {
      actifs_correles: { type: "array", items: { type: "string" } },
      coherence_avec_analyse: { type: "string" },
    },
    required: ["actifs_correles", "coherence_avec_analyse"],
  },
  fakeSignalDetection: {
    type: "object",
    properties: {
      risque_fake_breakout: { type: "string", enum: ["faible", "moyen", "élevé"] },
      signaux_alerte: { type: "array", items: { type: "string" } },
      recommandation: { type: "string" },
    },
    required: ["risque_fake_breakout", "recommandation"],
  },
  probabilityEngine: {
    type: "object",
    properties: {
      probabilite_succes_pct: { type: "integer" },
      methode: { type: "string", description: "explique que c'est une estimation de confluence, pas une garantie statistique" },
      facteurs_favorables: { type: "array", items: { type: "string" } },
      facteurs_defavorables: { type: "array", items: { type: "string" } },
    },
    required: ["probabilite_succes_pct", "methode"],
  },
  backtesting: {
    type: "object",
    properties: {
      statistiques_historiques_generales: { type: "string" },
      fiabilite_pattern: { type: "string" },
      avertissement: { type: "string", description: "préciser que ce sont des stats génériques sur ce type de pattern, pas l'historique personnel de l'utilisateur" },
    },
    required: ["statistiques_historiques_generales", "avertissement"],
  },
  consensusEngine: {
    type: "object",
    properties: {
      votes_haussier: { type: "integer" },
      votes_baissier: { type: "integer" },
      votes_neutre: { type: "integer" },
      consensus: { type: "string", enum: ["haussier", "baissier", "neutre", "partagé"] },
      score_accord_pct: { type: "integer" },
    },
    required: ["consensus", "score_accord_pct"],
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
  vision: `Tu es l'agent VISION spécialisé en lecture de graphiques boursiers/forex/crypto.
Analyse l'image fournie et extrait UNIQUEMENT les faits visibles, sans interprétation stratégique.`,

  priceAction: `Tu es l'agent PRICE ACTION pur (sans indicateurs), dans une équipe de 17 agents.
Tu ne vois pas l'image directement : base-toi uniquement sur les données JSON déjà produites par les
agents précédents, fournies ci-dessous. Identifie : structure de marché, rejets de niveaux, mèches
significatives, zones de rupture potentielles.`,

  smartMoney: `Tu es l'agent SMART MONEY CONCEPTS / ICT, dans la même équipe. Base-toi sur les données
JSON fournies (vision, price action). Identifie : order blocks probables, zones de liquidité, Fair
Value Gaps (FVG), Break of Structure (BOS) / Change of Character (CHOCH).`,

  chartPatterns: `Tu es l'agent FIGURES CHARTISTES (analyse technique classique), dans la même équipe.
Base-toi sur les données JSON fournies. Identifie les figures potentielles : triangles, épaule-tête-
épaule, drapeaux, biseaux, double top/bottom, etc.`,

  indicators: `Tu es l'agent INDICATEURS TECHNIQUES (RSI, MACD, EMA, Bollinger...), dans la même équipe.
Base-toi sur les données JSON fournies. Si peu d'indicateurs sont visibles selon l'agent de vision,
dis-le clairement plutôt que d'inventer des valeurs.`,

  riskManagement: `Tu es l'agent GESTION DU RISQUE, dans la même équipe. Base-toi sur les biais de tous
les agents précédents pour proposer une gestion de risque prudente. Ne présente jamais un niveau comme
une certitude : ce sont des scénarios possibles, jamais une garantie de gain.`,

  economicCalendar: `Tu es l'agent CALENDRIER ÉCONOMIQUE. Utilise ta recherche web pour identifier les
annonces économiques importantes prévues dans les prochaines 24 à 48h pour l'actif donné (taux
directeurs, inflation/CPI, emploi/NFP, décisions de banques centrales, résultats trimestriels si c'est
une action). Sois honnête si tu ne trouves rien de fiable plutôt que d'inventer un événement.`,

  volumeLiquidity: `Tu es l'agent VOLUME & LIQUIDITÉ, dans la même équipe. Base-toi sur les infos de
volume et de liquidité déjà extraites (vision, smart money). Identifie des zones de liquidité
supplémentaires, des anomalies de volume (pics, absence de volume sur une cassure), et ce que ça
implique.`,

  multiTimeframe: `Tu es l'agent MULTI-TIMEFRAME. Une seule capture d'écran (une seule unité de temps) a
été analysée par l'équipe. Ton rôle est d'alerter honnêtement sur les limites de cette analyse mono-
timeframe et de lister quelles autres unités de temps l'utilisateur devrait vérifier manuellement avant
de trader (ex : timeframe supérieure pour la tendance de fond, inférieure pour le timing d'entrée).`,

  volatility: `Tu es l'agent VOLATILITÉ, dans la même équipe. Base-toi sur les bougies et niveaux
décrits par l'agent de vision pour estimer le régime de volatilité actuel (faible/normal/élevé) et son
impact sur le placement du stop loss (plus de marge nécessaire si volatilité élevée).`,

  marketSentiment: `Tu es l'agent SENTIMENT DE MARCHÉ. Utilise ta recherche web pour évaluer le
sentiment général actuel (nouvelles récentes, ton des commentateurs) sur l'actif donné. Cite tes
sources si possible. Sois honnête si le sentiment est mitigé ou peu clair.`,

  correlation: `Tu es l'agent CORRÉLATION, dans la même équipe. Base-toi sur l'actif identifié pour
lister 1 à 3 actifs traditionnellement corrélés ou anti-corrélés (ex : DXY pour les paires EUR/USD,
pétrole pour CAD, Bitcoin pour les altcoins) et indique si cette corrélation générale renforce ou
contredit le scénario technique de l'équipe.`,

  fakeSignalDetection: `Tu es l'agent DÉTECTION DE FAUX SIGNAUX, dans la même équipe. Analyse tout le
travail des agents précédents d'un œil critique : y a-t-il des signes de fakeout probable, de cassure
sans volume, de divergence entre agents qui sentirait le piège ? Donne un niveau de risque et des
signaux d'alerte concrets.`,

  probabilityEngine: `Tu es l'agent PROBABILITÉ, dans la même équipe. Synthétise les niveaux de
confiance de tous les agents techniques précédents en une estimation de probabilité de succès du
scénario. Explique clairement dans "methode" qu'il s'agit d'une estimation basée sur la confluence des
signaux de l'équipe, PAS d'une statistique garantie ni d'un calcul actuariel réel.`,

  backtesting: `Tu es l'agent BACKTESTING, dans la même équipe. Tu n'as pas accès à un historique de
trades réel. Donne plutôt des statistiques génériques connues sur la fiabilité historique du type de
pattern/setup identifié par l'équipe (ex : "les cassures avec FVG confirmé ont historiquement un taux
de réussite plus élevé que sans confirmation"). Précise explicitement dans "avertissement" que ce sont
des généralités connues sur ce type de configuration, pas l'historique personnel de l'utilisateur.`,

  consensusEngine: `Tu es l'agent CONSENSUS, dans la même équipe. Compte les biais (haussier/baissier/
neutre) donnés par tous les agents techniques précédents et calcule un vote agrégé : nombre de votes
pour chaque biais, le consensus dominant, et un score d'accord en % (100% si tous les agents sont
d'accord, plus bas s'ils se contredisent).`,

  coach: `Tu es le COACH final qui synthétise TOUT le travail de l'équipe de 17 agents (fourni en JSON
ci-dessous) en UNE fiche de trade claire et actionnable.

Le score_global_pct doit refléter le niveau de confluence réel entre les agents, en tenant compte
notamment du consensus, du risque de faux signal, et de la probabilité estimée — pas seulement des
agents techniques de base. S'ils sont tous d'accord avec de bons signaux et peu de risque de fake
signal, le score est élevé ; s'ils se contredisent ou si le risque de faux signal est élevé, le score
doit être bas.

Le scenario_privilegie doit être une phrase claire du type "Le marché reste [haussier/baissier] tant
que le prix reste [au-dessus/en-dessous] de [niveau]".

entree_possible, stop_loss et take_profit doivent être des niveaux de prix cohérents avec les supports/
résistances et les order blocks identifiés par les agents précédents — jamais inventés au hasard, et
ajustés selon le régime de volatilité identifié.

Ne présente jamais ces niveaux comme une certitude : ce sont des scénarios possibles basés sur la
confluence des méthodes, jamais une garantie de gain. Mentionne dans "risques" le risque calendrier,
le risque de faux signal, et rappelle la limite mono-timeframe. Remplis "alerte_calendrier" avec un
résumé court du niveau de risque calendrier — si élevé, baisse le score_global_pct en conséquence.`,
};

// ---------- Extraction JSON tolérante (markdown, texte parasite) ----------
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

// ---------- Appel générique Groq avec retry ----------
async function callGroq({ apiKey, model, messages, useJsonMode }) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGroqOnce({ apiKey, model, messages, useJsonMode });
    } catch (err) {
      lastError = err;
      const is429 = /\(429\)/.test(err.message);
      const retriable = is429 || /\(50[0-9]\)/.test(err.message) || /\(413\)/.test(err.message);
      if (!retriable || attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, is429 ? 15000 * (attempt + 1) : 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function callGroqOnce({ apiKey, model, messages, useJsonMode }) {
  const body = { model, messages, temperature: 0.3 };
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

// ---------- Exécute UN SEUL agent (le client orchestre l'appel de chacun) ----------
async function runStep(apiKey, step, { imageBase64, mimeType, context }) {
  if (!PIPELINE_ORDER.includes(step)) throw new Error(`Étape inconnue : ${step}`);

  // Vision : seul agent multimodal (image)
  if (step === "vision") {
    return callGroq({
      apiKey,
      model: GROQ_VISION_MODEL,
      useJsonMode: true,
      messages: [
        {
          role: "system",
          content: `${PROMPTS.vision}\n\nRéponds STRICTEMENT en JSON valide respectant ce schéma, sans texte ni markdown autour :\n${JSON.stringify(SCHEMAS.vision)}`,
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
  }

  // Agents avec recherche web (calendrier, sentiment)
  if (WEB_SEARCH_AGENTS.has(step)) {
    const actif = (context.vision && context.vision.actif) || "inconnu";
    return callGroq({
      apiKey,
      model: GROQ_COMPOUND_MODEL,
      messages: [
        {
          role: "user",
          content: `${PROMPTS[step]}\n\nActif à analyser : ${actif}.\n\nRéponds UNIQUEMENT avec un objet JSON valide respectant ce schéma, sans texte ni markdown autour :\n${JSON.stringify(SCHEMAS[step])}`,
        },
      ],
    });
  }

  // Tous les autres agents : raisonnement texte pur sur le contexte accumulé
  const systemPrompt = `${PROMPTS[step]}\n\nRéponds STRICTEMENT en JSON valide respectant ce schéma, sans texte ni markdown autour, sans commentaire :\n${JSON.stringify(SCHEMAS[step])}`;
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
      const { step, imageBase64, mimeType, context } = await request.json();
      if (!step) {
        return new Response(JSON.stringify({ error: "Paramètre 'step' requis.", pipelineOrder: PIPELINE_ORDER }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }
      if (step === "vision" && (!imageBase64 || !mimeType)) {
        return new Response(JSON.stringify({ error: "Image (base64) et mimeType requis pour l'étape vision." }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      const result = await runStep(env.GROQ_API_KEY, step, { imageBase64, mimeType, context: context || {} });

      return new Response(JSON.stringify({ success: true, step, result }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || "Erreur pendant l'analyse." }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
  },
};
