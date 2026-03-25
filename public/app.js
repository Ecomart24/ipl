const state = {
  config: null,
  matches: [],
  selectedMatch: null,
  selectedSectionId: null,
  quantity: 1,
  pollTimer: null
};

const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});

const el = {
  liveLabel: document.querySelector("#liveLabel"),
  searchInput: document.querySelector("#searchInput"),
  cityFilter: document.querySelector("#cityFilter"),
  dateFilter: document.querySelector("#dateFilter"),
  matchList: document.querySelector("#matchList"),
  matchCount: document.querySelector("#matchCount"),
  matchDetail: document.querySelector("#matchDetail"),
  cartSummary: document.querySelector("#cartSummary"),
  checkoutBtn: document.querySelector("#checkoutBtn"),
  modal: document.querySelector("#checkoutModal"),
  closeModalBtn: document.querySelector("#closeModalBtn"),
  buyerForm: document.querySelector("#buyerForm"),
  buyerName: document.querySelector("#buyerName"),
  buyerEmail: document.querySelector("#buyerEmail"),
  buyerPhone: document.querySelector("#buyerPhone"),
  payNowBtn: document.querySelector("#payNowBtn"),
  toast: document.querySelector("#toast")
};

function toHumanDate(dateTime) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(dateTime));
}

function inventoryStatusClass(status) {
  if (status === "Sold Out") return "sold";
  if (status === "Limited" || status === "Almost Gone") return "limited";
  return "live";
}

function phaseClass(phase) {
  if (phase === "Running") return "running";
  if (phase === "Completed") return "completed";
  return "upcoming";
}

function showToast(message, kind = "success", timeoutMs = 2800) {
  el.toast.textContent = message;
  el.toast.className = `toast ${kind}`;
  el.toast.classList.remove("hidden");
  window.setTimeout(() => el.toast.classList.add("hidden"), timeoutMs);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.error || "Request failed.");
  }
  return payload;
}

function getFilteredMatches() {
  const query = el.searchInput.value.trim().toLowerCase();
  const city = el.cityFilter.value;
  const date = el.dateFilter.value;

  return state.matches.filter((match) => {
    const haystack = `${match.homeTeam} ${match.awayTeam} ${match.city} ${match.stadium}`.toLowerCase();
    const queryMatch = !query || haystack.includes(query);
    const cityMatch = city === "all" || match.city === city;
    const dateMatch = !date || match.dateTime.slice(0, 10) === date;
    return queryMatch && cityMatch && dateMatch;
  });
}

function renderMatches() {
  const matches = getFilteredMatches();
  el.matchCount.textContent = `${matches.length} match(es)`;

  if (!matches.length) {
    el.matchList.innerHTML = `<p class="detail-empty">No matches found for current filters.</p>`;
    return;
  }

  el.matchList.innerHTML = matches
    .map((match) => {
      const isActive = state.selectedMatch?.slug === match.slug;
      const startPrice = match.startingPrice ? rupee.format(match.startingPrice) : "N/A";
      return `
        <button class="match-card ${isActive ? "active" : ""}" data-slug="${match.slug}">
          <div class="card-row">
            <span class="status ${inventoryStatusClass(match.status)}">${match.status}</span>
            <span class="meta">${toHumanDate(match.dateTime)}</span>
          </div>
          <div class="card-row">
            <span class="phase-badge ${phaseClass(match.matchPhase)}">${match.matchPhase || "Upcoming"}</span>
            <span class="meta">${match.matchStatusText || "Scheduled"}</span>
          </div>
          <p class="match-teams">${match.homeTeam} vs ${match.awayTeam}</p>
          <div class="card-row">
            <span class="meta">${match.stadium}, ${match.city}</span>
            <span class="meta">From ${startPrice}</span>
          </div>
          <div class="card-row">
            <span class="meta">${match.seatsLeft} seats left</span>
            <span class="meta">${match.heroLabel}</span>
          </div>
          ${
            match.scoreLine
              ? `<div class="card-row"><span class="meta">Score: ${match.scoreLine}</span></div>`
              : ""
          }
          <div class="tags">${(match.tags || []).slice(0, 3).map((tag) => `<span class="tag">${tag}</span>`).join("")}</div>
        </button>
      `;
    })
    .join("");
}

function selectedSection() {
  if (!state.selectedMatch || !state.selectedSectionId) return null;
  return state.selectedMatch.sections.find((section) => section.id === state.selectedSectionId) || null;
}

