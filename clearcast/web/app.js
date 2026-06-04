"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const views = { upload: $("#view-upload"), batch: $("#view-batch") };
function show(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
}

const VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];
const isVideoName = (n) => VIDEO_EXT.includes((n.split(".").pop() || "").toLowerCase());

let selected = [];        // File[] chosen before submit
let items = [];           // {jobId, name, isVideo, state, el, ws, src, filled}
let polling = false;

/* ---------------- engine status chips ---------------- */
const ENGINE_LABELS = { studio: "Studio AI", fast: "Fast AI", music: "Music removal", basic: "DSP" };
async function refreshEngines() {
  try {
    const j = await (await fetch("/api/health")).json();
    const box = $("#engines");
    box.innerHTML = "";
    for (const key of ["studio", "fast", "music", "basic"]) {
      const ok = j.engines[key];
      const chip = document.createElement("span");
      chip.className = "chip " + (ok ? "on" : "off");
      chip.innerHTML = `<span class="dot"></span><b>${ENGINE_LABELS[key]}</b>`;
      box.appendChild(chip);
    }
    markEngineOption("studio", j.engines.studio);
    markEngineOption("fast", j.engines.fast);
  } catch (e) { /* server starting */ }
}
function markEngineOption(val, ready) {
  const opt = $(`#opt-engine option[value="${val}"]`);
  if (!opt) return;
  opt.dataset.base = opt.dataset.base || opt.textContent;
  opt.textContent = ready ? opt.dataset.base : opt.dataset.base + "  (not installed)";
}

/* ---------------- file selection ---------------- */
const drop = $("#drop"), fileInput = $("#file");
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
fileInput.addEventListener("change", () => addFiles(fileInput.files));
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => { if (e.dataTransfer.files) addFiles(e.dataTransfer.files); });

function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  return Math.max(1, n / 1e3 | 0) + " KB";
}
function addFiles(fl) {
  for (const f of fl) {
    if (!selected.some((s) => s.name === f.name && s.size === f.size)) selected.push(f);
  }
  renderFileList();
}
function renderFileList() {
  const ul = $("#filelist");
  ul.innerHTML = "";
  selected.forEach((f, i) => {
    const li = document.createElement("li");
    li.className = "fchip";
    li.innerHTML = `<span class="ficon">${isVideoName(f.name) ? "🎬" : "🎵"}</span>
      <span class="fname" title="${f.name}">${f.name}</span>
      <span class="fsize">${fmtBytes(f.size)}</span>
      <button class="frm" title="Remove" data-i="${i}">✕</button>`;
    ul.appendChild(li);
  });
  $$(".frm", ul).forEach((b) =>
    b.addEventListener("click", () => { selected.splice(+b.dataset.i, 1); renderFileList(); }));
  const btn = $("#btn-enhance");
  btn.disabled = selected.length === 0;
  btn.querySelector(".cta-label").textContent =
    selected.length === 0 ? "Select files to enhance"
      : `Enhance ${selected.length} file${selected.length > 1 ? "s" : ""}  →`;
}

/* ---------------- sliders ---------------- */
$("#opt-strength").addEventListener("input", (e) => $("#val-strength").textContent = e.target.value + "%");
$("#opt-warmth").addEventListener("input", (e) => $("#val-warmth").textContent = e.target.value + "%");

/* ---------------- start batch ---------------- */
$("#btn-enhance").addEventListener("click", startBatch);
async function startBatch() {
  if (!selected.length) return;
  const cfg = {
    engine: $("#opt-engine").value,
    remove_music: $("#opt-music").checked ? "true" : "false",
    strength: (+$("#opt-strength").value / 100).toFixed(2),
    warmth: (+$("#opt-warmth").value / 100).toFixed(2),
    output_format: $("#opt-format").value,
    target_lufs: $("#opt-lufs").value,
  };
  items = [];
  $("#queue").innerHTML = "";
  show("batch");
  $("#btn-dlall").disabled = true;

  for (const f of selected) {
    const item = { name: f.name, isVideo: isVideoName(f.name), state: "uploading",
                   el: makeCard(f), ws: null, src: "enhanced", filled: false };
    $("#queue").appendChild(item.el);
    items.push(item);
    try {
      const fd = new FormData();
      fd.append("file", f);
      Object.entries(cfg).forEach(([k, v]) => fd.append(k, v));
      const r = await (await fetch("/api/enhance", { method: "POST", body: fd })).json();
      if (!r.job_id) throw new Error(r.detail || "rejected");
      item.jobId = r.job_id; item.state = "queued";
    } catch (e) {
      item.state = "error"; setCardError(item, "Upload failed");
    }
  }
  selected = []; renderFileList();
  if (!polling) { polling = true; pollLoop(); }
}

