// UV Index — live data via Open-Meteo (free, no API key, CORS-enabled for
// browser fetches). Reverse geocoding for "use my location" via BigDataCloud's
// keyless client-side endpoint.

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_GEOCODE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

const DEFAULT_LOCATION = { lat: 42.3601, lon: -71.0589, label: "Boston, MA" };

// WHO/EPA UV index categories.
const MAX_UV_SCALE = 11;
const UV_CATEGORIES = [
  { max: 2, label: "LOW" },
  { max: 5, label: "MOD" },
  { max: 7, label: "HIGH" },
  { max: 10, label: "VERY HIGH" },
  { max: Infinity, label: "EXTREME" },
];

// Chart coordinate space (matches the SVG viewBox 320x170).
const CHART = { xStart: 20, xEnd: 300, yTop: 45, yBottom: 150 };

// WHO/EPA UV Index color scale (same green/yellow/orange/red/purple bands
// as UV_CATEGORIES above), used to color the chart curve by the *actual*
// UV value at each point rather than a decorative fixed rainbow — so the
// peak reads orange/red/purple based on real severity, not curve position.
const UV_COLOR_STOPS = [
  { uv: 0, rgb: [46, 204, 64] }, // #2ecc40 green — Low
  { uv: 3, rgb: [242, 194, 24] }, // #f2c218 yellow — Moderate
  { uv: 6, rgb: [243, 156, 18] }, // #f39c12 orange — High
  { uv: 8, rgb: [232, 67, 58] }, // #e8433a red — Very High
  { uv: 11, rgb: [155, 48, 217] }, // #9b30d9 purple — Extreme
];

function uvToRGB(uv) {
  const maxStop = UV_COLOR_STOPS[UV_COLOR_STOPS.length - 1];
  const v = Math.max(0, Math.min(uv, maxStop.uv));
  for (let i = 0; i < UV_COLOR_STOPS.length - 1; i++) {
    const a = UV_COLOR_STOPS[i];
    const b = UV_COLOR_STOPS[i + 1];
    if (v >= a.uv && v <= b.uv) {
      const t = (v - a.uv) / (b.uv - a.uv);
      return a.rgb.map((c, idx) => Math.round(c + (b.rgb[idx] - c) * t));
    }
  }
  return maxStop.rgb;
}

function rgbToHex(rgb) {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function uvToColor(uv) {
  return rgbToHex(uvToRGB(uv));
}

// Darkened version for the not-yet-reached (future) part of the curve —
// same hue as the real value, just dimmed, instead of an unrelated palette.
function uvToDarkColor(uv) {
  return rgbToHex(uvToRGB(uv).map((c) => Math.round(c * 0.32)));
}

// ---------- Install banner ----------
const INSTALL_DISMISS_KEY = "uvindex-install-dismissed";
let deferredInstallPrompt = null;

// Registered at top level (not inside init()) since Chrome can fire this
// shortly after the page loads, before DOMContentLoaded's init() even runs.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner();
});

window.addEventListener("appinstalled", () => {
  localStorage.setItem(INSTALL_DISMISS_KEY, "1");
  const banner = document.getElementById("install-banner");
  if (banner) banner.hidden = true;
});

function categorize(uv) {
  return UV_CATEGORIES.find((c) => uv <= c.max).label;
}

// Not medical advice: minutes of unprotected exposure before fair/Type-II
// skin reaches its Minimal Erythemal Dose (the standard burn threshold used
// in public UV guidance). UV Index is defined as erythemal irradiance in
// W/m^2 times 40, so minutesToBurn = MED / (uv/40 * 60) simplifies to
// MED_CONSTANT / uv — 200 is the commonly cited fair-skin constant.
// Actual time varies a lot by skin type (darker skin tolerates several
// times longer exposure); this assumes the most burn-prone end.
const FAIR_SKIN_BURN_CONSTANT = 200;

function estimateTimeToBurn(uv) {
  if (uv < 1) return "60+ mins";
  return `${Math.max(Math.round(FAIR_SKIN_BURN_CONSTANT / uv), 5)} mins`;
}

