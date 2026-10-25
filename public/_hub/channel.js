/*
 * Channel shim. The server puts this script at the top of every overlay/control page that was
 * opened with ?profile=<channel id>. It makes the page behave as that channel without the page
 * knowing about channels:
 *   - every request the page makes to this site (fetch, EventSource, links) gets ?profile=<id>
 *   - the channel's key is sent with every fetch as the x-channel-key header
 *   - a key in the address (#key=...) is stored in this browser and removed from the address
 * The key lives in localStorage and never in a URL the OBS browser source uses.
 */
(function () {
  "use strict";
  if (window.HubChannel) return;
  var id = new URLSearchParams(location.search).get("profile");
  if (!id) return;

  var STORE = "hub-channel-key:" + id;
  var key = "";
  try { key = localStorage.getItem(STORE) || ""; } catch (e) { /* storage blocked */ }

  var fromHash = /(?:^|[#&])key=([^&]+)/.exec(location.hash || "");
  if (fromHash) {
    key = decodeURIComponent(fromHash[1]);
    try { localStorage.setItem(STORE, key); } catch (e) { /* storage blocked */ }
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ }
  }

  var SKIP = /^\/(_hub|kanal|api\/channels)(\/|$)/;

  // The same address with ?profile= added, or null when it is not a request to this site.
  function withProfile(input) {
    var raw = typeof input === "string" ? input : (typeof URL !== "undefined" && input instanceof URL ? input.href : null);
    if (raw === null) return null;
    var url;
    try { url = new URL(raw, location.href); } catch (e) { return null; }
    if (url.origin !== location.origin || SKIP.test(url.pathname)) return null;
    if (!url.searchParams.has("profile")) url.searchParams.set("profile", id);
    return url.pathname + url.search + url.hash;
  }

  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      var local = withProfile(input);
      if (local !== null) {
        input = local;
        if (key) {
          var headers = new Headers((init && init.headers) || undefined);
          if (!headers.has("x-channel-key")) headers.set("x-channel-key", key);
          init = Object.assign({}, init, { headers: headers });
        }
      }
      return realFetch.call(this, input, init).then(function (response) {
        if (response.status === 401) rejected();
        return response;
      });
    };
  }

  var RealEventSource = window.EventSource;
  if (RealEventSource) {
    var ChannelEventSource = function (url, config) {
      var local = withProfile(url);
      return new RealEventSource(local !== null ? local : url, config);
    };
    ChannelEventSource.prototype = RealEventSource.prototype;
    ["CONNECTING", "OPEN", "CLOSED"].forEach(function (name) { ChannelEventSource[name] = RealEventSource[name]; });
    window.EventSource = ChannelEventSource;
  }

  function rewriteLinks(root) {
    var anchors = [];
    if (root.nodeType === 1 && root.matches("a[href]")) anchors.push(root);
    if (root.querySelectorAll) anchors.push.apply(anchors, root.querySelectorAll("a[href]"));
    anchors.forEach(function (anchor) {
      var href = anchor.getAttribute("href");
      if (!href || href.charAt(0) === "#" || /^(mailto|tel|javascript):/i.test(href) || anchor.hasAttribute("download")) return;
      var local = withProfile(href);
      if (local !== null && local !== href) anchor.setAttribute("href", local);
    });
  }

  function badge(text, kind) {
    var box = document.createElement("div");
    var colours = kind === "warn" ? "background:#ffd60a;color:#17131f" : "background:#17131f;color:#ededed";
    box.setAttribute("style", "position:fixed;left:16px;bottom:16px;z-index:2147483646;max-width:340px;font:600 13px/1.4 system-ui,sans-serif;" +
      "padding:9px 13px;border-radius:12px;border:2px solid #ffd60a;box-shadow:0 8px 24px -8px rgba(0,0,0,.5);" + colours);
    box.textContent = text;
    return box;
  }

  var warned = false;
  function rejected() {
    if (warned) return;
    warned = true;
    // Only channels get this message; a 401 on a legacy profile is just the old password prompt.
    realFetch.call(window, "/api/channels/" + encodeURIComponent(id)).then(function (response) {
      if (!response.ok) return;
      var box = badge(key
        ? "Nøglen til denne kanal passer ikke (mere). Åbn panel-linket fra kanal-siden igen."
        : "Du mangler nøglen til denne kanal, så du kan kun se den. Åbn panel-linket fra kanal-siden.", "warn");
      var link = document.createElement("a");
      link.href = "/kanal/?c=" + encodeURIComponent(id);
      link.textContent = " Åbn kanal-siden";
      link.setAttribute("style", "color:inherit;text-decoration:underline");
      box.appendChild(link);
      document.body.appendChild(box);
    }).catch(function () { /* offline: nothing to add */ });
  }

  var ROLE_NAMES = { owner: "ejer", mod: "moderator", tracker: "tracker" };
  function showRole() {
    if (!key || !/control|panel/i.test(location.pathname)) return;
    realFetch.call(window, "/api/channels/" + encodeURIComponent(id) + "/me", { headers: { "x-channel-key": key } })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (me) {
        if (!me) return;
        // The key is the password here, so the old password box has nothing left to do.
        document.querySelectorAll('input[type="password"]').forEach(function (input) {
          var holder = input.closest("section") || input.closest(".box");
          if (holder && !holder.id) holder.style.display = "none";
        });
        document.body.appendChild(badge("Kanal " + id + " · " + (ROLE_NAMES[me.role] || me.role)));
      })
      .catch(function () { /* offline: nothing to add */ });
  }

  window.HubChannel = {
    id: id,
    getKey: function () { return key; },
    setKey: function (value) {
      key = String(value || "").trim();
      try { localStorage.setItem(STORE, key); } catch (e) { /* storage blocked */ }
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    rewriteLinks(document);
    showRole();
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) { if (node.nodeType === 1) rewriteLinks(node); });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
})();