function makeCard(f) {
  const li = $("#tpl-card").content.firstElementChild.cloneNode(true);
  $(".qkind", li).textContent = isVideoName(f.name) ? "🎬" : "🎵";
  $(".qname", li).textContent = f.name;
  $(".qname", li).title = f.name;
  $(".qstatus", li).textContent = "Waiting…";
  return li;
}

/* ---------------- polling ---------------- */
async function pollLoop() {
  const active = items.filter((it) => it.jobId && ["queued", "processing"].includes(it.state));
  await Promise.all(active.map(async (it) => {
    try {
      const j = await (await fetch("/api/status/" + it.jobId)).json();
      updateCard(it, j);
    } catch (e) { /* transient */ }
  }));
  updateBatchHeader();
  if (items.some((it) => ["uploading", "queued", "processing"].includes(it.state))) {
    setTimeout(pollLoop, 700);
  } else { polling = false; }
}

function updateCard(it, j) {
  it.state = j.status;
  const el = it.el;
  el.dataset.state = j.status;
  const st = $(".qstatus", el);
  if (j.status === "queued") {
    st.textContent = j.ahead > 0 ? `Queued · ${j.ahead} ahead` : "Queued";
  } else if (j.status === "processing") {
    st.textContent = Math.round((j.progress || 0) * 100) + "%";
    $(".qproc .bar", el).style.width = Math.max(4, (j.progress || 0) * 100) + "%";
    $(".qmsg", el).textContent = j.message || "";
  } else if (j.status === "done") {
    st.textContent = "✓ Done";
    if (!it.filled) { it.filled = true; fillDone(it, j); }
  } else if (j.status === "error") {
    st.textContent = "Failed";
    setCardError(it, j.error || j.message || "Enhancement failed");
  }
}

function setCardError(it, msg) {
  it.el.dataset.state = "error";
  $(".qerror", it.el).textContent = msg;
}

function updateBatchHeader() {
  const total = items.length;
  const done = items.filter((it) => it.state === "done").length;
  const err = items.filter((it) => it.state === "error").length;
  const proc = items.find((it) => it.state === "processing");
  $("#batch-bar").style.width = total ? ((done + err) / total * 100) + "%" : "0%";
  $("#batch-count").textContent = `${done + err}/${total} done`;
  const allDone = done + err === total;
  $("#batch-title").textContent = allDone
    ? (err ? `Batch complete · ${err} failed` : "✨ Batch complete")
    : (proc ? `Enhancing ${proc.name}…` : "Enhancing…");
  $("#batch-sub").textContent = allDone
    ? "Toggle Enhanced / Original to compare. Download below."
    : "Files are processed one at a time.";
  $("#btn-dlall").disabled = done === 0;
}