function formatHourLabel(hour) {
  const h = ((hour % 24) + 24) % 24;
  const period = h >= 12 ? "PM" : "AM";
  const displayHour = h % 12 || 12;
  return `${displayHour} ${period}`;
}

// Open-Meteo hourly `time` strings (e.g. "2026-07-01T14:00") are already in
// the target location's local time, so we compare against a same-shaped key
// for "now" in that timezone rather than parsing them as Dates (which would
// be interpreted in the *browser's* local time and drift across timezones).
function nowKeyForTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:00`;
}

// Smooth curve through arbitrary points via Catmull-Rom -> cubic Bezier.
function pathFromPoints(points) {
  if (!points.length) return "";
  if (points.length === 1) {
    return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  }
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

async function geocodeCity(query) {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Geocoding request failed");
  const data = await res.json();
  const match = data.results && data.results[0];
  if (!match) {
    // The geocoder often can't parse "City, State/Country" as a single
    // string — retry with just the part before the first comma.
    const cityOnly = query.split(",")[0].trim();
    if (cityOnly && cityOnly !== query) return geocodeCity(cityOnly);
    throw new Error(`No results for "${query}"`);
  }
  const label = [match.name, match.admin1 || match.country].filter(Boolean).join(", ");
  return { lat: match.latitude, lon: match.longitude, label };
}

async function fetchSuggestions(query) {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
  const res = await fetchWithTimeout(url, 5000);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((r) => ({
    lat: r.latitude,
    lon: r.longitude,
    // Short label (matches geocodeCity) fills the input on selection;
    // the fuller one disambiguates same-named places in the dropdown list.
    label: [r.name, r.admin1 || r.country].filter(Boolean).join(", "),
    fullLabel: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
  }));
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetchWithTimeout(`${REVERSE_GEOCODE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (!res.ok) throw new Error("Reverse geocoding failed");
    const data = await res.json();
    const region = data.principalSubdivisionCode ? data.principalSubdivisionCode.split("-").pop() : data.principalSubdivision;
    const label = [data.city || data.locality, region].filter(Boolean).join(", ");
    return label || "Current Location";
  } catch (err) {
    console.error("Reverse geocoding failed", err);
    return "Current Location";
  }
}

// Open-Meteo's forecast endpoint occasionally stalls or drops a request
// under load; without a timeout a bad connection just hangs on "Loading…"
// forever. Aborts after timeoutMs so a failure surfaces quickly instead.
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUVForecast(lat, lon) {
  const url = `${FORECAST_URL}?latitude=${lat}&longitude=${lon}&hourly=uv_index&daily=sunrise,sunset&timezone=auto&forecast_days=1`;
  let lastErr;
  // One retry: the forecast endpoint has been observed to intermittently
  // stall on the first attempt but succeed immediately after.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error("UV forecast request failed");
      const data = await res.json();
      return {
        timezone: data.timezone,
        times: data.hourly.time,
        uvValues: data.hourly.uv_index,
        sunrise: data.daily?.sunrise?.[0],
        sunset: data.daily?.sunset?.[0],
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function getBrowserLocation(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    // Geolocation is only available in secure contexts (HTTPS or localhost).
    // Detect this ourselves rather than relying on the browser's error,
    // since some browsers report it as a generic "permission denied".
    if (!window.isSecureContext) {
      reject(new Error("INSECURE_CONTEXT"));
      return;
    }
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60 * 1000 }
    );
  });
}

function describeLocationError(err) {
  if (err && err.message === "INSECURE_CONTEXT") {
    return "Location needs HTTPS. Try search instead";
  }
  if (err && err.code === 1) {
    return "Location permission denied";
  }
  return "Couldn't get your location";
}