function pricingForCurrentSelection() {
  const section = selectedSection();
  if (!section) return null;

  const subtotal = section.dynamicPrice * state.quantity;
  const platformFee = Math.round(subtotal * 0.04);
  const gst = Math.round((subtotal + platformFee) * 0.18);
  const total = subtotal + platformFee + gst;

  return {
    subtotal,
    platformFee,
    gst,
    total
  };
}

function renderCart() {
  const section = selectedSection();
  if (!state.selectedMatch || !section) {
    el.cartSummary.innerHTML = `<p class="cart-empty">Select a section to activate payment.</p>`;
    el.checkoutBtn.disabled = true;
    return;
  }

  const maxQty = Math.max(1, Math.min(8, section.available));
  if (state.quantity > maxQty) {
    state.quantity = maxQty;
  }

  const pricing = pricingForCurrentSelection();
  el.cartSummary.innerHTML = `
    <div class="checkout-block">
      <div>
        <strong>${state.selectedMatch.homeTeam} vs ${state.selectedMatch.awayTeam}</strong>
        <p class="section-caption">${toHumanDate(state.selectedMatch.dateTime)} | ${state.selectedMatch.stadium}</p>
      </div>

      <div>
        <strong>${section.label}</strong>
        <p class="section-caption">${section.stand} | ${section.available} seat(s) left</p>
      </div>

      <label class="quantity-wrap">
        <span>Quantity</span>
        <input id="qtyInput" type="number" min="1" max="${maxQty}" value="${state.quantity}" />
      </label>

      <div class="price-row"><span>Subtotal</span><span>${rupee.format(pricing.subtotal)}</span></div>
      <div class="price-row"><span>Platform fee</span><span>${rupee.format(pricing.platformFee)}</span></div>
      <div class="price-row"><span>GST</span><span>${rupee.format(pricing.gst)}</span></div>
      <div class="price-row total"><span>Total</span><span>${rupee.format(pricing.total)}</span></div>
    </div>
  `;

  el.checkoutBtn.disabled = section.available < 1;

  const qtyInput = document.querySelector("#qtyInput");
  if (qtyInput) {
    qtyInput.addEventListener("input", (event) => {
      const nextValue = Math.round(Number(event.target.value || 1));
      state.quantity = Math.max(1, Math.min(maxQty, nextValue));
      renderCart();
    });
  }
}

function renderMatchDetail() {
  if (!state.selectedMatch) {
    el.matchDetail.innerHTML = `<p class="detail-empty">Pick a match to view details.</p>`;
    renderCart();
    return;
  }

  const selectedId = state.selectedSectionId;
  const match = state.selectedMatch;

  const sectionsHtml = match.sections
    .map((section) => {
      const active = selectedId === section.id;
      return `
        <article class="section-card">
          <div class="section-head">
            <div>
              <p class="section-title">${section.label}</p>
              <p class="section-caption">${section.stand} | ${section.rows}</p>
            </div>
            <p class="section-price">${rupee.format(section.dynamicPrice)}</p>
          </div>
          <p class="section-caption">${section.viewLabel}</p>
          <div class="section-foot">
            <small>${section.available} left | ${section.status}</small>
            <button
              class="btn ${active ? "btn-primary" : "btn-secondary"}"
              data-section-id="${section.id}"
              ${section.available < 1 ? "disabled" : ""}
            >
              ${active ? "Selected" : section.available < 1 ? "Sold Out" : "Select"}
            </button>
          </div>
        </article>
      `;
    })
    .join("");

  const seatMapHtml = match.sections
    .map((section) => {
      const active = selectedId === section.id;
      return `
        <button
          class="seat-chip ${active ? "active" : ""}"
          style="--chip-accent: ${section.accent || "#16b9ff"}"
          data-section-id="${section.id}"
          ${section.available < 1 ? "disabled" : ""}
        >
          <p class="seat-title">${section.label}</p>
          <p class="seat-meta">${section.available} seats</p>
        </button>
      `;
    })
    .join("");

  el.matchDetail.innerHTML = `
    <div class="match-detail">
      <header class="detail-header">
        <h3>${match.homeTeam} vs ${match.awayTeam}</h3>
        <p>${toHumanDate(match.dateTime)} | ${match.stadium}, ${match.city}</p>
        <p class="section-caption">
          <span class="phase-badge ${phaseClass(match.matchPhase)}">${match.matchPhase || "Upcoming"}</span>
          ${match.matchStatusText || "Scheduled"}
        </p>
        ${match.scoreLine ? `<p class="section-caption">Score: ${match.scoreLine}</p>` : ""}
        <p>${match.summary}</p>
        <p class="meta">Live seats left: ${match.seatsLeft} | Refreshed ${new Date(match.refreshedAt).toLocaleTimeString()}</p>
      </header>
      <div class="seat-map">${seatMapHtml}</div>
      <div class="sections">${sectionsHtml}</div>
    </div>
  `;

  el.matchDetail.querySelectorAll("[data-section-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSectionId = button.getAttribute("data-section-id");
      state.quantity = 1;
      renderMatchDetail();
    });
  });

  renderCart();
}