/* ---------------- done card: player + A/B + downloads ---------------- */
function fillDone(it, j) {
  const el = it.el, meta = j.meta || {};
  const badges = $(".qbadges", el);
  const add = (v, l) => { const d = document.createElement("span"); d.className = "qbadge";
    d.innerHTML = `<b>${v}</b> ${l}`; badges.appendChild(d); };
  if (meta.duration) add(fmtTime(meta.duration), "");
  add((meta.engine_used || "studio").replace(/^\w/, (c) => c.toUpperCase()), "");
  if ((meta.stages || []).includes("music-removal")) add("Music", "removed");
  if (typeof meta.lufs_out === "number") add(meta.lufs_out.toFixed(1), "LUFS");

  $(".dl-audio", el).href = "/api/download/" + it.jobId;
  const dv = $(".dl-video", el);
  if (j.has_video) { dv.hidden = false; dv.href = "/api/download/" + it.jobId + "/video"; }

  // play / pause
  $(".play", el).addEventListener("click", () => {
    items.forEach((o) => { if (o !== it && o.ws && o.ws.isPlaying()) o.ws.pause(); });
    if (!it.ws) { ensureWS(it, true); return; }
    it.ws.playPause(); setPlay(it, it.ws.isPlaying());
  });

  // A/B on(=enhanced) / off(=original)
  const input = $(".ab-input", el), sw = $(".ab-switch", el);
  input.addEventListener("change", () => {
    it.src = input.checked ? "enhanced" : "original";
    sw.classList.toggle("is-orig", !input.checked);
    if (it.ws) {
      const t = it.ws.getCurrentTime(), playing = it.ws.isPlaying();
      it.ws.load(audioUrl(it));
      it.ws.once("ready", () => { try { it.ws.setTime(t); } catch (e) {} if (playing) it.ws.play(); });
    }
  });

  // render the waveform right away (don't wait for first play)
  ensureWS(it, false);
}

const audioUrl = (it) => `/api/audio/${it.jobId}/${it.src}`;

function ensureWS(it, playAfter) {
  if (it.ws) { if (playAfter) { it.ws.play(); setPlay(it, true); } return it.ws; }
  if (!window.WaveSurfer) {  // fallback: native audio element
    const a = document.createElement("audio");
    a.controls = true; a.src = audioUrl(it); a.style.width = "100%";
    $(".wave", it.el).replaceChildren(a);
    if (playAfter) a.play();
    it.ws = { isPlaying: () => !a.paused, pause: () => a.pause(), play: () => a.play(),
              playPause: () => a.paused ? a.play() : a.pause(),
              getCurrentTime: () => a.currentTime, setTime: (t) => a.currentTime = t,
              load: (u) => { a.src = u; }, once: (ev, cb) => a.addEventListener("loadeddata", cb, { once: true }) };
    return it.ws;
  }
  const ws = WaveSurfer.create({
    container: $(".wave", it.el), height: 64, waveColor: "#3a3d5c",
    progressColor: "#7c5cff", cursorColor: "#23d3ee", barWidth: 2, barGap: 2, barRadius: 2,
    url: audioUrl(it),
  });
  ws.on("audioprocess", () => updTime(it));
  ws.on("seeking", () => updTime(it));
  ws.on("finish", () => setPlay(it, false));
  ws.on("ready", () => { updTime(it); if (it._playWhenReady) { it._playWhenReady = false; ws.play(); setPlay(it, true); } });
  it.ws = ws;
  if (playAfter) it._playWhenReady = true;
  return ws;
}
function setPlay(it, playing) {
  $(".play-ico", it.el).setAttribute("d", playing ? "M6 5h4v14H6zM14 5h4v14h-4z" : "M8 5v14l11-7z");
}
function updTime(it) {
  if (!it.ws) return;
  const cur = it.ws.getCurrentTime ? it.ws.getCurrentTime() : 0;
  const dur = it.ws.getDuration ? it.ws.getDuration() : 0;
  $(".time", it.el).textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  if (it.ws.isPlaying) setPlay(it, it.ws.isPlaying());
}
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------------- batch actions ---------------- */
$("#btn-dlall").addEventListener("click", () => {
  const done = items.filter((it) => it.state === "done");
  let delay = 0;
  done.forEach((it) => {
    const links = [$(".dl-audio", it.el)];
    const v = $(".dl-video", it.el); if (!v.hidden) links.push(v);
    links.forEach((a) => { setTimeout(() => clickDownload(a.href), delay); delay += 400; });
  });
});
function clickDownload(href) {
  const a = document.createElement("a");
  a.href = href; a.download = ""; document.body.appendChild(a); a.click(); a.remove();
}
$("#btn-new").addEventListener("click", () => location.reload());

/* ---------------- boot ---------------- */
refreshEngines();
setInterval(refreshEngines, 4000);
renderFileList();