// Trims the 24h array down to roughly sunrise-to-sunset, with a 1h pad, so
// the chart isn't mostly flat at zero. Falls back to a UV-threshold guess
// if real sunrise/sunset times aren't available for some reason.
function computeDaylightWindow(uvValues, times, sunrise, sunset) {
  if (sunrise && sunset) {
    const sunriseHour = parseInt(sunrise.slice(11, 13), 10);
    const sunsetHour = parseInt(sunset.slice(11, 13), 10);
    const first = times.findIndex((t) => parseInt(t.slice(11, 13), 10) >= sunriseHour);
    let last = -1;
    for (let i = times.length - 1; i >= 0; i--) {
      if (parseInt(times[i].slice(11, 13), 10) <= sunsetHour) {
        last = i;
        break;
      }
    }
    if (first !== -1 && last !== -1 && last > first) {
      return [Math.max(0, first - 1), Math.min(times.length - 1, last + 1)];
    }
  }

  // No usable sunrise/sunset (e.g. polar day/night) — guess from the UV
  // curve itself instead.
  const hasLight = uvValues.some((v) => v > 0.3);
  if (!hasLight) return [6, 18];
  let first = uvValues.findIndex((v) => v > 0.3);
  let last = uvValues.length - 1 - [...uvValues].reverse().findIndex((v) => v > 0.3);
  first = Math.max(0, first - 1);
  last = Math.min(uvValues.length - 1, last + 1);
  return [first, last];
}

function setLocationLabel(label) {
  const input = document.getElementById("location-input");
  if (input) input.value = label;
}

function setSubtextMessage(msg) {
  const el = document.getElementById("uv-subtext");
  if (el) el.textContent = msg;
}

function renderHeadline(uv, category) {
  const numEl = document.getElementById("uv-number");
  const catEl = document.getElementById("uv-category");
  if (numEl) numEl.textContent = uv;
  if (catEl) catEl.textContent = category;
}

function renderBurn(uv) {
  const el = document.getElementById("burn-value");
  if (el) el.textContent = estimateTimeToBurn(uv);
}

function renderScale(currentUV) {
  const scale = document.querySelector(".uv-scale");
  if (!scale) return;
  const pct = Math.min(currentUV / MAX_UV_SCALE, 1) * 100;
  scale.style.setProperty("--uv-progress", `${pct}%`);
}

function renderPeak(peakUV) {
  const el = document.getElementById("card-peak");
  if (!el) return;
  el.textContent = `Peak ${Math.round(peakUV)}`;
  el.hidden = false;
}

function renderSubtext({ currentUV, times, uvValues, currentIndex, peakUV, peakIndex }) {
  if (currentUV >= 3) {
    let lastHighIdx = currentIndex;
    for (let i = currentIndex; i < uvValues.length; i++) {
      if (uvValues[i] >= 3) lastHighIdx = i;
    }
    const cutoffIdx = Math.min(lastHighIdx + 1, times.length - 1);
    const cutoffHour = parseInt(times[cutoffIdx].slice(11, 13), 10);
    setSubtextMessage(`Use sun protection until ${formatHourLabel(cutoffHour)}`);
  } else if (peakUV >= 3) {
    const peakHour = parseInt(times[peakIndex].slice(11, 13), 10);
    setSubtextMessage(`Low risk now, rises to ${Math.round(peakUV)} around ${formatHourLabel(peakHour)}`);
  } else {
    setSubtextMessage("Low UV risk all day");
  }
}

// Builds the <stop> list for a gradient spanning [x1, x2], with each point's
// color computed from its *actual* UV value (via colorFn) rather than a
// fixed decorative position — so the curve's color always matches reality.
function buildGradientStops(pts, x1, x2, colorFn) {
  const span = x2 - x1 || 1;
  return pts
    .map(([x, , uv]) => {
      const offset = Math.max(0, Math.min(1, (x - x1) / span));
      return `<stop offset="${offset.toFixed(4)}" stop-color="${colorFn(uv)}" />`;
    })
    .join("\n");
}

