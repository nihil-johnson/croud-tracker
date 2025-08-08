(async function () {
  "use strict";

  // Firebase dynamic imports (so failures don't block the UI)
  let db = null;
  let analytics = null;
  let getFirestore, collection, getDocs, addDoc, query, where, serverTimestamp; // removed orderBy

  try {
    const [{ initializeApp }, { getAnalytics }, firestore] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/12.1.0/firebase-analytics.js"),
      import("https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js"),
    ]);

    ({ getFirestore, collection, getDocs, addDoc, query, where, serverTimestamp } = firestore);

    const firebaseConfig = {
      apiKey: "AIzaSyCmixDrT_zPWu-tON6jbI_f-fIuNxv-H50",
      authDomain: "howcrouded.firebaseapp.com",
      projectId: "howcrouded",
      storageBucket: "howcrouded.firebasestorage.app",
      messagingSenderId: "376237926666",
      appId: "1:376237926666:web:ec35f9577b5cff94c232f3",
      measurementId: "G-6QHJY2JGLX",
    };

    const app = initializeApp(firebaseConfig);
    try { analytics = getAnalytics(app); } catch (_) {}
    db = getFirestore(app);
    console.log("[HowCrouded] Firebase initialized");
  } catch (err) {
    console.warn("[HowCrouded] Firebase modules not loaded; running in local-only mode.", err);
  }

  // In-memory submissions fallback
  const localSubmissions = [];
  window.crowdSubmissions = localSubmissions;

  // Elements
  const optionView = document.querySelector(".option-view");
  const optionSubmit = document.querySelector(".option-submit");
  const optionsContainer = document.querySelector(".mode-actions");
  const searchSection = document.querySelector(".search-section");
  const searchInput = document.querySelector("#place-search");
  const searchLabel = document.querySelector(".search-label");
  const suggestions = document.querySelector(".suggestions");
  const viewPanel = document.querySelector(".view-panel");
  const submitPanel = document.querySelector(".submit-panel");
  const thanksEl = document.querySelector(".thanks");

  // View elements
  const noDataEl = viewPanel.querySelector(".no-data");
  const hasDataEl = viewPanel.querySelector(".has-data");
  const chipEl = viewPanel.querySelector(".level-chip");
  const basedOnEl = viewPanel.querySelector(".based-on");

  // State
  let currentMode = null; // "view" | "submit"
  let selectedPlace = null; // { id, name }
  let placesCache = []; // [{id, name}]

  function coercePlaceName(data, idFallback) {
    const candidate = data?.name ?? data?.Name ?? data?.title ?? data?.place ?? idFallback;
    return typeof candidate === "string" ? candidate : String(candidate || idFallback || "");
  }

  async function loadPlaces() {
    if (!db) {
      // Local fallback to two places
      placesCache = [
        { id: "thiruthani", name: "Thiruthani Temple" },
        { id: "santhome", name: "Santhome Church" },
      ];
      console.log(`[HowCrouded] Loaded ${placesCache.length} places (local fallback)`);
      return placesCache;
    }

    try {
      const snap = await getDocs(collection(db, "places"));
      placesCache = snap.docs.map((d) => {
        const name = coercePlaceName(d.data(), d.id);
        return { id: d.id, name };
      }).filter((p) => p.name && p.name.trim().length > 0);
      console.log(`[HowCrouded] Loaded ${placesCache.length} places from Firestore`);
    } catch (e) {
      console.error("[HowCrouded] Failed to fetch places; using local fallback.", e);
      placesCache = [
        { id: "thiruthani", name: "Thiruthani Temple" },
        { id: "santhome", name: "Santhome Church" },
      ];
    }

    return placesCache;
  }

  function filterPlacesPrefix(query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return placesCache.slice(); // show all when empty
    return placesCache.filter((p) => p.name.toLowerCase().startsWith(q));
  }

  function renderSuggestions(items) {
    suggestions.innerHTML = "";
    if (items.length === 0) {
      suggestions.classList.remove("active");
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((place) => {
      const li = document.createElement("li");
      li.textContent = place.name;
      li.setAttribute("role", "option");
      li.addEventListener("click", () => handlePlaceSelect(place));
      frag.appendChild(li);
    });
    suggestions.appendChild(frag);
    suggestions.classList.add("active");
  }

  async function getPlaceSubmissions(placeId) {
    if (!db || !collection || !getDocs || !query || !where) {
      return localSubmissions.filter((s) => s.placeId === placeId);
    }
    try {
      const col = collection(db, "submissions");
      const qy = query(col, where("placeId", "==", placeId));
      const snap = await getDocs(qy);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error("[HowCrouded] Failed to fetch submissions:", e);
      // fallback to any local entries we might have cached
      return localSubmissions.filter((s) => s.placeId === placeId);
    }
  }

  async function computeAggregateLevel(placeId) {
    const items = await getPlaceSubmissions(placeId);
    // Merge with local submissions in case write fell back locally
    const merged = items.concat(localSubmissions.filter((s) => s.placeId === placeId));
    if (merged.length === 0) return null;

    const counts = { Low: 0, Medium: 0, High: 0 };
    merged.forEach((s) => { counts[s.level] = (counts[s.level] || 0) + 1; });

    const maxCount = Math.max(counts.Low, counts.Medium, counts.High);
    const topLevels = ["Low", "Medium", "High"].filter((lvl) => counts[lvl] === maxCount);

    if (topLevels.length === 1) {
      return { level: topLevels[0], total: merged.length };
    }

    // Tie-break by most recent among tied levels
    const latestByLevel = {};
    merged.forEach((s) => {
      const ts = s.createdAt?.toMillis ? s.createdAt.toMillis() : s.timestampMs || 0;
      if (!latestByLevel[s.level] || latestByLevel[s.level] < ts) {
        latestByLevel[s.level] = ts;
      }
    });

    let chosen = topLevels[0];
    let latestTs = latestByLevel[chosen] ?? 0;
    for (const lvl of topLevels) {
      const ts = latestByLevel[lvl] ?? 0;
      if (ts > latestTs) { chosen = lvl; latestTs = ts; }
    }

    return { level: chosen, total: merged.length };
  }

  function resetPanels() {
    viewPanel.classList.remove("active");
    submitPanel.classList.remove("active");
    thanksEl.classList.remove("active");
  }

  function updateViewUI(agg) {
    if (!agg) {
      noDataEl.hidden = false;
      hasDataEl.hidden = true;
      chipEl.textContent = "";
      chipEl.dataset.level = "";
      chipEl.classList.remove("low", "medium", "high");
      basedOnEl.textContent = "";
      return;
    }

    noDataEl.hidden = true;
    hasDataEl.hidden = false;

    chipEl.textContent = agg.level;
    chipEl.dataset.level = agg.level;
    chipEl.classList.remove("low", "medium", "high");
    if (agg.level === "Low") chipEl.classList.add("low");
    if (agg.level === "Medium") chipEl.classList.add("medium");
    if (agg.level === "High") chipEl.classList.add("high");

    basedOnEl.textContent = `Based on ${agg.total} submission${agg.total === 1 ? "" : "s"}`;
  }

  async function updateView(place) {
    resetPanels();
    viewPanel.classList.add("active");

    const agg = await computeAggregateLevel(place.id);
    updateViewUI(agg);
  }

  async function handleSubmission(level, place) {
    const now = Date.now();
    const submissionLocal = { placeId: place.id, level, timestampMs: now };

    if (!db || !collection || !addDoc || !serverTimestamp) {
      localSubmissions.push(submissionLocal);
    } else {
      try {
        await addDoc(collection(db, "submissions"), {
          placeId: place.id,
          level,
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        console.error("[HowCrouded] Firestore write failed; storing locally as fallback.", err);
        localSubmissions.push(submissionLocal);
      }
    }

    console.log(`[HowCrouded] Submission → Place: ${place.name} | Level: ${level}`);

    resetPanels();
    thanksEl.classList.add("active");
    setTimeout(() => { thanksEl.classList.remove("active"); }, 1800);
  }

  function openSubmit(place) {
    resetPanels();
    submitPanel.classList.add("active");

    // Rebind buttons fresh
    const oldButtons = Array.from(submitPanel.querySelectorAll(".level"));
    const newButtons = oldButtons.map((btn) => btn.cloneNode(true));
    oldButtons.forEach((btn, i) => btn.replaceWith(newButtons[i]));

    newButtons.forEach((btn) => {
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const level = btn.getAttribute("data-level");
        handleSubmission(level, place);
      });
    });
  }

  function openSearch(mode) {
    currentMode = mode; // "view" or "submit"
    selectedPlace = null;

    // Emphasis animation
    optionsContainer.classList.toggle("is-view", mode === "view");
    optionsContainer.classList.toggle("is-submit", mode === "submit");

    resetPanels();

    // Show search
    searchSection.classList.add("active");
    searchSection.setAttribute("aria-hidden", "false");

    // Update label/placeholder based on mode
    if (searchLabel) {
      searchLabel.textContent = mode === "view" ? "Search place for view croud" : "Search place for submit croud";
    }
    if (searchInput) {
      searchInput.placeholder = mode === "view"
        ? "Type to search (for view croud, e.g., T for Thiruthani)"
        : "Type to search (for submit croud, e.g., T for Thiruthani)";
    }

    searchInput.value = "";
    suggestions.innerHTML = "";
    suggestions.classList.remove("active");

    // Load places and populate suggestions for current query once loaded
    loadPlaces()
      .then(() => {
        const items = filterPlacesPrefix(searchInput.value);
        renderSuggestions(items);
      })
      .catch((e) => console.error("[HowCrouded] loadPlaces failed", e));

    searchInput.focus();
  }

  function closeSearch() {
    searchSection.classList.remove("active");
    searchSection.setAttribute("aria-hidden", "true");
    suggestions.classList.remove("active");
    optionsContainer.classList.remove("is-view", "is-submit");
  }

  function handlePlaceSelect(place) {
    selectedPlace = place;
    closeSearch();

    if (currentMode === "view") {
      updateView(place);
    } else if (currentMode === "submit") {
      openSubmit(place);
    }
  }

  // Events
  optionView?.addEventListener("click", () => openSearch("view"));
  optionSubmit?.addEventListener("click", () => openSearch("submit"));

  optionView?.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSearch("view"); } });
  optionSubmit?.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSearch("submit"); } });

  searchInput?.addEventListener("input", () => {
    const items = filterPlacesPrefix(searchInput.value);
    renderSuggestions(items);
  });

  // Close suggestions if click outside
  document.addEventListener("click", (e) => {
    if (!searchSection.contains(e.target)) {
      suggestions.classList.remove("active");
    }
  });

  // Initial: preload places quietly (non-blocking)
  loadPlaces().then(() => console.log("[HowCrouded] Preloaded places")).catch(() => {});
})();
