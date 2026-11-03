const REPO = "saifurpro/MCQ";
const BRANCH = "master";
const LEGACY_FILE = "mcq-data.json";
const INDEX_FILE = "mcq-index.json";
const CHUNK_SIZE = 1000;
const PAGE_SIZE = 25;
const CATS = ["বিসিএস", "প্রাইমারি", "নিবন্ধন", "পিএসসি", "১৩-২০ গ্রেড"];
const ICONS = {"বিসিএস":"🏛️", "প্রাইমারি":"🏫", "নিবন্ধন":"📝", "পিএসসি":"📋", "১৩-২০ গ্রেড":"🎓"};
const L = ["ক", "খ", "গ", "ঘ"];
const BN = "০১২৩৪৫৬৭৮৯";
const KEY = "mcq_questions_v1", PK = "mcq_progress_v1", TK = "mcq_theme", AK = "mcq_admin", UK = "mcq_unlock";
const $ = id => document.getElementById(id);
const d2e = s => String(s).replace(/[০-৯]/g, c => BN.indexOf(c));
const bn = n => String(n).replace(/\d/g, c => BN[c]);
const norm = s => d2e(s).toLowerCase().replace(/[\s\u200c\u200d।?,.!:;'"’“”‘()\[\]\-–—_]/g, "");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
const today = () => new Date().toLocaleDateString("en-CA");
const localGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
const localSet = (k, v) => { try { localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); } catch (_) {} };
const localRemove = k => { try { localStorage.removeItem(k); } catch (_) {} };
const isDummy = x => x && /^s[0-4]$/.test(x.id);
const b64 = text => { const bytes = new TextEncoder().encode(text); let binary = ""; bytes.forEach(b => binary += String.fromCharCode(b)); return btoa(binary); };
const slug = c => "c" + CATS.indexOf(c);
const chunkFile = (c, i) => `mcq-data/${slug(c)}/${String(i + 1).padStart(4, "0")}.json`;

let db = null, M = blankManifest(), P = {a:{}, d:{}, last:null, goal:50};
let Q = [], loadedChunks = [], chunkQuestions = new Map(), idToPath = new Map(), activeQuestionIds = new Set();
const duplicateIndex = new Map(CATS.map(c => [c, new Set()]));
let selectedCat = CATS[0], wrongCat = CATS[0], view = "home", term = "", wrongTerm = "";
let shown = PAGE_SIZE, wrongShown = PAGE_SIZE, admin = false, legacyData = false;
let dirtyChunks = new Set(), dirtyMeta = false, saveTimer = null, searchTimer = null, examTimer = null, examState = null, pushBusy = false, moreObserver = null, moreInFlight = false;
try { admin = localStorage.getItem(UK) === "1"; } catch (_) {}

function blankManifest() {
  const categories = {};
  CATS.forEach(c => categories[c] = {count:0, chunks:[]});
  return {v:3, chunkSize:CHUNK_SIZE, categories};
}
function normalizeManifest(data) {
  const out = blankManifest();
  if (!data || !data.categories) return out;
  CATS.forEach(c => {
    const source = data.categories[c] || {};
    out.categories[c] = {
      count: Math.max(0, Number(source.count) || 0),
      chunks: Array.isArray(source.chunks) ? source.chunks.map(x => typeof x === "string" ? x : x.file).filter(Boolean) : []
    };
  });
  return out;
}
function dbOpen() {
  return new Promise(resolve => {
    if (!("indexedDB" in window)) return resolve(null);
    const request = indexedDB.open("mcq-preparation", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("cache");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}
function dbGet(key) {
  return new Promise(resolve => {
    if (!db) return resolve(null);
    const tx = db.transaction("cache", "readonly"), req = tx.objectStore("cache").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}
function dbPut(key, value) {
  return new Promise(resolve => {
    if (!db) return resolve(false);
    const tx = db.transaction("cache", "readwrite");
    tx.objectStore("cache").put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}
function dbClearChunks() {
  return new Promise(resolve => {
    if (!db) return resolve();
    const tx = db.transaction("cache", "readwrite"), store = tx.objectStore("cache");
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith("chunk:")) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
function headers() {
  const saved = localGet(AK);
  return {Authorization:"Bearer " + ((saved && saved.t) || ""), Accept:"application/vnd.github+json"};
}
function api(path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${REPO}/${path.startsWith("git/") ? "" : "contents/"}${encoded}`;
}
async function apiCall(url, options = {}) {
  const response = await fetch(url, {cache:"no-store", ...options});
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).message || ""; } catch (_) {}
    throw new Error(response.status + (detail ? " " + detail : ""));
  }
  return response.status === 204 ? {} : response.json();
}
async function rawJson(path) {
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${path}?t=${Date.now()}`, {cache:"no-store"});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("GitHub " + response.status);
  return response.json();
}
function setStatus(text) {
  ["gst", "gst0", "gst1", "gst2"].forEach(id => { if ($(id)) $(id).textContent = text; });
}
function token() { const saved = localGet(AK); return (saved && saved.t) || ""; }
function setProgress() { dbPut("progress", P).then(ok => { if (!ok) localSet(PK, P); }); }
function pathCategory(path) {
  for (const c of CATS) if ((M.categories[c].chunks || []).includes(path)) return c;
  return selectedCat;
}
function indexChunk(category, path, questions) {
  if (!duplicateIndex.has(category)) duplicateIndex.set(category, new Set());
  const keys = duplicateIndex.get(category);
  questions.forEach(question => {
    idToPath.set(question.id, path);
    if (question.q) keys.add(norm(question.q));
    if (P.a[question.id]) {
      P.a[question.id].category = category;
      P.a[question.id].path = path;
    }
  });
}

async function getChunk(path, category, force = false) {
  if (chunkQuestions.has(path) && !force) return chunkQuestions.get(path);
  let questions = null;
  if (!force) questions = await dbGet("chunk:" + path);
  if (questions && !Array.isArray(questions)) questions = questions.questions;
  if (!navigator.onLine && Array.isArray(questions)) {
    questions = questions.filter(x => !isDummy(x));
    chunkQuestions.set(path, questions);
    indexChunk(category, path, questions);
    return questions;
  }
  try {
    const data = await rawJson(path);
    if (data) {
      questions = Array.isArray(data) ? data : data.questions;
      if (!Array.isArray(questions)) throw new Error("ফাইলের ফরম্যাট সঠিক নয়");
      questions = questions.filter(x => x && !isDummy(x));
      await dbPut("chunk:" + path, questions);
    } else if (!Array.isArray(questions)) questions = [];
  } catch (error) {
    if (!Array.isArray(questions)) throw error;
  }
  chunkQuestions.set(path, questions || []);
  indexChunk(category, path, questions || []);
  return questions || [];
}
async function activateChunk(category, index) {
  const info = M.categories[category], path = info && info.chunks[index];
  if (!path || loadedChunks.includes(path)) return;
  const list = await getChunk(path, category);
  loadedChunks.push(path);
  list.forEach(x => { if (!activeQuestionIds.has(x.id)) { Q.push(x); activeQuestionIds.add(x.id); } });
  shown = Math.max(shown, PAGE_SIZE);
}
async function selectCategory(category, reset = true) {
  if (!CATS.includes(category)) category = CATS[0];
  selectedCat = category;
  if (reset) { Q = []; loadedChunks = []; activeQuestionIds.clear(); shown = PAGE_SIZE; term = ""; if ($("ss")) $("ss").value = ""; }
  try {
    if (!loadedChunks.length && M.categories[category].chunks.length) await activateChunk(category, 0);
  } catch (error) { setStatus("প্রশ্ন লোড করা যায়নি: " + error.message); }
  if (view === "study") study();
}
async function loadNextChunk() {
  const next = loadedChunks.length;
  if (next >= M.categories[selectedCat].chunks.length) return false;
  try { await activateChunk(selectedCat, next); study(); return true; }
  catch (error) { setStatus("আরও প্রশ্ন লোড করা যায়নি: " + error.message); return false; }
}
async function loadAllCategory(category) {
  if (selectedCat !== category) await selectCategory(category);
  const paths = M.categories[category].chunks;
  for (let i = loadedChunks.length; i < paths.length; i++) await activateChunk(category, i);
  return Q;
}

async function migrateLegacy(rows) {
  M = blankManifest(); chunkQuestions.clear(); idToPath.clear();
  const valid = rows.filter(x => x && x.q && Array.isArray(x.o) && x.o.length === 4 && CATS.includes(x.c) && !isDummy(x));
  CATS.forEach(category => {
    const items = valid.filter(x => x.c === category);
    for (let start = 0, index = 0; start < items.length; start += CHUNK_SIZE, index++) {
      const path = chunkFile(category, index), batch = items.slice(start, start + CHUNK_SIZE);
      M.categories[category].chunks.push(path);
      M.categories[category].count += batch.length;
      chunkQuestions.set(path, batch);
      indexChunk(category, path, batch);
      dbPut("chunk:" + path, batch);
      if (admin && token()) dirtyChunks.add(path);
    }
  });
  legacyData = valid.length > 0;
  dirtyMeta = legacyData && admin && !!token();
  await dbPut("manifest", M);
  if (legacyData) await dbPut("migrationPending", true);
  if (dirtyMeta) await dbPut("dirty", {chunks:[...dirtyChunks], meta:dirtyMeta});
}
async function loadData() {
  legacyData = !!(await dbGet("migrationPending"));
  const pending = await dbGet("dirty");
  const cachedManifest = normalizeManifest(await dbGet("manifest"));
  let gotManifest = false;
  if (pending && pending.meta) { M = cachedManifest; gotManifest = true; }
  try {
    const remote = await rawJson(INDEX_FILE);
    if (remote && !(pending && pending.meta)) {
      M = normalizeManifest(remote); gotManifest = true;
      await dbPut("manifest", M);
    }
  } catch (_) {}
  if (!gotManifest && cachedManifest && Object.keys(cachedManifest.categories).length) {
    M = cachedManifest;
    gotManifest = CATS.some(c => M.categories[c].chunks.length || M.categories[c].count);
  }
  if (pending) {
    dirtyChunks = new Set(pending.chunks || []);
    dirtyMeta = !!pending.meta;
  }
  if (!gotManifest) {
    let legacy = null;
    try {
      const data = await rawJson(LEGACY_FILE);
      if (data) legacy = Array.isArray(data) ? data : data.questions;
    } catch (_) {}
    if (!Array.isArray(legacy)) {
      const local = localGet(KEY);
      legacy = Array.isArray(local) ? local : [];
    }
    if (legacy.length) {
      await migrateLegacy(legacy);
      setStatus("পুরোনো প্রশ্নগুলো নতুন ভাগে সাজানো হয়েছে। অ্যাডমিন টোকেন দিলে GitHub-এ একবারে আপলোড হবে।");
      if (admin && token()) await push();
    } else {
      M = cachedManifest || blankManifest();
      await dbPut("manifest", M);
    }
  }
}

function markDirty(path) {
  dirtyChunks.add(path); dirtyMeta = true;
  const list = chunkQuestions.get(path) || [];
  dbPut("chunk:" + path, list); dbPut("manifest", M);
  dbPut("dirty", {chunks:[...dirtyChunks], meta:dirtyMeta});
  if (!admin || !token()) {
    setStatus("অফলাইনে/টোকেন ছাড়া সেভ হয়েছে। ইন্টারনেট ও অ্যাডমিন টোকেন পেলে GitHub-এ আপলোড হবে।");
    return;
  }
  setStatus("⏳ পরিবর্তন GitHub-এ সেভ হচ্ছে…");
  clearTimeout(saveTimer); saveTimer = setTimeout(push, 1200);
}
async function push() {
  if (!admin || !token() || pushBusy || (!dirtyChunks.size && !dirtyMeta)) return;
  pushBusy = true; setStatus("⏳ GitHub-এ আপলোড হচ্ছে…");
  let succeeded = false;
  try {
    const ref = await apiCall(api(`git/ref/heads/${encodeURIComponent(BRANCH)}`), {headers:headers()});
    const baseCommit = ref.object.sha;
    const commit = await apiCall(api(`git/commits/${baseCommit}`), {headers:headers()});
    const tree = [];
    const paths = [...dirtyChunks], snapshots = new Map();
    for (const path of paths) {
      const questions = chunkQuestions.get(path) || await dbGet("chunk:" + path) || [];
      snapshots.set(path, JSON.stringify(questions));
      const category = pathCategory(path);
      const data = JSON.stringify({v:3, category, questions});
      const blob = await apiCall(api("git/blobs"), {method:"POST", headers:{...headers(), "Content-Type":"application/json"}, body:JSON.stringify({content:b64(data), encoding:"base64"})});
      tree.push({path, mode:"100644", type:"blob", sha:blob.sha});
    }
    const manifestSnapshot = JSON.stringify(M);
    if (dirtyMeta) {
      const blob = await apiCall(api("git/blobs"), {method:"POST", headers:{...headers(), "Content-Type":"application/json"}, body:JSON.stringify({content:b64(manifestSnapshot), encoding:"base64"})});
      tree.push({path:INDEX_FILE, mode:"100644", type:"blob", sha:blob.sha});
    }
    const nextTree = await apiCall(api("git/trees"), {method:"POST", headers:{...headers(), "Content-Type":"application/json"}, body:JSON.stringify({base_tree:commit.tree.sha, tree})});
    const nextCommit = await apiCall(api("git/commits"), {method:"POST", headers:{...headers(), "Content-Type":"application/json"}, body:JSON.stringify({message:"Update MCQ question chunks", tree:nextTree.sha, parents:[baseCommit]})});
    await apiCall(api(`git/refs/heads/${encodeURIComponent(BRANCH)}`), {method:"PATCH", headers:{...headers(), "Content-Type":"application/json"}, body:JSON.stringify({sha:nextCommit.sha})});
    paths.forEach(path => {
      const current = JSON.stringify(chunkQuestions.get(path) || []);
      if (current === snapshots.get(path)) dirtyChunks.delete(path);
    });
    if (JSON.stringify(M) === manifestSnapshot) dirtyMeta = false;
    legacyData = false;
    await dbPut("dirty", {chunks:[...dirtyChunks], meta:dirtyMeta});
    if (!dirtyChunks.size && !dirtyMeta) await dbPut("dirty", null);
    await dbPut("manifest", M);
    await dbPut("migrationPending", false);
    succeeded = true;
    setStatus("✔ GitHub-এ পরিবর্তন সেভ হয়েছে।");
  } catch (error) {
    setStatus("✘ GitHub-এ সেভ হয়নি: " + error.message + "। পরিবর্তন এই ডিভাইসে রাখা হয়েছে; আবার চেষ্টা করুন।");
  } finally {
    pushBusy = false;
    if (succeeded && (dirtyChunks.size || dirtyMeta)) { clearTimeout(saveTimer); saveTimer = setTimeout(push, 200); }
  }
}

function categoryCount(c) { return M.categories[c].count || 0; }
function categoryDone(c) { return Object.values(P.a).filter(x => x && x.category === c).length; }
function dailyCount() { return Object.keys(P.d[today()] || {}).length; }
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
}
function categoryTabs(el, current, onSelect) {
  el.innerHTML = CATS.map(c => `<button class="tab ${c === current ? "on" : ""}" data-c="${esc(c)}">${ICONS[c]} ${esc(c)}</button>`).join("");
  el.querySelectorAll("button").forEach(button => button.onclick = () => onSelect(button.dataset.c));
}
function nav() {
  const items = [["home","🏠","হোম"],["study","📖","পড়া"],["exam","📝","পরীক্ষা"]];
  if (admin) items.push(["add","➕","যোগ"]);
  items.push(["set","⚙️","সেটিংস"]);
  $("nav").innerHTML = items.map(([v, icon, label]) => `<button data-v="${v}" class="${v === view || (view === "wrong" && v === "study") ? "on" : ""}"><span>${icon}</span>${label}</button>`).join("");
  $("nav").querySelectorAll("button").forEach(button => button.onclick = () => go(button.dataset.v));
}
function go(next) {
  if (next === "set" && !admin) {
    const pin = prompt("সেটিংসে ঢুকতে পিন দিন");
    if (pin === null) return;
    if (pin.trim() !== "2026") { alert("ভুল পিন"); return; }
    admin = true; try { localStorage.setItem(UK, "1"); } catch (_) {}
  }
  if (next === "add" && !admin) next = "home";
  view = next; render(); window.scrollTo(0, 0);
  if (view === "study" && !loadedChunks.length) selectCategory(selectedCat);
  if (view === "wrong") renderWrong();
  if (view === "set") sets();
}
function render() {
  if (view === "add" && !admin) view = "home";
  document.querySelectorAll(".v").forEach(section => section.classList.toggle("on", section.id === "v-" + view));
  nav();
  if (view === "home") home();
  if (view === "study") study();
  if (view === "exam") examSetup();
  if (view === "set") sets();
  if (view === "add") sets();
}
function home() {
  const count = dailyCount(), goal = Math.max(1, Number(P.goal) || 50), pct = Math.min(100, Math.round(count / goal * 100));
  const total = CATS.reduce((sum, c) => sum + categoryCount(c), 0);
  const done = Object.keys(P.a).length;
  const last = P.last;
  $("v-home").innerHTML = `<div class="hero"><div>আজকের লক্ষ্য</div><div class="big">${bn(count)}<small> / ${bn(goal)}টি</small></div><div class="pb"><i style="width:${pct}%"></i></div><div>${pct >= 100 ? "🎉 আজকের লক্ষ্য পূরণ হয়েছে!" : `আর ${bn(Math.max(0, goal - count))}টি পড়লেই লক্ষ্য পূরণ`}</div><button class="btn go" id="hstudy">▶ পড়া শুরু করুন</button>${last ? `<div style="font-size:13px;margin-top:8px;opacity:.9">শেষ পড়া: ${esc(last.category)} — আবার শুরু করুন</div>` : ""}</div><h3>ক্যাটাগরি · মোট ${bn(total)}টি প্রশ্ন</h3><div class="grid">${CATS.map(c => { const n = categoryCount(c), d = categoryDone(c), p = n ? Math.round(d / n * 100) : 0; return `<button class="cc" data-c="${esc(c)}"><span class="ic">${ICONS[c]}</span><b>${esc(c)}</b><div class="pb"><i style="width:${p}%"></i></div><span class="mu">${bn(d)}/${bn(n)} পড়া</span></button>`; }).join("")}</div><h3>দ্রুত পরীক্ষা</h3><button class="card wbtn" id="hexam"><span>📝 এলোমেলো প্রশ্নে পরীক্ষা দিন</span><b>শুরু করুন →</b></button><h3>রিভিশন</h3><button class="card wbtn" id="hwrong"><span>❌ ভুল করা প্রশ্ন আবার পড়ুন</span><b>${bn(Object.values(P.a).filter(x => x && !x.ok).length)}</b></button><div class="mu">অফলাইন কপি এই ডিভাইসে IndexedDB-তে থাকে।</div>`;
  $("hstudy").onclick = () => { if (P.last) resume(); else selectCategory(CATS[0]).then(() => go("study")); };
  $("v-home").querySelectorAll(".cc").forEach(button => button.onclick = () => { selectCategory(button.dataset.c).then(() => go("study")); });
  $("hexam").onclick = () => go("exam");
  $("hwrong").onclick = () => go("wrong");
}
function questionCard(x, index, path) {
  const state = P.a[x.id];
  return `<div class="card" data-id="${esc(x.id)}" data-path="${esc(path || idToPath.get(x.id) || "")}"><span class="cat">${esc(x.c || selectedCat)}</span> <span class="mu">#${bn(index + 1)}</span>${state ? (state.ok ? ' <span style="color:var(--ok)">✔ পড়া</span>' : ' <span style="color:var(--no)">✘ আবার দেখুন</span>') : ""}<div class="q">${esc(x.q)}</div>${(x.o || []).map((option, j) => `<button class="o" data-j="${j}">${L[j]}. ${esc(option)}</button>`).join("")}<div class="ex" style="display:none"></div>${admin ? '<div class="row"><button class="btn del" style="font-size:13px">মুছুন</button></div>' : ""}</div>`;
}
function attachQuestionEvents(container) {
  container.querySelectorAll(".card[data-id]").forEach(card => {
    const question = Q.find(x => x.id === card.dataset.id) || (window.wrongQuestions || []).find(x => x.id === card.dataset.id);
    if (!question) return;
    card.querySelectorAll(".o").forEach(button => button.onclick = () => {
      const answer = Number(button.dataset.j); record(question, answer === Number(question.a), card.dataset.path);
      card.querySelectorAll(".o").forEach(option => { option.disabled = true; if (Number(option.dataset.j) === Number(question.a)) option.classList.add("ok"); });
      if (answer !== Number(question.a)) button.classList.add("no");
      const explanation = card.querySelector(".ex"); explanation.style.display = "block";
      explanation.textContent = (answer === Number(question.a) ? "✔ সঠিক। " : "✘ ভুল। সঠিক উত্তর: " + L[question.a] + ". ") + (question.e || "");
    });
    const del = card.querySelector(".del");
    if (del) del.onclick = () => { if (admin && confirm("প্রশ্নটি মুছবেন?")) removeQuestion(question, card.dataset.path); };
  });
}
function record(question, correct, path) {
  P.a[question.id] = {ok:correct, category:question.c || selectedCat, path:path || idToPath.get(question.id) || ""};
  P.last = {id:question.id, category:question.c || selectedCat, path:path || idToPath.get(question.id) || ""};
  if (!P.d[today()]) P.d[today()] = {};
  P.d[today()][question.id] = correct;
  setProgress(); nav();
}
function filteredStudy() {
  const query = norm(term);
  return Q.filter(x => !query || norm([x.q, ...(x.o || []), x.e, x.c].join(" ")).includes(query));
}
function study() {
  categoryTabs($("sc"), selectedCat, c => selectCategory(c));
  const wrongCount = Object.values(P.a).filter(x => x && !x.ok).length;
  $("wrongShortcut").textContent = `❌ ভুল (${bn(wrongCount)})`;
  const found = filteredStudy(), visible = found.slice(0, shown);
  $("scn").textContent = `${bn(found.length)}টি দেখানো / ${bn(categoryCount(selectedCat))}টি মোট · ${esc(selectedCat)}`;
  $("sl").innerHTML = visible.length ? visible.map((x, i) => questionCard(x, i, idToPath.get(x.id))).join("") : `<p class="mu">${categoryCount(selectedCat) ? "কোনো প্রশ্ন মেলেনি।" : "এই ক্যাটাগরিতে এখনো প্রশ্ন যোগ করা হয়নি।"}</p>`;
  attachQuestionEvents($("sl"));
  const hasMoreLoaded = shown < found.length;
  const hasMoreChunks = loadedChunks.length < M.categories[selectedCat].chunks.length;
  $("more").style.display = hasMoreLoaded || hasMoreChunks ? "block" : "none";
  $("more").textContent = hasMoreLoaded ? `আরও ${bn(PAGE_SIZE)}টি দেখুন` : (hasMoreChunks ? "আরও প্রশ্ন লোড করুন" : "");
  if (moreObserver) moreObserver.disconnect();
  if ("IntersectionObserver" in window && $("more").style.display !== "none") {
    moreObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) moreStudy();
    }, {rootMargin:"240px"});
    moreObserver.observe($("more"));
  }
}
async function moreStudy() {
  if (moreInFlight) return;
  moreInFlight = true;
  const found = filteredStudy();
  if (shown < found.length) { shown += PAGE_SIZE; study(); moreInFlight = false; return; }
  if (loadedChunks.length < M.categories[selectedCat].chunks.length && await loadNextChunk()) { shown += PAGE_SIZE; study(); }
  moreInFlight = false;
}
function wrongsFor(category) {
  return Object.entries(P.a).filter(([, state]) => state && !state.ok && state.category === category);
}
async function questionAtPath(id, path) {
  if (!path) return null;
  const category = pathCategory(path), list = await getChunk(path, category);
  return list.find(x => x.id === id) || null;
}
async function renderWrong() {
  wrongCat = wrongCat || CATS[0];
  categoryTabs($("wc"), wrongCat, c => { wrongCat = c; wrongShown = PAGE_SIZE; renderWrong(); });
  const query = norm(wrongTerm);
  const allEntries = wrongsFor(wrongCat);
  const result = [];
  for (const [id, state] of allEntries) {
    const question = await questionAtPath(id, state.path);
    if (question && (!query || norm([question.q, ...(question.o || []), question.e, question.c].join(" ")).includes(query))) result.push({question, path:state.path});
  }
  const visible = result.slice(0, wrongShown);
  window.wrongQuestions = visible.map(x => x.question);
  $("wcn").textContent = `${bn(result.length)}টি মিলে গেছে · ${esc(wrongCat)}`;
  $("wl").innerHTML = visible.length ? visible.map((x, i) => questionCard(x.question, i, x.path)).join("") : `<p class="mu">${allEntries.length ? "প্রশ্নগুলো অফলাইনে নেই; ইন্টারনেট সংযোগ দিয়ে আবার চেষ্টা করুন।" : "এই ক্যাটাগরিতে কোনো ভুল প্রশ্ন নেই 🎉"}</p>`;
  attachQuestionEvents($("wl"));
  $("wmore").style.display = wrongShown < result.length ? "block" : "none";
}
async function resume() {
  if (!P.last) { go("study"); return; }
  const last = P.last;
  await selectCategory(last.category);
  const paths = M.categories[last.category].chunks;
  const targetIndex = Math.max(0, paths.indexOf(last.path));
  for (let i = loadedChunks.length; i <= targetIndex; i++) await activateChunk(last.category, i);
  const index = Q.findIndex(x => x.id === last.id);
  shown = index >= 0 ? Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE : PAGE_SIZE;
  go("study");
  requestAnimationFrame(() => { const item = document.querySelector(`#sl [data-id="${CSS.escape(last.id)}"]`); if (item) { item.scrollIntoView({block:"center"}); item.style.outline = "2px solid var(--pr)"; } });
}
function findDuplicate(question, category) {
  const normalized = norm(question);
  return duplicateIndex.get(category)?.has(normalized) || false;
}
async function ensureCategoryLoaded(category) { return loadAllCategory(category); }
async function addQuestion(category, question) {
  const list = await ensureCategoryLoaded(category);
  if (findDuplicate(question.q, category)) return false;
  let paths = M.categories[category].chunks;
  let index = paths.length - 1;
  if (index < 0 || (chunkQuestions.get(paths[index]) || []).length >= CHUNK_SIZE) {
    index = paths.length;
    const path = chunkFile(category, index);
    paths.push(path); chunkQuestions.set(path, []);
  }
  const path = paths[index], batch = chunkQuestions.get(path) || [];
  question.c = category;
  batch.push(question); chunkQuestions.set(path, batch); idToPath.set(question.id, path);
  duplicateIndex.get(category).add(norm(question.q));
  M.categories[category].count++;
  if (selectedCat === category && !activeQuestionIds.has(question.id)) { Q.push(question); activeQuestionIds.add(question.id); }
  markDirty(path);
  return true;
}
async function removeQuestion(question, path) {
  const category = question.c || pathCategory(path);
  const batch = await getChunk(path, category);
  const index = batch.findIndex(x => x.id === question.id);
  if (index < 0) return;
  batch.splice(index, 1); chunkQuestions.set(path, batch);
  const keys = new Set();
  M.categories[category].chunks.forEach(file => (chunkQuestions.get(file) || []).forEach(item => keys.add(norm(item.q))));
  duplicateIndex.set(category, keys);
  M.categories[category].count = Math.max(0, M.categories[category].count - 1);
  Q = Q.filter(x => x.id !== question.id); delete P.a[question.id];
  activeQuestionIds.delete(question.id);
  if (P.last && P.last.id === question.id) P.last = null;
  setProgress(); markDirty(path); render();
}
function sets() {
  $("adm-on").style.display = admin ? "block" : "none";
  $("tk-card").style.display = admin ? "block" : "none";
  $("info").textContent = `মোট প্রশ্ন ${bn(CATS.reduce((sum, c) => sum + categoryCount(c), 0))}টি · পড়া হয়েছে ${bn(Object.keys(P.a).length)}টি। প্রশ্ন ভাগে ভাগে GitHub থেকে আসে, আর অফলাইন কপি IndexedDB-তে থাকে।`;
  $("th").value = localGet(TK) || "auto";
  $("tkst").textContent = token() ? "(সেভ আছে)" : "(নেই)";
  if ($("goalInput")) $("goalInput").value = P.goal || 50;
}

async function login() {
  const value = $("gt").value.trim();
  if (!value) { setStatus("টোকেন দিন"); return; }
  setStatus("⏳ টোকেন যাচাই হচ্ছে…");
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`, {headers:{Authorization:"Bearer " + value, Accept:"application/vnd.github+json"}});
    if (!response.ok) throw new Error("টোকেন ভুল বা রেপোতে অনুমতি নেই (" + response.status + ")");
    const data = await response.json(); localSet(AK, {t:value}); admin = true; $("gt").value = "";
    if (data.permissions && data.permissions.push === false) setStatus("⚠ টোকেন সেভ হয়েছে, কিন্তু লেখার অনুমতি নেই। Contents: Read and write দিন।");
    else setStatus("✔ টোকেন সেভ হয়েছে।");
    if (legacyData) {
      CATS.forEach(category => M.categories[category].chunks.forEach(path => dirtyChunks.add(path)));
      dirtyMeta = true; await dbPut("dirty", {chunks:[...dirtyChunks], meta:true});
    }
    render(); if (dirtyChunks.size || dirtyMeta) await push();
  } catch (error) { setStatus("✘ " + error.message); }
}

function examSetup() {
  $("exam-cat").innerHTML = CATS.map(c => `<option value="${esc(c)}">${ICONS[c]} ${esc(c)} (${bn(categoryCount(c))})</option>`).join("");
  $("exam-cat").value = selectedCat;
  $("examsetup").style.display = "block"; $("examrun").style.display = "none"; $("examresult").style.display = "none";
}
async function startExam() {
  const category = $("exam-cat").value, requested = Number($("exam-size").value) || 20;
  $("examStart").disabled = true; $("examStart").textContent = "প্রশ্ন লোড হচ্ছে…";
  try {
    const paths = [...M.categories[category].chunks];
    for (let i = paths.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [paths[i], paths[j]] = [paths[j], paths[i]]; }
    const pool = [];
    for (const path of paths) {
      pool.push(...await getChunk(path, category));
      if (pool.length >= requested) break;
    }
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const questions = pool.slice(0, Math.min(requested, pool.length));
    if (!questions.length) { alert("এই ক্যাটাগরিতে এখনো প্রশ্ন নেই।"); return; }
    examState = {questions, answers:{}, seconds:questions.length * 60, category};
    $("examsetup").style.display = "none"; $("examrun").style.display = "block"; $("examresult").style.display = "none";
    drawExam(); updateExamTimer(); clearInterval(examTimer); examTimer = setInterval(() => { examState.seconds--; updateExamTimer(); if (examState.seconds <= 0) finishExam(true); }, 1000);
  } catch (error) { setStatus("পরীক্ষা শুরু করা যায়নি: " + error.message); }
  finally { $("examStart").disabled = false; $("examStart").textContent = "পরীক্ষা শুরু করুন"; }
}
function updateExamTimer() {
  if (!examState) return;
  const minutes = Math.floor(examState.seconds / 60), seconds = examState.seconds % 60;
  $("examTimer").textContent = `⏱ ${bn(minutes)}:${String(seconds).padStart(2, "0").replace(/\d/g, c => BN[c])} · ${bn(Object.keys(examState.answers).length)}/${bn(examState.questions.length)} উত্তর`;
}
function drawExam() {
  $("exam-list").innerHTML = examState.questions.map((q, i) => `<div class="card" data-exam="${i}"><div class="q">${bn(i + 1)}. ${esc(q.q)}</div>${q.o.map((option, j) => `<button class="o exam-opt ${examState.answers[i] === j ? "on" : ""}" data-j="${j}">${L[j]}. ${esc(option)}</button>`).join("")}</div>`).join("");
  $("exam-list").querySelectorAll(".exam-opt").forEach(button => button.onclick = () => { const i = Number(button.closest("[data-exam]").dataset.exam); examState.answers[i] = Number(button.dataset.j); drawExam(); updateExamTimer(); });
}
function finishExam(timeout = false) {
  if (!examState) return;
  clearInterval(examTimer); examTimer = null;
  const total = examState.questions.length, answered = Object.keys(examState.answers).length;
  const correct = examState.questions.reduce((n, q, i) => n + (examState.answers[i] === Number(q.a) ? 1 : 0), 0);
  $("examrun").style.display = "none"; $("examresult").style.display = "block";
  $("examresult").innerHTML = `<div class="hero"><div>${timeout ? "⏰ সময় শেষ" : "✅ পরীক্ষা শেষ"}</div><div class="big">${bn(correct)}<small> / ${bn(total)}</small></div><div>সঠিক ${bn(correct)} · ভুল/উত্তরহীন ${bn(total - correct)} · উত্তর দিয়েছেন ${bn(answered)}টি</div><div class="pb"><i style="width:${Math.round(correct / total * 100)}%"></i></div><div>স্কোর ${bn(Math.round(correct / total * 100))}%</div></div><h3>উত্তর পর্যালোচনা</h3>${examState.questions.map((q, i) => { const selected = examState.answers[i], correctAnswer = selected === Number(q.a); return `<div class="card"><div class="q">${bn(i + 1)}. ${esc(q.q)}</div><div class="ex">${correctAnswer ? "✔ সঠিক" : `✘ সঠিক উত্তর: ${L[q.a]}. ${esc(q.o[q.a])}`}${q.e ? " · " + esc(q.e) : ""}</div></div>`; }).join("")}<button class="btn p" id="examAgain">আবার পরীক্ষা দিন</button>`;
  $("examAgain").onclick = () => { examState = null; examSetup(); };
}

async function exportAll() {
  setStatus("⏳ ব্যাকআপের জন্য সব প্রশ্ন লোড হচ্ছে…");
  try {
    const all = [];
    for (const category of CATS) {
      for (const path of M.categories[category].chunks) all.push(...await getChunk(path, category));
    }
    const file = new Blob([JSON.stringify({v:3, questions:all}, null, 1)], {type:"application/json"});
    const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(file); anchor.download = "mcq-backup.json"; anchor.click(); URL.revokeObjectURL(anchor.href);
    setStatus(`✔ ${bn(all.length)}টি প্রশ্নের ব্যাকআপ ডাউনলোড হয়েছে।`);
  } catch (error) { setStatus("ব্যাকআপ তৈরি হয়নি: " + error.message); }
}
async function importFile(file) {
  if (!file || !admin) return;
  try {
    const parsed = JSON.parse(await file.text()), rows = Array.isArray(parsed) ? parsed : parsed.questions;
    if (!Array.isArray(rows)) throw new Error("ফাইলের ফরম্যাট সঠিক নয়");
    let added = 0, duplicate = 0, invalid = 0;
    for (const item of rows) {
      if (!item || !item.q || !Array.isArray(item.o) || item.o.length !== 4 || !(Number(item.a) >= 0 && Number(item.a) < 4) || !CATS.includes(item.c)) { invalid++; continue; }
      if (await addQuestion(item.c, {id:"i" + Date.now() + Math.random().toString(36).slice(2, 8), c:item.c, q:item.q, o:item.o, a:Number(item.a), e:item.e || ""})) added++; else duplicate++;
    }
    $("m3").textContent = `✔ ${bn(added)}টি যোগ, ${bn(duplicate)}টি ডুপ্লিকেট বাদ, ${bn(invalid)}টি ফরম্যাট ভুল।`;
    render();
  } catch (error) { $("m3").textContent = "ফাইলটি পড়া যায়নি: " + error.message; }
}

$("ss").oninput = event => {
  term = event.target.value; clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    if (norm(term)) await loadAllCategory(selectedCat);
    shown = PAGE_SIZE; study();
  }, 250);
};
$("ws").oninput = event => { wrongTerm = event.target.value; wrongShown = PAGE_SIZE; renderWrong(); };
$("sres").onclick = resume;
$("wrongShortcut").onclick = () => go("wrong");
$("wrongBack").onclick = () => go("study");
$("more").onclick = moreStudy;
$("wmore").onclick = () => { wrongShown += PAGE_SIZE; renderWrong(); };
$("save").onclick = async () => {
  if (!admin) return;
  const question = $("fq").value.trim(), options = [0,1,2,3].map(i => $("o" + i).value.trim()), message = $("m1");
  if (!question || options.some(x => !x)) { message.textContent = "প্রশ্ন ও চারটি অপশনই দিন।"; return; }
  if (new Set(options.map(norm)).size < 4) { message.textContent = "অপশনগুলো আলাদা হতে হবে।"; return; }
  const category = $("fc").value;
  if (!(await addQuestion(category, {id:"u" + Date.now() + Math.random().toString(36).slice(2, 6), c:category, q:question, o:options, a:Number($("fa").value), e:$("fe").value.trim()}))) { message.textContent = "এই ক্যাটাগরিতে একই প্রশ্ন আগে থেকেই আছে।"; return; }
  ["fq","o0","o1","o2","o3","fe"].forEach(id => $(id).value = ""); $("dup").style.display = "none";
  message.textContent = "✔ প্রশ্ন যোগ হয়েছে; শুধু সংশ্লিষ্ট ১,০০০-প্রশ্নের ফাইলটি আপলোড হচ্ছে।"; render();
};
$("fq").oninput = () => {
  clearTimeout(searchTimer); const value = $("fq").value.trim();
  searchTimer = setTimeout(async () => {
    if (!value) { $("dup").style.display = "none"; return; }
    const category = $("fc").value;
    try { await ensureCategoryLoaded(category); const dup = findDuplicate(value, category); $("dup").style.display = dup ? "block" : "none"; if (dup) $("dup").textContent = "⚠ এই প্রশ্নটি এই ক্যাটাগরিতে আগেই আছে।"; }
    catch (_) { $("dup").style.display = "none"; }
  }, 300);
};
$("bsave").onclick = async () => {
  if (!admin) return;
  const category = $("bc").value; let added = 0, duplicate = 0, invalid = 0;
  for (const line of $("bt").value.split("\n").map(x => x.trim()).filter(Boolean)) {
    const parts = line.split("|").map(x => x.trim()), answer = parseInt(d2e(parts[5]), 10) - 1;
    if (parts.length < 6 || parts.slice(0,5).some(x => !x) || !(answer >= 0 && answer < 4)) { invalid++; continue; }
    if (await addQuestion(category, {id:"b" + Date.now() + Math.random().toString(36).slice(2,8), c:category, q:parts[0], o:parts.slice(1,5), a:answer, e:parts[6] || ""})) added++; else duplicate++;
  }
  $("m2").textContent = `✔ ${bn(added)}টি যোগ, ${bn(duplicate)}টি ডুপ্লিকেট বাদ, ${bn(invalid)}টি ফরম্যাট ভুল।`;
  if (added) $("bt").value = ""; render();
};
$("th").onchange = event => { localSet(TK, event.target.value); applyTheme(event.target.value); };
$("goalSave").onclick = () => { P.goal = Math.max(1, Math.min(500, Number($("goalInput").value) || 50)); setProgress(); home(); $("m3").textContent = `দৈনিক লক্ষ্য ${bn(P.goal)}টি সেট হয়েছে।`; };
$("glogout").onclick = () => { if (confirm("অ্যাডমিন মোড বন্ধ করবেন?")) { localRemove(UK); admin = false; view = "home"; render(); } };
$("gnow").onclick = push;
$("gtsave").onclick = login;
$("gtshow").onclick = () => { const input = $("gt"); input.type = input.type === "password" ? "text" : "password"; };
$("gtdel").onclick = () => { localRemove(AK); setStatus("টোকেন মুছে ফেলা হয়েছে।"); sets(); };
$("gpull").onclick = async () => {
  if (!confirm("GitHub-এর ডেটা দিয়ে এই ডিভাইসের ক্যাশে রিফ্রেশ হবে। চালিয়ে যাবেন?")) return;
  try { M = normalizeManifest(await rawJson(INDEX_FILE)); await dbPut("manifest", M); await dbClearChunks(); chunkQuestions.clear(); idToPath.clear(); activeQuestionIds.clear(); duplicateIndex.forEach(keys => keys.clear()); Q = []; loadedChunks = []; dirtyChunks.clear(); dirtyMeta = false; legacyData = false; await dbPut("dirty", null); await dbPut("migrationPending", false); render(); setStatus("✔ GitHub থেকে সূচি রিফ্রেশ হয়েছে।"); }
  catch (error) { setStatus("লোড করা যায়নি: " + error.message); }
};
$("exp").onclick = exportAll;
$("impb").onclick = () => $("impf").click();
$("impf").onchange = event => { importFile(event.target.files[0]); event.target.value = ""; };
$("rr").onclick = () => { if (confirm("পড়ার ট্র্যাক রিসেট করবেন? প্রশ্ন মুছবে না।")) { P = {a:{}, d:{}, last:null, goal:P.goal || 50}; setProgress(); render(); } };
$("examStart").onclick = startExam;
$("examSubmit").onclick = () => { if (confirm("পরীক্ষা শেষ করে ফলাফল দেখবেন?")) finishExam(false); };

async function init() {
  ["fc", "bc"].forEach(id => { $(id).innerHTML = CATS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(""); });
  db = await dbOpen();
  P = (await dbGet("progress")) || localGet(PK) || {a:{}, d:{}, last:null, goal:50};
  if (!P.a) P = {a:{}, d:{}, last:null, goal:50};
  if (!P.d) P.d = {};
  if (!P.goal) P.goal = 50;
  await loadData();
  applyTheme(localGet(TK) || "auto");
  render();
  if (admin && token() && (dirtyChunks.size || dirtyMeta)) push();
}
init();