function buildCityFilter() {
  const existing = new Set(Array.from(el.cityFilter.options).map((opt) => opt.value));
  const cities = [...new Set(state.matches.map((match) => match.city))].sort();
  for (const city of cities) {
    if (existing.has(city)) continue;
    const option = document.createElement("option");
    option.value = city;
    option.textContent = city;
    el.cityFilter.appendChild(option);
  }
}

async function loadMatches() {
  const payload = await api("/api/matches");
  state.matches = payload.matches || [];
  buildCityFilter();
  renderMatches();
}

async function loadMatchDetail(slug, options = {}) {
  const preserveSection = options.preserveSection || false;
  const payload = await api(`/api/matches/${slug}`);
  const nextMatch = payload.match;
  const previousSectionId = preserveSection ? state.selectedSectionId : null;
  state.selectedMatch = nextMatch;

  if (previousSectionId && nextMatch.sections.some((section) => section.id === previousSectionId)) {
    state.selectedSectionId = previousSectionId;
  } else {
    const bestSection = nextMatch.sections.find((section) => section.available > 0) || nextMatch.sections[0];
    state.selectedSectionId = bestSection?.id || null;
    state.quantity = 1;
  }

  renderMatchDetail();
  renderMatches();
}

function openModal() {
  el.modal.classList.remove("hidden");
}

function closeModal() {
  el.modal.classList.add("hidden");
}

function attachEvents() {
  el.searchInput.addEventListener("input", renderMatches);
  el.cityFilter.addEventListener("change", renderMatches);
  el.dateFilter.addEventListener("change", renderMatches);

  el.matchList.addEventListener("click", async (event) => {
    const card = event.target.closest("[data-slug]");
    if (!card) return;

    const slug = card.getAttribute("data-slug");
    try {
      await loadMatchDetail(slug);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  el.checkoutBtn.addEventListener("click", () => {
    if (!state.selectedMatch || !selectedSection()) {
      showToast("Select a section first.", "error");
      return;
    }
    openModal();
  });

  el.closeModalBtn.addEventListener("click", closeModal);
  el.modal.addEventListener("click", (event) => {
    if (event.target === el.modal) closeModal();
  });

  el.buyerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await runCheckout();
    } catch (error) {
      showToast(error.message, "error");
      el.payNowBtn.disabled = false;
      el.payNowBtn.textContent = "Create Payment";
    }
  });
}