function renderChart({ times, uvValues, currentIndex, sunrise, sunset }) {
  const [start, end] = computeDaylightWindow(uvValues, times, sunrise, sunset);
  const windowIdx = [];
  for (let i = start; i <= end; i++) windowIdx.push(i);

  const maxVal = Math.max(...windowIdx.map((i) => uvValues[i]), 1);
  const points = windowIdx.map((i) => [
    CHART.xStart + ((i - start) / (end - start || 1)) * (CHART.xEnd - CHART.xStart),
    CHART.yBottom - (uvValues[i] / maxVal) * (CHART.yBottom - CHART.yTop),
    uvValues[i],
  ]);

  let nowPos = windowIdx.indexOf(currentIndex);
  if (nowPos === -1) nowPos = currentIndex < start ? 0 : points.length - 1;

  const brightPoints = points.slice(0, nowPos + 1);
  const darkPoints = points.slice(nowPos);
  const brightPath = pathFromPoints(brightPoints.length ? brightPoints : [points[0]]);
  const darkPath = darkPoints.length > 1 ? pathFromPoints(darkPoints) : "";
  const dot = points[nowPos];
  const firstX = points[0][0];
  const lastX = points[points.length - 1][0];

  const brightStops = buildGradientStops(
    brightPoints.length ? brightPoints : [points[0]],
    firstX,
    dot[0],
    uvToColor
  );
  const darkStops = darkPoints.length > 1 ? buildGradientStops(darkPoints, dot[0], lastX, uvToDarkColor) : "";

  const svg = document.getElementById("uv-chart");
  if (svg) {
    svg.innerHTML = `
      <defs>
        <linearGradient id="curveGradientBright" gradientUnits="userSpaceOnUse" x1="${firstX}" y1="0" x2="${dot[0]}" y2="0">
          ${brightStops}
        </linearGradient>
        <linearGradient id="curveGradientDark" gradientUnits="userSpaceOnUse" x1="${dot[0]}" y1="0" x2="${lastX}" y2="0">
          ${darkStops}
        </linearGradient>
      </defs>
      <path class="uv-curve" d="${brightPath}" fill="none" stroke="url(#curveGradientBright)"
            stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />
      ${darkPath ? `<path class="uv-curve" d="${darkPath}" fill="none" stroke="url(#curveGradientDark)"
            stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />` : ""}
      <circle class="uv-marker" cx="${dot[0]}" cy="${dot[1]}" r="7" fill="#ffffff" />
    `;
  }

  const axis = document.getElementById("chart-axis");
  if (axis) {
    axis.innerHTML = "";
    const count = 5;
    for (let k = 0; k < count; k++) {
      const idxPos = Math.round((k / (count - 1)) * (windowIdx.length - 1));
      const hour = parseInt(times[windowIdx[idxPos]].slice(11, 13), 10);
      const span = document.createElement("span");
      span.textContent = formatHourLabel(hour);
      axis.appendChild(span);
    }
  }
}

// Tracks the active location/load state so auto-refresh (below) knows what
// to re-fetch and never overlaps with an in-flight request.
let currentLocation = null;
let isLoadingLocation = false;
let lastLoadedAt = 0;

async function loadLocation(location) {
  currentLocation = location;
  lastLoadedAt = Date.now();
  isLoadingLocation = true;
  try {
    const { timezone, times, uvValues, sunrise, sunset } = await fetchUVForecast(location.lat, location.lon);

    const nowKey = nowKeyForTimezone(timezone);
    let currentIndex = times.indexOf(nowKey);
    if (currentIndex === -1) {
      const nowHour = nowKey.slice(11, 13);
      currentIndex = times.findIndex((t) => t.slice(11, 13) === nowHour);
    }
    if (currentIndex === -1) currentIndex = Math.min(12, times.length - 1);

    const currentUVRaw = uvValues[currentIndex] ?? 0;
    const currentUV = Math.max(0, Math.round(currentUVRaw));
    const peakUV = Math.max(...uvValues, 0);
    const peakIndex = uvValues.indexOf(peakUV);

    renderHeadline(currentUV, categorize(currentUV));
    renderBurn(currentUV);
    renderScale(currentUV);
    renderPeak(peakUV);
    renderSubtext({ currentUV, times, uvValues, currentIndex, peakUV, peakIndex });
    renderChart({ times, uvValues, currentIndex, sunrise, sunset });
    setLocationLabel(location.label);
  } catch (err) {
    console.error("Failed to load UV data", err);
    setSubtextMessage(navigator.onLine ? "Couldn't load UV data. Check your connection" : "No internet connection");
  } finally {
    isLoadingLocation = false;
  }
}

