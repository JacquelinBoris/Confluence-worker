// ============================================================
// Confluence — Cloudflare Worker
// Pipeline 100% Groq : vision (llama-4-scout), raisonnement
// (llama-3.3-70b-versatile), calendrier économique avec recherche
// web intégrée (groq/compound). Gratuit, aucune carte bancaire.
// La clé Groq est stockée en secret Cloudflare, jamais exposée au client.
// ============================================================

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_VISION_MODEL = "qwen/qwen3.6-27b"; // remplace llama-4-scout (déprécié le 17/06/2026)
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b"; // remplace llama-3.3-70b-versatile (déprécié le 17/06/2026)
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
      confiance: { type: "integer" },
    },
    required: ["actif", "unite_temps", "tendance_visuelle", "qualite_image", "confiance"],
  },
  economicCalendar: {
    type: "object",
    properties: {
      evenements_a_risque: { type: "array", items: { type: "string" } },
      niveau_risque_calendrier: { type: "string", enum: ["faible", "moyen", "élevé"] },
      recommandation: { type: "string" },
      confiance: { type: "integer" },
    },
    required: ["niveau_risque_calendrier", "recommandation", "confiance"],
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
      confiance: { type: "integer" },
    },
    required: ["stop_loss_suggere", "take_profit_suggere", "avertissement", "confiance"],
  },
  volumeLiquidity: {
    type: "object",
    properties: {
      volume_tendance: { type: "string" },
      zones_liquidite_majeures: { type: "array", items: { type: "string" } },
      spike_volume_detecte: { type: "boolean" },
      interpretation: { type: "string" },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["interpretation", "biais", "confiance"],
  },
  multiTimeframe: {
    type: "object",
    properties: {
      contexte_probable_htf: { type: "string" },
      alignement_htf_ltf: { type: "string", enum: ["aligné", "divergent", "incertain"] },
      timeframe_recommande_confirmation: { type: "string" },
      limite_analyse: { type: "string" },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["alignement_htf_ltf", "limite_analyse", "biais", "confiance"],
  },
  volatility: {
    type: "object",
    properties: {
      regime_volatilite: { type: "string", enum: ["faible", "normale", "élevée", "extrême"] },
      amplitude_bougies: { type: "string" },
      atr_estime: { type: "string" },
      impact_sur_risque: { type: "string" },
      confiance: { type: "integer" },
    },
    required: ["regime_volatilite", "impact_sur_risque", "confiance"],
  },
  marketSentiment: {
    type: "object",
    properties: {
      sentiment_global: { type: "string", enum: ["haussier", "baissier", "neutre", "mitigé"] },
      sources_sentiment: { type: "array", items: { type: "string" } },
      fear_greed_estime: { type: "string" },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["sentiment_global", "biais", "confiance"],
  },
  correlation: {
    type: "object",
    properties: {
      actifs_correles: { type: "array", items: { type: "string" } },
      correlation_notable: { type: "string" },
      impact_sur_scenario: { type: "string" },
      biais: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      confiance: { type: "integer" },
    },
    required: ["correlation_notable", "biais", "confiance"],
  },
  fakeSignalDetection: {
    type: "object",
    properties: {
      risque_fake_breakout: { type: "string", enum: ["faible", "moyen", "élevé"] },
      signaux_suspects: { type: "array", items: { type: "string" } },
      pieges_potentiels: { type: "array", items: { type: "string" } },
      recommandation: { type: "string" },
      confiance: { type: "integer" },
    },
    required: ["risque_fake_breakout", "recommandation", "confiance"],
  },
  probabilityEngine: {
    type: "object",
    properties: {
      probabilite_hausse_pct: { type: "integer" },
      probabilite_baisse_pct: { type: "integer" },
      probabilite_range_pct: { type: "integer" },
      scenario_le_plus_probable: { type: "string" },
      methodologie: { type: "string" },
      confiance: { type: "integer" },
    },
    required: ["probabilite_hausse_pct", "probabilite_baisse_pct", "probabilite_range_pct", "scenario_le_plus_probable", "confiance"],
  },
  backtesting: {
    type: "object",
    properties: {
      patterns_historiques_similaires: { type: "array", items: { type: "string" } },
      taux_reussite_estime_pct: { type: "integer" },
      limite_donnees: { type: "string" },
      recommandation: { type: "string" },
      confiance: { type: "integer" },
    },
    required: ["taux_reussite_estime_pct", "limite_donnees", "recommandation", "confiance"],
  },
  consensusEngine: {
    type: "object",
    properties: {
      agents_haussier: { type: "integer" },
      agents_baissier: { type: "integer" },
      agents_neutre: { type: "integer" },
      score_consensus_pct: { type: "integer" },
      biais_dominant: { type: "string", enum: ["haussier", "baissier", "neutre"] },
      synthese_divergences: { type: "string" },
    },
    required: ["score_consensus_pct", "biais_dominant", "synthese_divergences"],
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
      probabilite_scenario_principal_pct: { type: "integer" },
      regime_volatilite: { type: "string" },
      risque_fake_signal: { type: "string" },
      consensus_score_pct: { type: "integer" },
      confiance: { type: "integer" },
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

  volumeLiquidity: `Tu es IA-8, spécialiste VOLUME & LIQUIDITÉ, dans la même équipe. Base-toi sur les
données JSON fournies (vision, price action, smart money, figures, indicateurs, gestion du risque). Si
l'agent de vision n'a pas rapporté d'information de volume fiable, dis-le clairement plutôt que d'inventer
des chiffres. Identifie les zones de liquidité majeures (au-dessus des plus hauts / en-dessous des plus
bas récents) et tout pic de volume notable sur cassure.`,

  multiTimeframe: `Tu es IA-9, spécialiste MULTI-TIMEFRAME, dans la même équipe. Tu ne vois qu'un seul
graphique sur un seul timeframe (donné par l'agent de vision) : tu ne peux donc pas observer directement
les timeframes supérieurs ou inférieurs. Raisonne uniquement par déduction probable à partir de la
structure, de la tendance et des niveaux déjà identifiés par l'équipe, et sois explicite dans
"limite_analyse" sur le fait que ceci est une estimation, pas une lecture directe d'un autre timeframe.
Recommande quel timeframe l'utilisateur devrait consulter pour confirmer le scénario.`,

  volatility: `Tu es IA-10, spécialiste VOLATILITÉ, dans la même équipe. Base-toi sur la description des
bougies et de leur amplitude fournie par l'agent de vision et sur les niveaux déjà identifiés. Estime le
régime de volatilité actuel et son impact concret sur le dimensionnement du risque (stop plus large si
volatilité élevée, etc.). N'invente pas de valeur d'ATR précise si l'image ne permet pas de la déduire :
donne alors une fourchette qualitative.`,

  marketSentiment: `Tu es IA-11, spécialiste SENTIMENT DE MARCHÉ. Utilise ta recherche web pour évaluer le
sentiment actuel (positionnement des traders, ton des news financières récentes, indices de peur/avidité
si disponibles) sur l'actif donné. Sois honnête si tu ne trouves pas d'information fiable récente plutôt
que d'inventer un sentiment.

Réponds UNIQUEMENT avec un objet JSON valide respectant ce schéma, sans texte ni markdown autour :
${JSON.stringify(SCHEMAS.marketSentiment)}`,

  correlation: `Tu es IA-12, spécialiste CORRÉLATIONS INTERMARCHÉS. Utilise ta recherche web pour
identifier les actifs les plus corrélés (ex. DXY, indices actions, or, pétrole, taux obligataires selon le
cas) et si leur comportement récent confirme ou contredit le scénario technique de l'actif analysé. Sois
honnête si tu ne trouves rien de fiable plutôt que d'inventer une corrélation.

Réponds UNIQUEMENT avec un objet JSON valide respectant ce schéma, sans texte ni markdown autour :
${JSON.stringify(SCHEMAS.correlation)}`,

  fakeSignalDetection: `Tu es IA-13, spécialiste DÉTECTION DE FAUX SIGNAUX, dans la même équipe. Base-toi
sur l'ensemble des données JSON fournies (price action, smart money, figures, indicateurs, volume). Ton
rôle est d'être le sceptique de l'équipe : cherche activement les raisons pour lesquelles le scénario
dominant pourrait être un piège (fake breakout, divergence cachée, volume insuffisant pour confirmer une
cassure, sur-confluence suspecte). Ne minimise jamais un risque de faux signal pour "faire plaisir" au
scénario majoritaire.`,

  probabilityEngine: `Tu es IA-14, MOTEUR DE PROBABILITÉS, dans la même équipe. Base-toi sur les biais et
niveaux de confiance de tous les agents précédents (JSON fourni) pour attribuer des probabilités
approximatives aux trois scénarios (hausse / baisse / range). Les trois pourcentages doivent
approximativement totaliser 100. Précise dans "methodologie" que ce sont des probabilités qualitatives
issues de la confluence des agents, pas un calcul statistique rigoureux sur données historiques.`,

  backtesting: `Tu es IA-15, spécialiste BACKTESTING, dans la même équipe. Tu n'as pas accès à une base de
données historique réelle des prix : base-toi sur les figures et patterns déjà identifiés par l'équipe
(IA-4 figures chartistes, IA-3 smart money) et sur les statistiques de réussite généralement citées dans
la littérature technique pour ce type de figure. Indique clairement dans "limite_donnees" que ce taux de
réussite est une estimation générique issue de la littérature, pas un backtest exécuté sur cet actif
précis.`,

  consensusEngine: `Tu es IA-16, MOTEUR DE CONSENSUS, dans la même équipe. Compte, à partir des champs
"biais" de tous les agents précédents fournis en JSON (price action, smart money, figures, indicateurs,
volume/liquidité, multi-timeframe, sentiment, corrélation), combien sont haussiers, baissiers ou neutres.
Le score_consensus_pct doit refléter le degré d'accord réel entre agents (100% si tous d'accord, plus bas
s'ils divergent). Dans "synthese_divergences", nomme explicitement les agents qui ne sont pas alignés avec
la majorité et pourquoi cela peut arriver.`,

  coach: `Tu es IA-17, le COACH qui synthétise TOUT le travail de l'équipe (vision, price action, smart
money, figures chartistes, indicateurs, gestion du risque, calendrier économique, volume/liquidité,
multi-timeframe, volatilité, sentiment de marché, corrélations, détection de faux signaux, moteur de
probabilités, backtesting et moteur de consensus — tout fourni en JSON ci-dessous) en UNE fiche de trade
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
en conséquence, même si les signaux techniques sont bons.

Remplis aussi : "probabilite_scenario_principal_pct" à partir du scénario le plus probable donné par IA-14 ;
"regime_volatilite" à partir du régime identifié par IA-10 ; "risque_fake_signal" à partir du niveau de
risque de faux signal identifié par IA-13 (si ce risque est élevé, mentionne-le explicitement dans
"risques" et baisse le score_global_pct) ; "consensus_score_pct" à partir du score de consensus calculé
par IA-16 — un consensus faible entre agents doit lui aussi faire baisser le score_global_pct, même si
certains signaux pris isolément semblent bons.`,
};

// Ordre d'exécution complet après la vision (IA-1) et avant le coach (IA-17).
// type "text"     -> raisonnement pur sur le contexte accumulé (GROQ_TEXT_MODEL)
// type "compound" -> recherche web intégrée (GROQ_COMPOUND_MODEL)
const AGENT_PIPELINE = [
  { key: "priceAction", type: "text" },
  { key: "smartMoney", type: "text" },
  { key: "chartPatterns", type: "text" },
  { key: "indicators", type: "text" },
  { key: "riskManagement", type: "text" },
  { key: "economicCalendar", type: "compound" },
  { key: "volumeLiquidity", type: "text" },
  { key: "multiTimeframe", type: "text" },
  { key: "volatility", type: "text" },
  { key: "marketSentiment", type: "compound" },
  { key: "correlation", type: "compound" },
  { key: "fakeSignalDetection", type: "text" },
  { key: "probabilityEngine", type: "text" },
  { key: "backtesting", type: "text" },
  { key: "consensusEngine", type: "text" },
];

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

// ---------- Instruction partagée : chaque agent doit noter SA PROPRE confiance ----------
const CONFIDENCE_INSTRUCTION = `Le champ "confiance" (0-100) doit refléter TA propre confiance dans TA
analyse (qualité/clarté des données dont tu disposais, cohérence interne de ton raisonnement) — ce n'est
pas le score de confluence global de l'équipe. Sois honnête : si les données sont pauvres ou ambiguës,
donne une confiance basse plutôt qu'un chiffre optimiste par défaut.`;

// ---------- Agents texte génériques (IA2-IA6, IA8) ----------
async function runTextAgent({ apiKey, agentKey, context }) {
  const systemPrompt = `${PROMPTS[agentKey]}

${CONFIDENCE_INSTRUCTION}

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

// ---------- Agents "compound" génériques (recherche web intégrée : IA-7, IA-11, IA-12) ----------
async function runCompoundAgent({ apiKey, agentKey, results }) {
  const actif = (results.vision && results.vision.actif) || "actif inconnu";
  return callGroq({
    apiKey,
    model: GROQ_COMPOUND_MODEL,
    messages: [
      { role: "user", content: `${PROMPTS[agentKey]}\n\nActif à analyser : ${actif}.\n\n${CONFIDENCE_INSTRUCTION}` },
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

${CONFIDENCE_INSTRUCTION}

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

  // IA-2 à IA-16 : chacun voit le contexte accumulé par tous les agents précédents.
  // Les agents "compound" (IA-7, IA-11, IA-12) recherchent sur le web ; les autres raisonnent sur le JSON.
  for (const step of AGENT_PIPELINE) {
    results[step.key] = step.type === "compound"
      ? await runCompoundAgent({ apiKey, agentKey: step.key, results })
      : await runTextAgent({ apiKey, agentKey: step.key, context: results });
  }

  // IA-17 Coach (voit absolument tout, y compris les 15 agents ci-dessus)
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