async function verifyOrder(payload) {
  const verification = await api("/api/checkout/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  showToast(`Booking confirmed. Ref: ${verification.booking.bookingId}`, "success", 4200);
  closeModal();
  await loadMatches();
  if (state.selectedMatch?.slug) {
    await loadMatchDetail(state.selectedMatch.slug, { preserveSection: true });
  }
}

function postToGateway(url, fields) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.style.display = "none";

  for (const [name, value] of Object.entries(fields || {})) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = String(value ?? "");
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

async function runCheckout() {
  const section = selectedSection();
  if (!section || !state.selectedMatch) {
    throw new Error("Please select a section first.");
  }

  el.payNowBtn.disabled = true;
  el.payNowBtn.textContent = "Preparing payment...";

  const order = await api("/api/checkout/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      matchSlug: state.selectedMatch.slug,
      sectionId: section.id,
      quantity: state.quantity,
      buyer: {
        name: el.buyerName.value.trim(),
        email: el.buyerEmail.value.trim(),
        phone: el.buyerPhone.value.trim()
      }
    })
  });

  if (order.mode === "sabpaisa") {
    const gatewayUrl = order?.sabpaisa?.gatewayUrl;
    const clientCode = order?.sabpaisa?.clientCode;
    const encData = order?.sabpaisa?.encData;

    if (!gatewayUrl || !clientCode || !encData) {
      el.payNowBtn.disabled = false;
      el.payNowBtn.textContent = "Create Payment";
      throw new Error("SabPaisa initiation payload is incomplete.");
    }

    el.payNowBtn.textContent = "Redirecting to SabPaisa...";
    postToGateway(gatewayUrl, {
      encData,
      clientCode
    });
    return;
  }

  if (order.mode === "ccavenue") {
    const gatewayUrl = order?.ccavenue?.gatewayUrl;
    const accessCode = order?.ccavenue?.accessCode;
    const encRequest = order?.ccavenue?.encRequest;

    if (!gatewayUrl || !accessCode || !encRequest) {
      el.payNowBtn.disabled = false;
      el.payNowBtn.textContent = "Create Payment";
      throw new Error("CCAvenue initiation payload is incomplete.");
    }

    el.payNowBtn.textContent = "Redirecting to CCAvenue...";
    postToGateway(gatewayUrl, {
      encRequest,
      access_code: accessCode
    });
    return;
  }

  if (order.mode === "razorpay" && window.Razorpay) {
    el.payNowBtn.disabled = false;
    el.payNowBtn.textContent = "Create Payment";

    const rz = new window.Razorpay({
      key: order.razorpay.keyId || state.config.razorpayKeyId,
      amount: order.razorpay.amount,
      currency: order.razorpay.currency,
      name: "Viagoco",
      description: `${order.match.homeTeam} vs ${order.match.awayTeam} | ${order.section.label}`,
      order_id: order.razorpay.orderId,
      prefill: {
        name: el.buyerName.value.trim(),
        email: el.buyerEmail.value.trim(),
        contact: el.buyerPhone.value.trim()
      },
      theme: { color: "#ff7a18" },
      handler: async (response) => {
        try {
          await verifyOrder({
            orderReference: order.orderReference,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
          });
        } catch (error) {
          showToast(error.message, "error");
        }
      },
      modal: {
        ondismiss: () => showToast("Payment popup closed.", "error")
      }
    });
    rz.open();
    return;
  }

  if (order.mode === "razorpay" && !window.Razorpay) {
    el.payNowBtn.disabled = false;
    el.payNowBtn.textContent = "Create Payment";
    throw new Error("Razorpay checkout script failed to load. Refresh and retry.");
  }

  await new Promise((resolve) => window.setTimeout(resolve, 900));
  await verifyOrder({
    orderReference: order.orderReference,
    demoTransactionId: `DEMO-${Date.now()}`
  });
  el.payNowBtn.disabled = false;
  el.payNowBtn.textContent = "Create Payment";
}

function notifyCheckoutStatusFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const status = String(params.get("payment") || "").trim().toLowerCase();
  const reason = String(params.get("reason") || "").trim();

  if (status === "failed") {
    showToast(reason || "Payment did not complete.", "error", 4800);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

async function refreshLiveData() {
  try {
    await loadMatches();
    if (state.selectedMatch?.slug) {
      await loadMatchDetail(state.selectedMatch.slug, { preserveSection: true });
    }
    const interval = Math.round((state.config.liveRefreshIntervalMs || 20000) / 1000);
    const provider = state.config.matchStatusProvider || "fallback";
    el.liveLabel.textContent = `Live refresh every ${interval}s | Match API: ${provider}`;
  } catch (error) {
    el.liveLabel.textContent = "Live feed retrying...";
  }
}

async function init() {
  attachEvents();
  notifyCheckoutStatusFromQuery();

  try {
    state.config = await api("/api/config");
    await loadMatches();
    if (state.matches.length > 0) {
      await loadMatchDetail(state.matches[0].slug);
    }

    const interval = Math.round((state.config.liveRefreshIntervalMs || 20000) / 1000);
    const provider = state.config.matchStatusProvider || "fallback";
    el.liveLabel.textContent = `Live refresh every ${interval}s | Match API: ${provider}`;

    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = window.setInterval(
      refreshLiveData,
      state.config.liveRefreshIntervalMs || 20000
    );
  } catch (error) {
    showToast(error.message, "error", 5000);
    el.liveLabel.textContent = "Unable to load live inventory.";
  }
}

init();
