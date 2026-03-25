const crypto = require("crypto");
const path = require("path");
const express = require("express");
const Razorpay = require("razorpay");
const { encrypt: sabpaisaEncrypt, decrypt: sabpaisaDecrypt } = require("sabpaisa-encryption-package-gcm");
require("dotenv").config();

const {
  getAllMatches,
  getMatchBySlug
} = require("./data/matches");

const app = express();
const port = Number(process.env.PORT) || 3000;
const liveRefreshIntervalMs = 20_000;
const feedProvider = (process.env.TICKET_FEED_PROVIDER || "mock").trim().toLowerCase();
const externalFeedUrl = process.env.TICKET_FEED_URL || "";
const externalFeedToken = process.env.TICKET_FEED_BEARER_TOKEN || "";
const checkoutProvider = (process.env.CHECKOUT_PROVIDER || "sabpaisa").trim().toLowerCase();
const matchStatusProvider = (process.env.MATCH_STATUS_PROVIDER || "thesportsdb")
  .trim()
  .toLowerCase();
const sportsDbApiKey = process.env.SPORTSDB_API_KEY || "3";
const sportsDbLeagueId = process.env.SPORTSDB_IPL_LEAGUE_ID || "4460";
const matchStatusRefreshMs = Math.max(
  15_000,
  Number(process.env.MATCH_STATUS_REFRESH_MS || 60_000) || 60_000
);
const razorpayKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "";
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || "";
const razorpayEnabled = Boolean(razorpayKeyId && razorpayKeySecret);
const ccavenueMerchantId = String(process.env.CCAVENUE_MERCHANT_ID || "").trim();
const ccavenueAccessCode = String(process.env.CCAVENUE_ACCESS_CODE || "").trim();
const ccavenueWorkingKey = String(process.env.CCAVENUE_WORKING_KEY || "").trim();
const ccavenueEnv = String(process.env.CCAVENUE_ENV || "test").trim().toLowerCase();
const ccavenueRedirectBaseUrl = String(process.env.CCAVENUE_REDIRECT_BASE_URL || "").trim();
const ccavenueEnabled = Boolean(
  ccavenueMerchantId && ccavenueAccessCode && ccavenueWorkingKey
);
const ccavenueGatewayUrl =
  ccavenueEnv === "production"
    ? "https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction"
    : "https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction";
const ccavenueIvBuffer = Buffer.from(
  [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]
);
const sabpaisaClientCode = String(process.env.SABPAISA_CLIENT_CODE || "").trim();
const sabpaisaTransUserName = String(process.env.SABPAISA_TRANS_USER_NAME || "").trim();
const sabpaisaTransUserPassword = String(process.env.SABPAISA_TRANS_USER_PASSWORD || "").trim();
const sabpaisaAuthKey = String(process.env.SABPAISA_AUTH_KEY || "").trim();
const sabpaisaAuthIV = String(process.env.SABPAISA_AUTH_IV || "").trim();
const sabpaisaEnv = String(process.env.SABPAISA_ENV || "stag").trim().toLowerCase();
const sabpaisaCallbackBaseUrl = String(process.env.SABPAISA_CALLBACK_BASE_URL || "").trim();
const sabpaisaChannelId = String(process.env.SABPAISA_CHANNEL_ID || "web").trim();
const sabpaisaEnabled = Boolean(
  sabpaisaClientCode &&
    sabpaisaTransUserName &&
    sabpaisaTransUserPassword &&
    sabpaisaAuthKey &&
    sabpaisaAuthIV
);

function getSabpaisaGatewayUrl(env) {
  if (env === "uat") {
    return "https://secure.sabpaisa.in/SabPaisa/sabPaisaInit?v=1";
  }
  if (env === "prod" || env === "production" || env === "live") {
    return "https://securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=1";
  }
  return "https://stage-securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=1";
}

const razorpayClient = razorpayEnabled
  ? new Razorpay({
      key_id: razorpayKeyId,
      key_secret: razorpayKeySecret
    })
  : null;

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const matchCatalogue = getAllMatches();
const soldStateBySection = new Map();
const pendingOrders = new Map();
let externalFeedCache = {
  fetchedAt: 0,
  ok: false
};
let matchStatusCache = {
  fetchedAt: 0,
  ok: false,
  source: "fallback",
  bySlug: {}
};

