/* ==========================================================================
   FYRECHAT.JS
   Goals:
   - Keep it readable.
   - Config comes from:
       1) config/fyrechat.default.json (optional)
       2) URL query params (overrides defaults)
   - Features:
       - Multiple bubbles (stack)
       - TTL + fade-out
       - Twitch IRC via websocket
       - Emote rendering (from IRC tags)
       - Badge rendering (via Cloudflare proxy)
   ========================================================================== */

(async function main(){
  // -------------------------
  // DOM references
  // -------------------------
  const $debug = document.getElementById("debug");
  const $stack = document.getElementById("stack");

  // -------------------------
  // Read URL params early
  // -------------------------
  const params = new URLSearchParams(location.search);

  // -------------------------
  // Load defaults from JSON (optional)
  // If it fails, we still run with hardcoded defaults.
  // -------------------------
  const fileDefaults = await safeFetchJson("./config/fyrechat.default.json");

  // -------------------------
  // Hardcoded defaults (fallback baseline)
  // -------------------------
  const baseDefaults = {
    channel: "alveussanctuary",
    max: 30,
    ttl: 22,
    fade: 2,
    debug: false,
    demo: false,
    demoBadges: false,
    badgeProxy: "",
    theme: "glass"
  };

  // Merge order: baseDefaults -> fileDefaults -> URL overrides
  const cfg = {
    ...baseDefaults,
    ...(fileDefaults || {}),
    ...readOverridesFromQuery(params)
  };

  cfg.channel = String(cfg.channel || "alveussanctuary").toLowerCase();
  cfg.max = clampInt(cfg.max, 30, 1, 200);
  cfg.ttl = clampInt(cfg.ttl, 22, 0, 3600);
  cfg.fade = clampFloat(cfg.fade, 2, 0, 30);
  cfg.debug = !!cfg.debug;
  cfg.demo = !!cfg.demo;
  cfg.demoBadges = !!cfg.demoBadges;
  cfg.badgeProxy = String(cfg.badgeProxy || "").replace(/\/+$/,"");

  // Optional: theme switching (future: you can make this dynamic)
  // Right now, we just support setting <link id="themeLink"> from cfg/theme if you want.
  const themeLink = document.getElementById("themeLink");
  if (themeLink && cfg.theme) {
    themeLink.href = `./assets/themes/${cfg.theme}.css`;
  }

  // Debug banner
  if (cfg.debug) {
    $debug.style.display = "block";
    $debug.textContent =
      `${cfg.demo ? "DEMO" : "IRC"} | ch=${cfg.channel} | max=${cfg.max} | ttl=${cfg.ttl}s | fade=${cfg.fade}s | badgeProxy=${cfg.badgeProxy || "(off)"}`;
  }

  // Badge caches
  const badgeCache = {
    global: null,            // Map("set/version" -> url)
    channels: new Map(),     // broadcasterId -> Map(...)
    globalLoaded: false
  };

  // Start
  if (cfg.demo) runDemo();
  else connectIrc(cfg.channel);

  // =========================================================================
  // DEMO MODE
  // =========================================================================
  function runDemo() {
    const samples = [
      { name:"Fyre",     color:"#9bf", text:"FyreChat demo 👋", badges: "broadcaster/1", roomId: "79615025" },
      { name:"ModUser", color:"#6f6", text:"Badges render via badgeProxy (or demoBadges=1).", badges: "moderator/1,subscriber/12", roomId: "79615025" },
      { name:"Viewer",  color:"#fc6", text:"Emotes render if emotes tag provides ranges.", badges: "subscriber/3", roomId: "79615025" }
    ];

    let i = 0;
    setInterval(() => {
      const s = samples[i++ % samples.length];
      addMessage(
        s.name,
        s.color,
        [escapeHtml(s.text)],
        cfg.demoBadges ? s.badges : "",
        s.roomId
      );
    }, 1200);
  }

  // =========================================================================
  // TWITCH IRC CONNECTION
  // =========================================================================
  function connectIrc(chan) {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const anonNick = "justinfan" + Math.floor(Math.random() * 80000 + 1000);

    ws.addEventListener("open", () => {
      if (cfg.debug) $debug.textContent =
        `Connected ✅ as ${anonNick} (joining #${chan}) | badgeProxy=${cfg.badgeProxy || "(off)"}`;

      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIIE");
      ws.send("NICK " + anonNick);
      ws.send("JOIN #" + chan);
    });

    ws.addEventListener("message", (ev) => {
      const data = String(ev.data || "");
      if (data.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv");
        return;
      }

      const lines = data.split("\r\n").filter(Boolean);
      for (const line of lines) {
        if (!line.includes(" PRIVMSG #")) continue;
        const parsed = parsePrivmsg(line);
        if (parsed) {
          addMessage(parsed.name, parsed.color, parsed.htmlParts, parsed.badges, parsed.roomId);
        }
      }
    });

    ws.addEventListener("close", () => {
      if (cfg.debug) $debug.textContent = "Disconnected — retrying in 2s…";
      setTimeout(() => connectIrc(chan), 2000);
    });

    ws.addEventListener("error", () => {
      if (cfg.debug) $debug.textContent = "WebSocket error (network/CSP).";
    });
  }

  // =========================================================================
  // IRC PARSING
  // =========================================================================
  function parsePrivmsg(line) {
    let tags = {};
    let rest = line;

    if (rest.startsWith("@")) {
      const spaceIdx = rest.indexOf(" ");
      const rawTags = rest.slice(1, spaceIdx);
      tags = parseTags(rawTags);
      rest = rest.slice(spaceIdx + 1);
    }

    const msgIdx = rest.indexOf(" :");
    if (msgIdx === -1) return null;

    const text = rest.slice(msgIdx + 2);

    const name = tags["display-name"] || "Unknown";
    const color = tags["color"] || "#ffffff";
    const emotes = tags["emotes"] || "";

    // For badges:
    // - "badges" tag contains "set/version,set/version"
    // - "room-id" is the broadcaster ID needed for channel badge lookup
    const badges = tags["badges"] || "";
    const roomId  = tags["room-id"] || "";

    const htmlParts = buildMessageHtmlParts(text, emotes);
    return { name, color, htmlParts, badges, roomId };
  }

  function parseTags(raw) {
    const out = {};
    for (const p of raw.split(";")) {
      const eq = p.indexOf("=");
      const k = eq === -1 ? p : p.slice(0, eq);
      const v = eq === -1 ? "" : p.slice(eq + 1);
      out[k] = v;
    }
    return out;
  }

  // =========================================================================
  // EMOTE RENDERING
  // =========================================================================
  function buildMessageHtmlParts(text, emotesTag) {
    // No emotes? safe escape text and return.
    if (!emotesTag) return [escapeHtml(text)];

    // emotesTag looks like: "25:0-4,12-16/1902:6-10"
    const ranges = [];
    for (const def of emotesTag.split("/").filter(Boolean)) {
      const [id, locs] = def.split(":");
      if (!id || !locs) continue;

      for (const loc of locs.split(",")) {
        const [startStr, endStr] = loc.split("-");
        const start = Number(startStr), end = Number(endStr);
        if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end, id });
      }
    }

    if (!ranges.length) return [escapeHtml(text)];
    ranges.sort((a,b) => a.start - b.start);

    const parts = [];
    let cursor = 0;

    for (const r of ranges) {
      if (r.start > cursor) parts.push(escapeHtml(text.slice(cursor, r.start)));
      parts.push(`<img class="emote" alt="" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`);
      cursor = r.end + 1;
    }

    if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
    return parts;
  }

  // =========================================================================
  // BADGES (via Cloudflare Worker proxy)
  // =========================================================================
  function buildBadgeMap(helixJson) {
    const map = new Map();
    const sets = helixJson?.data || [];

    for (const set of sets) {
      const setId = set.set_id;
      for (const v of (set.versions || [])) {
        map.set(`${setId}/${v.id}`, v.image_url_2x || v.image_url_1x);
      }
    }
    return map;
  }

  async function ensureBadgesLoaded(broadcasterId) {
    if (!cfg.badgeProxy) return;

    // Global (load once)
    if (!badgeCache.globalLoaded) {
      badgeCache.globalLoaded = true;
      try {
        const r = await fetch(`${cfg.badgeProxy}/badges/global`, { cache: "no-store" });
        badgeCache.global = r.ok ? buildBadgeMap(await r.json()) : new Map();
      } catch {
        badgeCache.global = new Map();
      }
    }

    // Channel (per broadcaster)
    if (!broadcasterId) return;
    if (!badgeCache.channels.has(broadcasterId)) {
      try {
        const r = await fetch(`${cfg.badgeProxy}/badges/channels/${encodeURIComponent(broadcasterId)}`, { cache: "no-store" });
        badgeCache.channels.set(broadcasterId, r.ok ? buildBadgeMap(await r.json()) : new Map());
      } catch {
        badgeCache.channels.set(broadcasterId, new Map());
      }
    }
  }

  function parseBadgesTag(badgesTag) {
    if (!badgesTag) return [];
    return badgesTag.split(",").map(s => s.trim()).filter(Boolean);
  }

  function buildBadgesFragment(keys, broadcasterId) {
    const frag = document.createDocumentFragment();
    const globalMap = badgeCache.global || new Map();
    const chanMap = broadcasterId ? (badgeCache.channels.get(broadcasterId) || new Map()) : new Map();

    for (const key of keys) {
      const url = chanMap.get(key) || globalMap.get(key);
      if (!url) continue;

      const img = document.createElement("img");
      img.className = "badge";
      img.alt = "";
      img.src = url;
      frag.appendChild(img);
    }
    return frag;
  }

  // =========================================================================
  // RENDERING + LIFECYCLE
  // =========================================================================
  async function addMessage(name, color, htmlParts, badgesTag, roomId) {
    const el = document.createElement("div");
    el.className = "msg";

    const meta = document.createElement("div");
    meta.className = "meta";

    // Badges (if configured)
    const badgeKeys = parseBadgesTag(badgesTag);
    if (cfg.badgeProxy && roomId && badgeKeys.length) {
      await ensureBadgesLoaded(roomId);
      meta.appendChild(buildBadgesFragment(badgeKeys, roomId));
    }

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    nameEl.style.color = color || "#fff";

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.innerHTML = htmlParts.join("");

    meta.appendChild(nameEl);
    el.appendChild(meta);
    el.appendChild(textEl);

    $stack.appendChild(el);

    // Keep list tight (oldest removed first)
    while ($stack.children.length > cfg.max) $stack.removeChild($stack.firstChild);

    // TTL removal
    if (cfg.ttl > 0) {
      const removeAtMs = cfg.ttl * 1000;
      const fadeMs = Math.max(0, cfg.fade * 1000);

      if (fadeMs > 0 && removeAtMs > fadeMs) {
        setTimeout(() => el.classList.add("out"), removeAtMs - fadeMs);
        setTimeout(() => el.remove(), removeAtMs);
      } else {
        setTimeout(() => el.remove(), removeAtMs);
      }
    }
  }

  // =========================================================================
  // UTILITIES
  // =========================================================================
  function escapeHtml(str) {
    return String(str)
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return Math.max(min, Math.min(max, i));
  }

  function clampFloat(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function toBool(v) {
    if (typeof v === "boolean") return v;
    const s = String(v).toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }

  function readOverridesFromQuery(params) {
    // Supported overrides:
    // ?ch=valkyrae&max=8&ttl=22&fade=2&debug=1&badgeProxy=...&demo=1&demoBadges=1&theme=glass
    const out = {};
    if (params.has("ch")) out.channel = params.get("ch");
    if (params.has("max")) out.max = Number(params.get("max"));
    if (params.has("ttl")) out.ttl = Number(params.get("ttl"));
    if (params.has("fade")) out.fade = Number(params.get("fade"));
    if (params.has("debug")) out.debug = toBool(params.get("debug"));
    if (params.has("demo")) out.demo = toBool(params.get("demo"));
    if (params.has("demoBadges")) out.demoBadges = toBool(params.get("demoBadges"));
    if (params.has("badgeProxy")) out.badgeProxy = params.get("badgeProxy");
    if (params.has("theme")) out.theme = params.get("theme");
    return out;
  }

  async function safeFetchJson(url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }
})();