let suggestionItems = [];
let activeSuggestionIndex = -1;

function hideSuggestions() {
  const box = document.getElementById("location-suggestions");
  const input = document.getElementById("location-input");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  if (input) input.setAttribute("aria-expanded", "false");
  suggestionItems = [];
  activeSuggestionIndex = -1;
}

function updateActiveSuggestion() {
  const box = document.getElementById("location-suggestions");
  if (!box) return;
  [...box.children].forEach((li, i) => {
    li.classList.toggle("is-active", i === activeSuggestionIndex);
  });
}

function renderSuggestions(items) {
  const box = document.getElementById("location-suggestions");
  const input = document.getElementById("location-input");
  if (!box) return;
  suggestionItems = items;
  activeSuggestionIndex = -1;
  box.innerHTML = "";

  if (!items.length) {
    box.hidden = true;
    if (input) input.setAttribute("aria-expanded", "false");
    return;
  }

  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "suggestion-item";
    li.textContent = item.fullLabel || item.label;
    li.id = `suggestion-${i}`;
    li.setAttribute("role", "option");
    // mousedown (not click) fires before the input's blur, so the
    // selection isn't lost to the blur-triggered hideSuggestions().
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectSuggestion(item);
    });
    box.appendChild(li);
  });

  box.hidden = false;
  if (input) input.setAttribute("aria-expanded", "true");
}

async function selectSuggestion(item) {
  hideSuggestions();
  const input = document.getElementById("location-input");
  if (input) input.value = item.label;
  setSubtextMessage("Loading UV data…");
  await loadLocation(item);
}

function initSearchForm() {
  const form = document.getElementById("search-form");
  const input = document.getElementById("location-input");
  if (!form || !input) return;

  let suggestTimer = null;
  let lastQueryLength = 0;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideSuggestions();
    const query = input.value.trim();
    if (!query) return;
    input.disabled = true;
    setSubtextMessage("Loading UV data…");
    try {
      const result = await geocodeCity(query);
      await loadLocation(result);
    } catch (err) {
      console.error(err);
      setSubtextMessage(`Couldn't find "${query}"`);
    } finally {
      input.disabled = false;
    }
  });

  input.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    const query = input.value.trim();
    if (query.length < 2) {
      hideSuggestions();
      lastQueryLength = query.length;
      return;
    }
    // Fire immediately the moment the query crosses the 2-char minimum, so
    // the dropdown appears right as typing starts rather than only once the
    // user pauses. Debounce (briefly) on every keystroke after that.
    const isFirstFetch = lastQueryLength < 2;
    lastQueryLength = query.length;
    suggestTimer = setTimeout(async () => {
      try {
        renderSuggestions(await fetchSuggestions(query));
      } catch (err) {
        console.error("Suggestion fetch failed", err);
      }
    }, isFirstFetch ? 0 : 150);
  });

  input.addEventListener("keydown", (e) => {
    if (!suggestionItems.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, suggestionItems.length - 1);
      updateActiveSuggestion();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
      updateActiveSuggestion();
    } else if (e.key === "Escape") {
      hideSuggestions();
    } else if (e.key === "Enter") {
      // No arrow-key selection yet — default to the top (most relevant)
      // suggestion rather than firing a separate, possibly different lookup.
      e.preventDefault();
      const chosen = activeSuggestionIndex >= 0 ? suggestionItems[activeSuggestionIndex] : suggestionItems[0];
      selectSuggestion(chosen);
    }
  });

  input.addEventListener("blur", () => {
    // Delay so a suggestion's mousedown handler can still fire first.
    setTimeout(hideSuggestions, 150);
  });
}