function sectionKey(matchSlug, sectionId) {
  return `${matchSlug}::${sectionId}`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundToNearest50(value) {
  return Math.round(value / 50) * 50;
}

function initializeSoldState() {
  for (const match of matchCatalogue) {
    for (const section of match.sections) {
      const noise = randomInt(-24, 18);
      const seededSold = clamp(section.baseSold + noise, 0, section.capacity);
      soldStateBySection.set(sectionKey(match.slug, section.id), seededSold);
    }
  }
}

function applyMockMarketDrift() {
  for (const match of matchCatalogue) {
    for (const section of match.sections) {
      const key = sectionKey(match.slug, section.id);
      const currentSold = soldStateBySection.get(key) ?? section.baseSold;
      const saleDelta = randomInt(0, 9);
      const occasionalReturn = Math.random() < 0.12 ? randomInt(0, 5) : 0;
      const nextSold = clamp(
        currentSold + saleDelta - occasionalReturn,
        0,
        section.capacity
      );
      soldStateBySection.set(key, nextSold);
    }
  }
}

function getSectionWithLiveState(match, section) {
  const key = sectionKey(match.slug, section.id);
  const sold = soldStateBySection.get(key) ?? section.baseSold;
  const available = Math.max(0, section.capacity - sold);
  const occupancy = sold / section.capacity;

  let multiplier = 1;
  if (occupancy >= 0.92) {
    multiplier = 1.3;
  } else if (occupancy >= 0.82) {
    multiplier = 1.2;
  } else if (occupancy >= 0.68) {
    multiplier = 1.12;
  }

  const dynamicPrice = roundToNearest50(section.price * multiplier);
  let status = "Available";
  if (available === 0) {
    status = "Sold Out";
  } else if (available <= Math.max(40, Math.floor(section.capacity * 0.08))) {
    status = "Almost Gone";
  }

  return {
    ...section,
    sold,
    available,
    occupancy,
    dynamicPrice,
    status
  };
}

function summarizeLiveSections(liveSections) {
  const seatsLeft = liveSections.reduce((sum, section) => sum + section.available, 0);
  const activePrices = liveSections
    .filter((section) => section.available > 0)
    .map((section) => section.dynamicPrice);
  const startingPrice = activePrices.length > 0 ? Math.min(...activePrices) : null;

  return {
    seatsLeft,
    startingPrice
  };
}

function toMatchCard(match, matchStatus) {
  const liveSections = match.sections.map((section) => getSectionWithLiveState(match, section));
  const summary = summarizeLiveSections(liveSections);

  return {
    slug: match.slug,
    league: match.league,
    heroLabel: match.heroLabel,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    dateTime: match.dateTime,
    stadium: match.stadium,
    city: match.city,
    summary: match.summary,
    tags: match.tags,
    seatsLeft: summary.seatsLeft,
    startingPrice: summary.startingPrice,
    status: summary.seatsLeft === 0 ? "Sold Out" : summary.seatsLeft < 200 ? "Limited" : "Live",
    matchPhase: matchStatus.phase,
    matchStatusText: matchStatus.statusText,
    scoreLine: matchStatus.scoreLine,
    matchStatusSource: matchStatus.source
  };
}

function toMatchDetail(match, matchStatus) {
  const sections = match.sections.map((section) => getSectionWithLiveState(match, section));
  const summary = summarizeLiveSections(sections);

  return {
    ...match,
    seatsLeft: summary.seatsLeft,
    startingPrice: summary.startingPrice,
    sections,
    matchPhase: matchStatus.phase,
    matchStatusText: matchStatus.statusText,
    scoreLine: matchStatus.scoreLine,
    matchStatusSource: matchStatus.source,
    refreshedAt: new Date().toISOString()
  };
}

function cleanupPendingOrders() {
  const now = Date.now();
  for (const [orderReference, order] of pendingOrders.entries()) {
    if (now - order.createdAt > 15 * 60 * 1000) {
      pendingOrders.delete(orderReference);
    }
  }
}

function calculatePricing(unitPrice, quantity) {
  const subtotal = unitPrice * quantity;
  const platformFee = Math.round(subtotal * 0.04);
  const gst = Math.round((subtotal + platformFee) * 0.18);
  const total = subtotal + platformFee + gst;

  return {
    currency: "INR",
    unitPrice,
    quantity,
    subtotal,
    platformFee,
    gst,
    total
  };
}

function sanitizeBuyer(buyer) {
  return {
    name: String(buyer?.name || "").trim(),
    email: String(buyer?.email || "").trim(),
    phone: String(buyer?.phone || "").trim()
  };
}

function validateCheckoutPayload(payload) {
  const errors = [];
  const matchSlug = String(payload?.matchSlug || "").trim();
  const sectionId = String(payload?.sectionId || "").trim();
  const quantity = Number(payload?.quantity || 0);
  const buyer = sanitizeBuyer(payload?.buyer || {});

  if (!matchSlug) errors.push("Missing match slug.");
  if (!sectionId) errors.push("Missing section id.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) {
    errors.push("Quantity must be an integer between 1 and 8.");
  }
  if (!buyer.name || buyer.name.length < 2) errors.push("Buyer name is too short.");
  if (!/^\S+@\S+\.\S+$/.test(buyer.email)) errors.push("Buyer email is invalid.");
  if (!/^[0-9]{10,15}$/.test(buyer.phone)) {
    errors.push("Buyer phone must contain 10-15 digits.");
  }

  return {
    valid: errors.length === 0,
    errors,
    matchSlug,
    sectionId,
    quantity,
    buyer
  };
}

async function fetchAndApplyExternalFeed() {
  if (feedProvider !== "external" || !externalFeedUrl) {
    return;
  }

  const now = Date.now();
  if (now - externalFeedCache.fetchedAt < 10_000 && externalFeedCache.ok) {
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_500);

  try {
    const headers = {
      Accept: "application/json"
    };
    if (externalFeedToken) {
      headers.Authorization = `Bearer ${externalFeedToken}`;
    }

    const response = await fetch(externalFeedUrl, {
      method: "GET",
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`External feed failed with status ${response.status}`);
    }

    const payload = await response.json();
    const matches = Array.isArray(payload?.matches) ? payload.matches : [];

    for (const feedMatch of matches) {
      const feedSlug = String(feedMatch?.slug || "");
      const sourceMatch = getMatchBySlug(feedSlug);
      if (!sourceMatch || !Array.isArray(feedMatch?.sections)) continue;

      for (const feedSection of feedMatch.sections) {
        const sectionId = String(feedSection?.id || "");
        const sourceSection = sourceMatch.sections.find((section) => section.id === sectionId);
        if (!sourceSection) continue;

        if (Number.isFinite(feedSection?.sold)) {
          const sold = clamp(
            Number(feedSection.sold),
            0,
            sourceSection.capacity
          );
          soldStateBySection.set(sectionKey(feedSlug, sectionId), sold);
        }

        if (Number.isFinite(feedSection?.price) && Number(feedSection.price) > 0) {
          sourceSection.price = roundToNearest50(Number(feedSection.price));
        }
      }
    }

    externalFeedCache = {
      fetchedAt: now,
      ok: true
    };
  } catch (error) {
    externalFeedCache = {
      fetchedAt: now,
      ok: false
    };
    console.error("[feed] External inventory sync skipped:", error.message);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/bangalore/g, "bengaluru")
    .replace(/[^a-z0-9]/g, "");
}

function inferFallbackMatchPhase(dateTime) {
  const now = Date.now();
  const startMs = new Date(dateTime).getTime();
  const runningWindowMs = 5 * 60 * 60 * 1000;

  if (Number.isNaN(startMs)) {
    return {
      phase: "Upcoming",
      statusText: "Scheduled",
      scoreLine: null,
      source: "fallback"
    };
  }

  if (now < startMs) {
    return {
      phase: "Upcoming",
      statusText: "Scheduled",
      scoreLine: null,
      source: "fallback"
    };
  }

  if (now >= startMs && now < startMs + runningWindowMs) {
    return {
      phase: "Running",
      statusText: "In Progress",
      scoreLine: null,
      source: "fallback"
    };
  }

  return {
    phase: "Completed",
    statusText: "Match Finished",
    scoreLine: null,
    source: "fallback"
  };
}

function classifyStatusText(statusText) {
  const text = String(statusText || "").toLowerCase();

  if (!text || text.includes("not started") || text.includes("scheduled")) {
    return "Upcoming";
  }

  if (
    text.includes("finished") ||
    text.includes("result") ||
    text.includes("abandoned") ||
    text.includes("cancelled") ||
    text.includes("postponed")
  ) {
    return "Completed";
  }

  return "Running";
}

function eventScoreLine(event) {
  const homeScore = event?.intHomeScore;
  const awayScore = event?.intAwayScore;
  if (homeScore !== null && homeScore !== undefined && awayScore !== null && awayScore !== undefined) {
    return `${event.strHomeTeam} ${homeScore} - ${awayScore} ${event.strAwayTeam}`;
  }
  if (event?.strResult) {
    return event.strResult;
  }
  return null;
}

function getEventMatchScore(event, match) {
  const localHome = normalizeTeamName(match.homeTeam);
  const localAway = normalizeTeamName(match.awayTeam);
  const remoteHome = normalizeTeamName(event?.strHomeTeam);
  const remoteAway = normalizeTeamName(event?.strAwayTeam);

  let score = 0;
  if (localHome === remoteHome && localAway === remoteAway) {
    score += 100;
  } else if (localHome === remoteAway && localAway === remoteHome) {
    score += 85;
  } else {
    return -1;
  }

  const localDate = String(match.dateTime || "").slice(0, 10);
  const remoteDate = String(event?.dateEvent || "").slice(0, 10);
  if (localDate && remoteDate && localDate === remoteDate) {
    score += 20;
  }

  const localStartMs = new Date(match.dateTime).getTime();
  const remoteStartMs = new Date(
    `${event?.dateEvent || ""}T${event?.strTime || "00:00:00"}`
  ).getTime();
  if (!Number.isNaN(localStartMs) && !Number.isNaN(remoteStartMs)) {
    const diffDays = Math.abs(localStartMs - remoteStartMs) / (1000 * 60 * 60 * 24);
    if (diffDays > 7) {
      return -1;
    }
    if (diffDays <= 1) {
      score += 25;
    } else if (diffDays <= 3) {
      score += 10;
    }
  }

  return score;
}

function mapEventToStatus(event) {
  const statusText = String(event?.strStatus || "In Progress");
  return {
    phase: classifyStatusText(statusText),
    statusText,
    scoreLine: eventScoreLine(event),
    source: "TheSportsDB",
    eventId: event?.idEvent || null
  };
}

async function fetchSportsDbSeasonEvents(season) {
  const url = `https://www.thesportsdb.com/api/v1/json/${sportsDbApiKey}/eventsseason.php?id=${sportsDbLeagueId}&s=${season}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`SportsDB season feed failed (${response.status})`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.events) ? payload.events : [];
}

async function refreshMatchStatusCache() {
  const now = Date.now();
  if (now - matchStatusCache.fetchedAt < matchStatusRefreshMs && matchStatusCache.ok) {
    return;
  }

  const bySlug = {};

  if (matchStatusProvider !== "thesportsdb") {
    for (const match of matchCatalogue) {
      bySlug[match.slug] = inferFallbackMatchPhase(match.dateTime);
    }
    matchStatusCache = {
      fetchedAt: now,
      ok: true,
      source: "fallback",
      bySlug
    };
    return;
  }

  try {
    const year = new Date().getFullYear();
    const seasons = [year - 1, year, year + 1];
    const allEvents = [];

    for (const season of seasons) {
      try {
        const seasonEvents = await fetchSportsDbSeasonEvents(season);
        allEvents.push(...seasonEvents);
      } catch (error) {
        // Allow partial season fetches while still serving cached/fallback data.
      }
    }

    for (const match of matchCatalogue) {
      let bestEvent = null;
      let bestScore = -1;

      for (const event of allEvents) {
        const score = getEventMatchScore(event, match);
        if (score > bestScore) {
          bestScore = score;
          bestEvent = event;
        }
      }

      if (bestEvent && bestScore >= 100) {
        bySlug[match.slug] = mapEventToStatus(bestEvent);
      } else {
        bySlug[match.slug] = inferFallbackMatchPhase(match.dateTime);
      }
    }

    matchStatusCache = {
      fetchedAt: now,
      ok: true,
      source: "TheSportsDB",
      bySlug
    };
  } catch (error) {
    const fallbackBySlug = {};
    for (const match of matchCatalogue) {
      fallbackBySlug[match.slug] = inferFallbackMatchPhase(match.dateTime);
    }

    matchStatusCache = {
      fetchedAt: now,
      ok: false,
      source: "fallback",
      bySlug: fallbackBySlug
    };
    console.error("[status] Match status sync skipped:", error.message);
  }
}

function getMatchStatusInfo(match) {
  return (
    matchStatusCache.bySlug?.[match.slug] ||
    inferFallbackMatchPhase(match.dateTime)
  );
}

function getSectionCapacity(matchSlug, sectionId) {
  const match = getMatchBySlug(matchSlug);
  if (!match) return null;
  return match.sections.find((section) => section.id === sectionId) || null;
}

function normalizeBaseUrl(input) {
  return String(input || "")
    .trim()
    .replace(/\/+$/, "");
}

function getCheckoutMode() {
  if (checkoutProvider === "demo") {
    return "demo";
  }

  if (checkoutProvider === "sabpaisa") {
    return sabpaisaEnabled ? "sabpaisa" : "demo";
  }

  if (checkoutProvider === "razorpay") {
    return razorpayEnabled ? "razorpay" : "demo";
  }

  if (checkoutProvider === "ccavenue") {
    return ccavenueEnabled ? "ccavenue" : "demo";
  }

  if (sabpaisaEnabled) {
    return "sabpaisa";
  }

  if (ccavenueEnabled) {
    return "ccavenue";
  }

  if (razorpayEnabled) {
    return "razorpay";
  }

  return "demo";
}

function getPublicBaseUrl(req, explicitBaseUrl = "") {
  if (explicitBaseUrl) {
    return normalizeBaseUrl(explicitBaseUrl);
  }

  if (ccavenueRedirectBaseUrl) {
    return normalizeBaseUrl(ccavenueRedirectBaseUrl);
  }

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || `localhost:${port}`;
  return `${protocol}://${host}`;
}

function ccavenueKeyBuffer(workingKey) {
  return crypto.createHash("md5").update(String(workingKey)).digest();
}

function encryptCcavenue(payload, workingKey) {
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    ccavenueKeyBuffer(workingKey),
    ccavenueIvBuffer
  );
  let encrypted = cipher.update(String(payload), "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

function decryptCcavenue(payload, workingKey) {
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    ccavenueKeyBuffer(workingKey),
    ccavenueIvBuffer
  );
  let decrypted = decipher.update(String(payload), "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function finalizeOrder(orderReference) {
  const pendingOrder = pendingOrders.get(orderReference);
  if (!pendingOrder) {
    return {
      ok: false,
      code: 404,
      error: "Order session expired. Please retry checkout."
    };
  }

  const sourceSection = getSectionCapacity(
    pendingOrder.matchSlug,
    pendingOrder.sectionId
  );
  if (!sourceSection) {
    pendingOrders.delete(orderReference);
    return {
      ok: false,
      code: 404,
      error: "Section no longer available."
    };
  }

  const sectionStateKey = sectionKey(pendingOrder.matchSlug, pendingOrder.sectionId);
  const currentSold = soldStateBySection.get(sectionStateKey) ?? sourceSection.baseSold;
  const remaining = sourceSection.capacity - currentSold;

  if (remaining < pendingOrder.quantity) {
    pendingOrders.delete(orderReference);
    return {
      ok: false,
      code: 409,
      error: `Only ${remaining} ticket(s) are now available. Please retry.`
    };
  }

  soldStateBySection.set(
    sectionStateKey,
    clamp(currentSold + pendingOrder.quantity, 0, sourceSection.capacity)
  );
  pendingOrders.delete(orderReference);

  const bookingId = `IPL${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const match = getMatchBySlug(pendingOrder.matchSlug);
  const purchasedAt = new Date().toISOString();

  return {
    ok: true,
    booking: {
      bookingId,
      orderReference,
      match: `${match.homeTeam} vs ${match.awayTeam}`,
      stadium: match.stadium,
      city: match.city,
      section: sourceSection.label,
      quantity: pendingOrder.quantity,
      amountPaid: pendingOrder.pricing.total,
      purchasedAt
    },
    match,
    section: sourceSection,
    pendingOrder
  };
}

app.get("/api/config", (req, res) => {
  const checkoutMode = getCheckoutMode();
  res.json({
    checkoutMode,
    checkoutProvider,
    razorpayKeyId,
    ccavenueEnv,
    sabpaisaEnv,
    liveRefreshIntervalMs,
    matchStatusRefreshMs,
    matchStatusProvider,
    feedProvider,
    currency: "INR"
  });
});

app.get("/api/matches", async (req, res) => {
  await fetchAndApplyExternalFeed();
  await refreshMatchStatusCache();
  const cards = matchCatalogue.map((match) =>
    toMatchCard(match, getMatchStatusInfo(match))
  );
  res.json({
    refreshedAt: new Date().toISOString(),
    matchStatusSource: matchStatusCache.source,
    matches: cards
  });
});

app.get("/api/matches/status", async (req, res) => {
  await refreshMatchStatusCache();
  const grouped = {
    upcoming: [],
    running: [],
    completed: []
  };

  for (const match of matchCatalogue) {
    const info = getMatchStatusInfo(match);
    const item = {
      slug: match.slug,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      dateTime: match.dateTime,
      phase: info.phase,
      statusText: info.statusText,
      scoreLine: info.scoreLine,
      source: info.source
    };

    if (info.phase === "Running") {
      grouped.running.push(item);
    } else if (info.phase === "Completed") {
      grouped.completed.push(item);
    } else {
      grouped.upcoming.push(item);
    }
  }

  res.json({
    refreshedAt: new Date().toISOString(),
    source: matchStatusCache.source,
    ...grouped
  });
});

app.get("/api/matches/:slug", async (req, res) => {
  await fetchAndApplyExternalFeed();
  await refreshMatchStatusCache();
  const slug = String(req.params.slug || "");
  const match = getMatchBySlug(slug);

  if (!match) {
    res.status(404).json({ error: "Match not found." });
    return;
  }

  res.json({
    match: toMatchDetail(match, getMatchStatusInfo(match))
  });
});

app.get("/api/live", async (req, res) => {
  await fetchAndApplyExternalFeed();
  await refreshMatchStatusCache();
  const slug = String(req.query.slug || "").trim();

  if (slug) {
    const match = getMatchBySlug(slug);
    if (!match) {
      res.status(404).json({ error: "Match not found." });
      return;
    }
    res.json({
      refreshedAt: new Date().toISOString(),
      match: toMatchDetail(match, getMatchStatusInfo(match))
    });
    return;
  }

  res.json({
    refreshedAt: new Date().toISOString(),
    matchStatusSource: matchStatusCache.source,
    matches: matchCatalogue.map((match) =>
      toMatchCard(match, getMatchStatusInfo(match))
    )
  });
});

app.post("/api/checkout/create-order", async (req, res) => {
  await fetchAndApplyExternalFeed();
  const parsed = validateCheckoutPayload(req.body);
  if (!parsed.valid) {
    res.status(400).json({ error: parsed.errors.join(" ") });
    return;
  }

  const match = getMatchBySlug(parsed.matchSlug);
  if (!match) {
    res.status(404).json({ error: "Match not found." });
    return;
  }

  const section = match.sections.find((item) => item.id === parsed.sectionId);
  if (!section) {
    res.status(404).json({ error: "Section not found." });
    return;
  }

  const liveSection = getSectionWithLiveState(match, section);
  if (liveSection.available < parsed.quantity) {
    res.status(409).json({
      error: `Only ${liveSection.available} ticket(s) left in ${liveSection.label}.`
    });
    return;
  }

  const pricing = calculatePricing(liveSection.dynamicPrice, parsed.quantity);
  const orderReference = `BP${Date.now().toString(36).toUpperCase()}${crypto
    .randomBytes(2)
    .toString("hex")
    .toUpperCase()}`;
  const checkoutMode = getCheckoutMode();

  const orderRecord = {
    orderReference,
    matchSlug: match.slug,
    sectionId: section.id,
    quantity: parsed.quantity,
    pricing,
    buyer: parsed.buyer,
    createdAt: Date.now(),
    mode: checkoutMode,
    razorpayOrderId: null,
    paymentTrackingId: null
  };

  const responsePayload = {
    orderReference,
    pricing,
    match: {
      slug: match.slug,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      dateTime: match.dateTime,
      stadium: match.stadium,
      city: match.city
    },
    section: {
      id: liveSection.id,
      label: liveSection.label,
      stand: liveSection.stand,
      selectedUnitPrice: liveSection.dynamicPrice
    }
  };

  if (checkoutMode === "sabpaisa") {
    try {
      const baseUrl = getPublicBaseUrl(req, sabpaisaCallbackBaseUrl);
      const callbackUrl = `${baseUrl}/api/checkout/sabpaisa/response`;
      const sabpaisaPayload = new URLSearchParams({
        payerName: parsed.buyer.name,
        payerEmail: parsed.buyer.email,
        payerMobile: parsed.buyer.phone,
        clientTxnId: orderReference,
        amount: pricing.total.toFixed(2),
        amountType: pricing.currency,
        clientCode: sabpaisaClientCode,
        transUserName: sabpaisaTransUserName,
        transUserPassword: sabpaisaTransUserPassword,
        callbackUrl,
        channelId: sabpaisaChannelId,
        udf1: match.slug,
        udf2: section.id,
        udf3: String(parsed.quantity),
        udf4: String(liveSection.dynamicPrice)
      }).toString();

      const encData = sabpaisaEncrypt(
        sabpaisaPayload,
        sabpaisaAuthKey,
        sabpaisaAuthIV
      );
      pendingOrders.set(orderReference, orderRecord);

      res.json({
        ...responsePayload,
        mode: "sabpaisa",
        sabpaisa: {
          gatewayUrl: getSabpaisaGatewayUrl(sabpaisaEnv),
          clientCode: sabpaisaClientCode,
          encData
        }
      });
      return;
    } catch (error) {
      console.error("[checkout] SabPaisa init error:", error.message);
      res.status(500).json({
        error: "Unable to initiate SabPaisa right now. Please retry."
      });
      return;
    }
  }

  if (checkoutMode === "ccavenue") {
    try {
      const baseUrl = getPublicBaseUrl(req);
      const redirectUrl = `${baseUrl}/api/checkout/ccavenue/response`;
      const cancelUrl = `${baseUrl}/api/checkout/ccavenue/response`;
      const merchantPayload = new URLSearchParams({
        merchant_id: ccavenueMerchantId,
        order_id: orderReference,
        currency: pricing.currency,
        amount: pricing.total.toFixed(2),
        redirect_url: redirectUrl,
        cancel_url: cancelUrl,
        language: "EN",
        billing_name: parsed.buyer.name,
        billing_email: parsed.buyer.email,
        billing_tel: parsed.buyer.phone,
        billing_country: "India",
        merchant_param1: match.slug,
        merchant_param2: section.id
      }).toString();
      const encRequest = encryptCcavenue(merchantPayload, ccavenueWorkingKey);

      pendingOrders.set(orderReference, orderRecord);
      res.json({
        ...responsePayload,
        mode: "ccavenue",
        ccavenue: {
          gatewayUrl: ccavenueGatewayUrl,
          accessCode: ccavenueAccessCode,
          encRequest
        }
      });
      return;
    } catch (error) {
      console.error("[checkout] CCAvenue init error:", error.message);
      res.status(500).json({
        error: "Unable to initiate CCAvenue right now. Please retry."
      });
      return;
    }
  }

  if (checkoutMode === "razorpay") {
    try {
      const order = await razorpayClient.orders.create({
        amount: pricing.total * 100,
        currency: pricing.currency,
        receipt: orderReference,
        notes: {
          orderReference,
          match: `${match.homeTeam} vs ${match.awayTeam}`,
          section: section.label,
          quantity: String(parsed.quantity)
        }
      });

      orderRecord.razorpayOrderId = order.id;
      pendingOrders.set(orderReference, orderRecord);

      res.json({
        ...responsePayload,
        mode: "razorpay",
        razorpay: {
          keyId: razorpayKeyId,
          orderId: order.id,
          amount: order.amount,
          currency: order.currency
        }
      });
      return;
    } catch (error) {
      console.error("[checkout] Razorpay order error:", error.message);
      res.status(500).json({
        error: "Unable to create payment order right now. Please retry."
      });
      return;
    }
  }

  pendingOrders.set(orderReference, orderRecord);
  res.json({
    ...responsePayload,
    mode: "demo",
    demo: {
      message: "Payment keys missing. Running demo verification flow."
    }
  });
});

app.all("/api/checkout/sabpaisa/response", (req, res) => {
  const redirectToHomeWithError = (reason) => {
    const params = new URLSearchParams({
      payment: "failed",
      reason: String(reason || "Payment failed.")
    });
    res.redirect(`/?${params.toString()}`);
  };

  if (!sabpaisaEnabled) {
    redirectToHomeWithError("SabPaisa is not configured on this server.");
    return;
  }

  const encResponseRaw =
    req.query?.encResponse ||
    req.query?.responseQuery ||
    req.body?.encResponse ||
    req.body?.responseQuery ||
    req.body?.encData ||
    "";
  const encResponse = String(encResponseRaw || "")
    .trim()
    .replace(/ /g, "+");

  if (!encResponse) {
    redirectToHomeWithError("Missing SabPaisa response payload.");
    return;
  }

  let responseMap;
  try {
    const decrypted = sabpaisaDecrypt(encResponse, sabpaisaAuthKey, sabpaisaAuthIV);
    responseMap = Object.fromEntries(new URLSearchParams(String(decrypted || "")).entries());
  } catch (error) {
    console.error("[checkout] SabPaisa decrypt error:", error.message);
    redirectToHomeWithError("Unable to verify payment response.");
    return;
  }

  if (!responseMap || Object.keys(responseMap).length === 0) {
    redirectToHomeWithError("Invalid SabPaisa response payload.");
    return;
  }

  const orderReference = String(
    responseMap.clientTxnId || responseMap.order_id || responseMap.orderReference || ""
  ).trim();
  if (!orderReference) {
    redirectToHomeWithError("Missing order id in payment response.");
    return;
  }

  const pendingOrder = pendingOrders.get(orderReference);
  if (!pendingOrder || pendingOrder.mode !== "sabpaisa") {
    redirectToHomeWithError("Order session expired. Please retry checkout.");
    return;
  }

  const status = String(
    responseMap.status || responseMap.Status || responseMap.order_status || ""
  )
    .trim()
    .toLowerCase();
  const respCode = String(
    responseMap.sabPaisaRespCode || responseMap.respCode || ""
  ).trim();
  const success =
    status === "success" || status === "successful" || (respCode === "0000" && status !== "failure");

  if (!success) {
    pendingOrders.delete(orderReference);
    redirectToHomeWithError(`Payment ${status || "failed"}.`);
    return;
  }

  const paidAmount = Number(responseMap.paidAmount || responseMap.amount || 0);
  if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - pendingOrder.pricing.total) > 0.01) {
    pendingOrders.delete(orderReference);
    redirectToHomeWithError("Amount mismatch in gateway response.");
    return;
  }

  const trackingId = String(responseMap.txnId || responseMap.transactionId || "").trim();
  if (trackingId) {
    pendingOrder.paymentTrackingId = trackingId;
  }

  const finalized = finalizeOrder(orderReference);
  if (!finalized.ok) {
    redirectToHomeWithError(finalized.error);
    return;
  }

  const matchStart = new Date(finalized.match.dateTime);
  const dateLabel = Number.isNaN(matchStart.getTime())
    ? "Match Day"
    : new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      }).format(matchStart);
  const timeLabel = Number.isNaN(matchStart.getTime())
    ? "TBA"
    : new Intl.DateTimeFormat("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }).format(matchStart);

  const params = new URLSearchParams({
    id: finalized.booking.bookingId,
    match: finalized.booking.match,
    date: dateLabel,
    time: timeLabel,
    city: finalized.booking.city,
    stadium: finalized.booking.stadium,
    seats: `${finalized.booking.quantity} x ${finalized.booking.section}`,
    name: finalized.pendingOrder.buyer.name,
    email: finalized.pendingOrder.buyer.email,
    total: String(finalized.booking.amountPaid)
  });

  res.redirect(`/thankyou.html?${params.toString()}`);
});

app.post("/api/checkout/ccavenue/response", (req, res) => {
  const redirectToHomeWithError = (reason) => {
    const params = new URLSearchParams({
      payment: "failed",
      reason: String(reason || "Payment failed.")
    });
    res.redirect(`/?${params.toString()}`);
  };

  if (!ccavenueEnabled) {
    redirectToHomeWithError("CCAvenue is not configured on this server.");
    return;
  }

  const encResp = String(req.body?.encResp || "").trim();
  if (!encResp) {
    redirectToHomeWithError("Missing CCAvenue response payload.");
    return;
  }

  let responseMap;
  try {
    const decrypted = decryptCcavenue(encResp, ccavenueWorkingKey);
    responseMap = Object.fromEntries(new URLSearchParams(decrypted).entries());
  } catch (error) {
    console.error("[checkout] CCAvenue decrypt error:", error.message);
    redirectToHomeWithError("Unable to verify payment response.");
    return;
  }

  const orderReference = String(responseMap.order_id || "").trim();
  if (!orderReference) {
    redirectToHomeWithError("Missing order id in payment response.");
    return;
  }

  const pendingOrder = pendingOrders.get(orderReference);
  if (!pendingOrder || pendingOrder.mode !== "ccavenue") {
    redirectToHomeWithError("Order session expired. Please retry checkout.");
    return;
  }

  const responseMerchantId = String(responseMap.merchant_id || "").trim();
  if (responseMerchantId && responseMerchantId !== ccavenueMerchantId) {
    pendingOrders.delete(orderReference);
    redirectToHomeWithError("Merchant validation failed.");
    return;
  }

  const paidAmount = Number(responseMap.amount || 0);
  if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - pendingOrder.pricing.total) > 0.01) {
    pendingOrders.delete(orderReference);
    redirectToHomeWithError("Amount mismatch in gateway response.");
    return;
  }

  const gatewayStatus = String(responseMap.order_status || "").trim();
  const trackingId = String(responseMap.tracking_id || "").trim();
  if (trackingId) {
    pendingOrder.paymentTrackingId = trackingId;
  }

  if (gatewayStatus.toLowerCase() !== "success") {
    pendingOrders.delete(orderReference);
    redirectToHomeWithError(`Payment ${gatewayStatus || "failed"}.`);
    return;
  }

  const finalized = finalizeOrder(orderReference);
  if (!finalized.ok) {
    redirectToHomeWithError(finalized.error);
    return;
  }

  const matchStart = new Date(finalized.match.dateTime);
  const dateLabel = Number.isNaN(matchStart.getTime())
    ? "Match Day"
    : new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      }).format(matchStart);
  const timeLabel = Number.isNaN(matchStart.getTime())
    ? "TBA"
    : new Intl.DateTimeFormat("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }).format(matchStart);

  const params = new URLSearchParams({
    id: finalized.booking.bookingId,
    match: finalized.booking.match,
    date: dateLabel,
    time: timeLabel,
    city: finalized.booking.city,
    stadium: finalized.booking.stadium,
    seats: `${finalized.booking.quantity} x ${finalized.booking.section}`,
    name: finalized.pendingOrder.buyer.name,
    email: finalized.pendingOrder.buyer.email,
    total: String(finalized.booking.amountPaid)
  });

  res.redirect(`/thankyou.html?${params.toString()}`);
});

app.post("/api/checkout/verify", (req, res) => {
  const orderReference = String(req.body?.orderReference || "").trim();
  if (!orderReference) {
    res.status(400).json({ error: "Missing order reference." });
    return;
  }

  const pendingOrder = pendingOrders.get(orderReference);
  if (!pendingOrder) {
    res.status(404).json({ error: "Order session expired. Please retry checkout." });
    return;
  }

  if (pendingOrder.mode === "ccavenue" || pendingOrder.mode === "sabpaisa") {
    res.status(409).json({
      error: `${pendingOrder.mode} orders are verified by gateway callback only.`
    });
    return;
  }

  if (pendingOrder.mode === "razorpay") {
    const razorpayOrderId = String(req.body?.razorpay_order_id || "");
    const razorpayPaymentId = String(req.body?.razorpay_payment_id || "");
    const razorpaySignature = String(req.body?.razorpay_signature || "");

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      res.status(400).json({ error: "Incomplete Razorpay verification payload." });
      return;
    }

    if (pendingOrder.razorpayOrderId !== razorpayOrderId) {
      res.status(409).json({ error: "Payment order mismatch." });
      return;
    }

    const expectedSignature = crypto
      .createHmac("sha256", razorpayKeySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      res.status(400).json({ error: "Signature verification failed." });
      return;
    }
  } else {
    const demoTransactionId = String(req.body?.demoTransactionId || "").trim();
    if (!demoTransactionId) {
      res.status(400).json({ error: "Missing demo transaction id." });
      return;
    }
  }

  const finalized = finalizeOrder(orderReference);
  if (!finalized.ok) {
    res.status(finalized.code).json({ error: finalized.error });
    return;
  }

  res.json({
    success: true,
    booking: finalized.booking
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    checkoutMode: getCheckoutMode(),
    checkoutProvider,
    feedProvider,
    matchStatusProvider
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/thankyou.html", (req, res) => {
  res.sendFile(path.join(__dirname, "thankyou.html"));
});

app.get("/see-tickets.html", (req, res) => {
  res.sendFile(path.join(__dirname, "see-tickets.html"));
});

initializeSoldState();
setInterval(cleanupPendingOrders, 60_000).unref();
setInterval(() => {
  if (feedProvider !== "external") {
    applyMockMarketDrift();
  }
}, liveRefreshIntervalMs).unref();

app.listen(port, () => {
  const checkoutMode = getCheckoutMode();
  console.log(
    `[server] running on http://localhost:${port} | checkout=${checkoutMode} | provider=${checkoutProvider} | feed=${feedProvider} | matchStatus=${matchStatusProvider}`
  );
});