function isStandaloneDisplay() {
  // iOS Safari doesn't support the display-mode media query for this, so it
  // exposes navigator.standalone instead — need both checks.
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function isMobileBrowser() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function showInstallBanner() {
  if (isStandaloneDisplay() || !isMobileBrowser() || localStorage.getItem(INSTALL_DISMISS_KEY)) return;

  const banner = document.getElementById("install-banner");
  const subtitle = document.getElementById("install-banner-subtitle");
  const actionBtn = document.getElementById("install-action");
  if (!banner) return;

  if (isIOSDevice()) {
    // iOS never fires beforeinstallprompt or exposes a programmatic install
    // API — the only path is the manual Share-sheet instructions. Spelling
    // out "Open as Web App" too since that step (not just adding the icon)
    // is what makes it launch full-screen instead of inside Safari.
    subtitle.textContent = 'Tap Share, then "Add to Home Screen", then turn on "Open as Web App"';
    actionBtn.hidden = true;
  } else {
    subtitle.textContent = "Add to your home screen for quick access";
    actionBtn.hidden = !deferredInstallPrompt;
  }
  banner.hidden = false;
}

function initInstallBanner() {
  const banner = document.getElementById("install-banner");
  const closeBtn = document.getElementById("install-close");
  const actionBtn = document.getElementById("install-action");
  if (!banner) return;

  closeBtn.addEventListener("click", () => {
    banner.hidden = true;
    localStorage.setItem(INSTALL_DISMISS_KEY, "1");
  });

  actionBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    banner.hidden = true;
    if (outcome === "accepted") localStorage.setItem(INSTALL_DISMISS_KEY, "1");
  });

  // Android/Chrome shows the banner once beforeinstallprompt fires (above).
  // iOS never fires that event, so check it directly here — with a short
  // delay so the banner doesn't pop in before the layout has settled.
  if (isIOSDevice()) {
    setTimeout(showInstallBanner, 1500);
  }
}

function initLocateButton() {
  const btn = document.getElementById("locate-btn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.classList.add("is-active");
    setSubtextMessage("Finding your location…");
    try {
      const { lat, lon } = await getBrowserLocation();
      const label = await reverseGeocode(lat, lon);
      await loadLocation({ lat, lon, label });
    } catch (err) {
      console.error(err);
      setSubtextMessage(describeLocationError(err));
    } finally {
      btn.classList.remove("is-active");
    }
  });
}

// UV data doesn't change fast enough to warrant anything more aggressive,
// and refreshing only while visible avoids pointless work/battery drain
// while the app is backgrounded.
const AUTO_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

function initAutoRefresh() {
  setInterval(() => {
    if (currentLocation && !isLoadingLocation && !document.hidden) {
      loadLocation(currentLocation);
    }
  }, AUTO_REFRESH_INTERVAL_MS);

  // Catch up immediately if the app was backgrounded past the interval —
  // e.g. phone was locked for 20 minutes — rather than waiting for the
  // next scheduled tick.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !currentLocation || isLoadingLocation) return;
    if (Date.now() - lastLoadedAt >= AUTO_REFRESH_INTERVAL_MS) {
      loadLocation(currentLocation);
    }
  });
}

function initConnectivityHandling() {
  window.addEventListener("offline", () => {
    setSubtextMessage("No internet connection");
  });
  window.addEventListener("online", () => {
    if (currentLocation && !isLoadingLocation) {
      setSubtextMessage("Loading UV data…");
      loadLocation(currentLocation);
    }
  });
}

async function init() {
  initSearchForm();
  initLocateButton();
  initInstallBanner();
  initAutoRefresh();
  initConnectivityHandling();

  setSubtextMessage("Loading UV data…");
  let location = DEFAULT_LOCATION;
  try {
    const { lat, lon } = await getBrowserLocation();
    location = { lat, lon, label: await reverseGeocode(lat, lon) };
  } catch (err) {
    console.log("Using default location:", err.message);
  }
  await loadLocation(location);
}

document.addEventListener("DOMContentLoaded", init);

// Register the service worker for offline app-shell caching.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .catch((err) => console.error("Service worker registration failed", err));
  });
}
