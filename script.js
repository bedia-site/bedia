/* =====================================================
   BÉDIA - Lógica da aplicação · COMPLETO (ligado ao Supabase)
   Este ficheiro já traz a ligação ao Supabase dentro dele.
   Só precisas do index.html + style.css + este script.js.
   ===================================================== */
'use strict';

/* =====================================================
   LIGAÇÃO AO SUPABASE (embutida)
   ===================================================== */
(function () {
'use strict';

const SUPABASE_URL = 'https://xnrmfpuhktabeqlcraaw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u2dbIcCN2FqBLlvoutZslw_wEVlYGn8';
const BUCKET = 'art';
const LIB_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

let sb = null;

// Carrega a biblioteca do Supabase sozinha (se o index.html não a tiver)
const ready = new Promise((resolve, reject) => {
    const make = () => {
        try { sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); resolve(); }
        catch (e) { reject(e); }
    };
    if (window.supabase && window.supabase.createClient) return make();
    const s = document.createElement('script');
    s.src = LIB_URL;
    s.onload = make;
    s.onerror = () => reject(new Error('Não foi possível carregar o supabase-js'));
    document.head.appendChild(s);
});
ready.catch((e) => console.error(e));

const must = (r) => { if (r.error) throw r.error; return r.data; };
const ts = (v) => (v ? new Date(v).getTime() : null);
const idToKey = new Map();

const pathOf = (url) => {
    const m = String(url || '').split('/object/public/' + BUCKET + '/')[1];
    return m ? decodeURIComponent(m.split('?')[0]) : null;
};

async function upload(path, blob) {
    must(await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' }));
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

function makeThumb(src, side = 500) {
    return new Promise((ok, no) => {
        const img = new Image();
        img.onload = () => {
            const s = Math.min(1, side / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * s));
            c.height = Math.max(1, Math.round(img.height * s));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            c.toBlob(b => b ? ok(b) : no(new Error('miniatura')), 'image/jpeg', 0.8);
        };
        img.onerror = () => no(new Error('miniatura'));
        img.src = src;
    });
}
const toBlob = async (dataUrl) => (await fetch(dataUrl)).blob();

const mapPost = (r) => ({
    id: r.id, authorKey: idToKey.get(r.author_id) || '', title: r.title, category: r.category,
    description: r.description || '', tags: r.tags || [], nsfw: !!r.nsfw,
    images: r.images || [], thumb: r.thumb || null,
    createdAt: ts(r.created_at), editedAt: ts(r.edited_at), likes: [], comments: []
});
const mapNotif = (r) => ({
    id: r.id, toKey: idToKey.get(r.to_id) || '', type: r.type, fromKey: idToKey.get(r.from_id) || '',
    postId: r.post_id, createdAt: ts(r.created_at), read: !!r.read
});

const B = {
    me: null,

    async load() {
        const { data: { session } } = await sb.auth.getSession();
        const uid = session ? session.user.id : null;
        const [pr, po, li, fo, co] = await Promise.all([
            sb.from('profiles').select('*'),
            sb.from('posts').select('*').order('created_at', { ascending: false }).limit(1000),
            sb.from('likes').select('*'),
            sb.from('follows').select('*'),
            sb.from('comments').select('*').order('created_at').limit(5000)
        ]);
        const profiles = must(pr), posts = must(po), likes = must(li), follows = must(fo), comments = must(co);

        const db = { users: {}, posts: [], notifications: [], reports: [], session: null };
        idToKey.clear();
        profiles.forEach(p => {
            const key = p.handle.toLowerCase();
            idToKey.set(p.id, key);
            db.users[key] = {
                id: p.id, key, handle: p.handle, email: '', color: p.color, avatarUrl: p.avatar_url || null,
                bio: p.bio || '', link: p.link || '', createdAt: ts(p.created_at), following: [], bookmarks: []
            };
        });
        const byId = {};
        posts.forEach(r => { const p = mapPost(r); db.posts.push(p); byId[p.id] = p; });
        likes.forEach(l => { if (byId[l.post_id]) byId[l.post_id].likes.push(idToKey.get(l.user_id)); });
        comments.forEach(c => {
            if (byId[c.post_id]) byId[c.post_id].comments.push({
                id: c.id, authorKey: idToKey.get(c.author_id) || '', text: c.text, createdAt: ts(c.created_at), replyTo: c.reply_to
            });
        });
        follows.forEach(f => {
            const u = db.users[idToKey.get(f.follower_id)];
            if (u) u.following.push(idToKey.get(f.followed_id));
        });

        this.me = null;
        if (uid && idToKey.has(uid)) {
            const key = idToKey.get(uid);
            db.session = key;
            db.users[key].email = session.user.email || '';
            this.me = { id: uid, key };
            must(await sb.from('bookmarks').select('post_id').eq('user_id', uid)).forEach(b => db.users[key].bookmarks.push(b.post_id));
            db.notifications = await this.notifs();
        }
        return db;
    },

    async notifs() {
        if (!this.me) return [];
        const rows = must(await sb.from('notifications').select('*').eq('to_id', this.me.id).order('created_at', { ascending: false }).limit(100));
        return rows.map(mapNotif);
    },

    async signUp(handle, email, password, color) {
        const free = await sb.rpc('handle_free', { h: handle });
        if (free.error) return { error: 'Sem ligação ao servidor.' };
        if (!free.data) return { error: 'Esse nome de utilizador já está em uso.' };
        const { data, error } = await sb.auth.signUp({
            email, password,
            options: { emailRedirectTo: location.origin + location.pathname, data: { handle, color } }
        });
        if (error) return { error: /registered|already/i.test(error.message) ? 'Esse e-mail já tem uma conta.' : 'Não foi possível criar a conta.' };
        return { needsConfirm: !data.session };
    },

    async signIn(userOrEmail, password) {
        let email = userOrEmail.toLowerCase();
        if (!email.includes('@')) {
            const r = await sb.rpc('email_for_handle', { h: email });
            email = (!r.error && r.data) || '';
        }
        if (!email || !password) return { error: 'Utilizador ou senha incorretos.' };
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error && /not confirmed/i.test(error.message)) return { needsVerify: true, email };
        return error ? { error: 'Utilizador ou senha incorretos.' } : {};
    },

    async signOut() { await sb.auth.signOut(); this.me = null; },

    // Código de 6 dígitos enviado por e-mail
    async verifyCode(email, token) {
        const { error } = await sb.auth.verifyOtp({ email, token, type: 'signup' });
        return error ? { error: 'Código inválido ou expirado.' } : {};
    },
    async resendCode(email) {
        const { error } = await sb.auth.resend({ type: 'signup', email });
        return error ? { error: 'Espera um minuto antes de pedir outro código.' } : {};
    },

    async saveProfile({ bio, link, color, avatarDataUrl }) {
        const patch = { bio, link, color };
        let avatarUrl;
        if (avatarDataUrl === null) patch.avatar_url = null;
        else if (typeof avatarDataUrl === 'string') {
            avatarUrl = await upload(`${this.me.id}/avatar-${Date.now()}.jpg`, await toBlob(avatarDataUrl));
            patch.avatar_url = avatarUrl;
        }
        must(await sb.from('profiles').update(patch).eq('id', this.me.id));
        return avatarDataUrl === null ? null : avatarUrl;
    },

    async deleteAccount() {
        const folder = this.me.id;
        const { data } = await sb.storage.from(BUCKET).list(folder, { limit: 1000 });
        const paths = [];
        for (const f of data || []) {
            if (f.id) paths.push(`${folder}/${f.name}`);
            else {
                const sub = await sb.storage.from(BUCKET).list(`${folder}/${f.name}`, { limit: 1000 });
                (sub.data || []).forEach(s => paths.push(`${folder}/${f.name}/${s.name}`));
            }
        }
        if (paths.length) await sb.storage.from(BUCKET).remove(paths);
        must(await sb.rpc('delete_me'));
        await sb.auth.signOut();
        this.me = null;
    },

    async publish(meta, pages) {
        const id = crypto.randomUUID(), base = `${this.me.id}/${id}`, done = [];
        try {
            const images = [];
            for (let i = 0; i < pages.length; i++) {
                const url = await upload(`${base}/${i}.jpg`, await toBlob(pages[i]));
                done.push(pathOf(url)); images.push(url);
            }
            const thumb = await upload(`${base}/thumb-${Date.now()}.jpg`, await makeThumb(pages[0]));
            done.push(pathOf(thumb));
            const row = must(await sb.from('posts').insert({ id, author_id: this.me.id, ...meta, images, thumb }).select().single());
            return mapPost(row);
        } catch (e) {
            if (done.length) await sb.storage.from(BUCKET).remove(done);
            throw e;
        }
    },

    async updatePost(post, meta, newOrder) {
        const patch = { ...meta, edited_at: new Date().toISOString() };
        if (newOrder && newOrder.length === post.images.length) {
            patch.images = newOrder;
            if (newOrder[0] !== post.images[0]) {
                const blob = await (await fetch(newOrder[0])).blob();
                const obj = URL.createObjectURL(blob);
                try {
                    const dir = pathOf(newOrder[0]).split('/').slice(0, 2).join('/');
                    patch.thumb = await upload(`${dir}/thumb-${Date.now()}.jpg`, await makeThumb(obj));
                } finally { URL.revokeObjectURL(obj); }
            }
        }
        must(await sb.from('posts').update(patch).eq('id', post.id));
        return patch;
    },

    async deletePost(post) {
        const paths = [...post.images, post.thumb].map(pathOf).filter(Boolean);
        must(await sb.from('posts').delete().eq('id', post.id));
        if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    },

    async setLike(postId, on) {
        const q = sb.from('likes');
        must(on ? await q.insert({ post_id: postId, user_id: this.me.id })
                : await q.delete().eq('post_id', postId).eq('user_id', this.me.id));
    },
    async setBookmark(postId, on) {
        const q = sb.from('bookmarks');
        must(on ? await q.insert({ post_id: postId, user_id: this.me.id })
                : await q.delete().eq('post_id', postId).eq('user_id', this.me.id));
    },
    async setFollow(userId, on) {
        const q = sb.from('follows');
        must(on ? await q.insert({ follower_id: this.me.id, followed_id: userId })
                : await q.delete().eq('follower_id', this.me.id).eq('followed_id', userId));
    },
    async addComment(postId, text, replyTo) {
        const row = must(await sb.from('comments').insert({ post_id: postId, author_id: this.me.id, text, reply_to: replyTo || null }).select().single());
        return row.id;
    },
    async deleteComment(id) { must(await sb.from('comments').delete().eq('id', id)); },
    async report(postId, reason, details) { must(await sb.from('reports').insert({ post_id: postId, by_id: this.me.id, reason, details })); },
    async markRead(ids) { if (ids.length) must(await sb.from('notifications').update({ read: true }).in('id', ids)); }
};

// Cada função espera pela biblioteca antes de correr
Object.keys(B).forEach((k) => {
    if (typeof B[k] !== 'function') return;
    const fn = B[k];
    B[k] = async function (...args) { await ready; return fn.apply(B, args); };
});

window.B = B;
})();

/* ---------- CONFIGURAÇÃO ---------- */
const PAGE_SIZE = 12;
const MAX_IMAGES = 80;
const MAX_FILE_MB = 20;
const MAX_PDF_MB = 50;
const PDF_MAX_SIDE = 1400;
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const SUPPORT_EMAIL = 'suporte@bedia.com'; // <<< troca pelo teu e-mail real
const PRESET_COLORS = ['#a855f7', '#06b6d4', '#ec4899', '#10b981', '#f59e0b'];
const CATEGORY_LABEL = {
    'Mangá / Quadrinhos': '📖 Mangá',
    'Personagens Originais': '🎭 Personagens (OC)',
    'Ilustração 2D': '🎨 Ilustração',
    'Esboços': '✏️ Esboço'
};
const PLACEHOLDER_IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#131622"/><text x="200" y="255" font-size="40" text-anchor="middle" fill="#475569">🖼️</text></svg>'
);

/* ---------- MASCOTE ---------- */
const MASCOT = {
    up:        'mascote1.png',
    right:     'mascote2.png',
    happy:     'mascote3.png',
    worried:   'mascote4.png',
    surprised: 'mascote5.png',
    sleepy:    'mascote6.png',
    cover:     'mascote7.png'
};
Object.values(MASCOT).forEach(src => { const i = new Image(); i.src = src; });

/* ---------- UTILITÁRIOS ---------- */
const $ = (id) => document.getElementById(id);
const keyOf = (h) => String(h || '').replace(/^@/, '').trim().toLowerCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const prefersReducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignora */ } }
};

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 45) return 'agora';
    const m = Math.floor(s / 60);
    if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `há ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 30) return `há ${d} d`;
    return new Date(ts).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function setFlex(el, on) {
    el.classList.toggle('hidden', !on);
    el.classList.toggle('flex', on);
}

function showError(el, msg) {
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
}

function playAnim(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

/* ---------- DADOS (agora vêm do Supabase, via backend.js) ---------- */
let db = { users: {}, posts: [], notifications: [], reports: [], session: null };
const images = new Map();           // mantido vazio, só por compatibilidade
function persist() {}               // cada ação grava no servidor
function notify() {}                // as notificações são criadas pelo servidor
const imgSrc = (url) => url || PLACEHOLDER_IMG;
const me = () => (db.session && db.users[db.session]) || null;
const getUser = (key) => db.users[key] || null;
const getPost = (id) => db.posts.find(p => p.id === id) || null;
const failed = (e) => { console.error(e); toast('Sem ligação ao servidor. Tenta de novo.', 'error'); };

// Se uma ação falhar, volta a ler tudo do servidor para o ecrã não mentir
async function resync() {
    try { db = await B.load(); } catch (e) { failed(e); }
    renderAll();
    if (selectedPostId) renderDetail(true);
}

// Capas: aparecem quando carregam; se falharem, mostram o espaço reservado
document.addEventListener('load', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('pin-img')) {
        t.classList.add('loaded');
        const host = t.closest('[data-id]');
        if (host) seenImgs.add(host.dataset.id);
    }
}, true);
document.addEventListener('error', (e) => {
    const t = e.target;
    if (t.tagName === 'IMG' && t.classList.contains('pin-img') && !t.dataset.f) {
        t.dataset.f = '1'; t.src = PLACEHOLDER_IMG; t.classList.add('loaded');
    }
}, true);

/* ---------- IMAGENS: compressão ---------- */
function compressImage(file, maxSide = 1600, quality = 0.85, square = false) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            let sx = 0, sy = 0, sw = img.width, sh = img.height;
            if (square) {
                const s = Math.min(sw, sh);
                sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s;
            }
            const scale = Math.min(1, maxSide / Math.max(sw, sh));
            const w = Math.max(1, Math.round(sw * scale));
            const h = Math.max(1, Math.round(sh * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx2 = canvas.getContext('2d');
            ctx2.fillStyle = '#ffffff';
            ctx2.fillRect(0, 0, w, h);
            ctx2.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagem inválida')); };
        img.src = url;
    });
}

/* ---------- PDF: converte cada página em imagem ---------- */
let pdfLibPromise = null;
function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfLibPromise) {
        pdfLibPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = PDFJS_URL;
            s.onload = () => {
                try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; resolve(window.pdfjsLib); }
                catch (e) { pdfLibPromise = null; reject(e); }
            };
            s.onerror = () => { pdfLibPromise = null; reject(new Error('Não foi possível carregar o leitor de PDF.')); };
            document.head.appendChild(s);
        });
    }
    return pdfLibPromise;
}

async function pdfToImages(file, maxPages, onProgress) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const total = Math.min(pdf.numPages, maxPages);
    const pages = [];
    for (let n = 1; n <= total; n++) {
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, PDF_MAX_SIDE / Math.max(base.width, base.height));
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vp.width));
        canvas.height = Math.max(1, Math.round(vp.height));
        const ctx2 = canvas.getContext('2d');
        ctx2.fillStyle = '#ffffff';
        ctx2.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx2, viewport: vp }).promise;
        pages.push(canvas.toDataURL('image/jpeg', 0.82));
        page.cleanup();
        if (onProgress) onProgress(n, total);
    }
    const cut = pdf.numPages > maxPages;
    pdf.destroy();
    return { pages, cut };
}

/* ---------- ESTADO DA INTERFACE ---------- */
let view = { name: 'home', arg: null };
let activeCategory = 'Todos';
let searchQuery = '';
let visibleCount = PAGE_SIZE;
let selectedPostId = null;
let pageIndex = 0;
let authMode = 'login';            // 'login' | 'signup' | 'verify'
let pendingEmail = '';             // e-mail à espera do código
let afterAuth = null;
let selectedColor = PRESET_COLORS[0];
let profileColor = PRESET_COLORS[0];
let profileAvatarData = undefined; // undefined = sem alteração, null = remover, string = nova foto
let editingPostId = null;
let draft = [];
let editOrder = [];                // ao editar: URLs das páginas, pela ordem (a primeira é a capa)
let converting = false;
let reportPostId = null;
let lastRouteHash = '#/';
let firstRender = true;
const revealed = new Set();
const seenImgs = new Set();
const modalStack = [];
let replyingTo = null;
let readerMode = LS.get('bedia:readerMode', 'page') === 'scroll' ? 'scroll' : 'page';
let readerFull = false;
let readerHome = null;
let readerRealFs = false;

/* ---------- MODAIS ---------- */
let lastFocus = null;
function openModal(id) {
    const el = $(id);
    if (!modalStack.length) lastFocus = document.activeElement;   // para devolver o foco ao fechar
    el.classList.remove('hidden');
    if (!modalStack.includes(id)) modalStack.push(id);
    document.body.style.overflow = 'hidden';
}

function closeModal(id) {
    const el = $(id);
    if (!el || el.classList.contains('hidden')) return;
    if (id === 'detailModal') return closeDetail();
    if (id === 'confirmModal') return resolveConfirm(false);
    hideModal(id);
}

function hideModal(id) {
    if (id === 'detailModal' && readerFull) exitReaderFull();
    $(id).classList.add('hidden');
    const i = modalStack.indexOf(id);
    if (i >= 0) modalStack.splice(i, 1);
    if (!modalStack.length) {
        document.body.style.overflow = '';
        if (lastFocus && lastFocus.focus && document.contains(lastFocus)) { try { lastFocus.focus(); } catch (e) {} }
        lastFocus = null;
    }
}

let confirmResolve = null;
function askConfirm(title, text, okLabel = 'Confirmar', opts = {}) {
    return new Promise(resolve => {
        confirmResolve = resolve;
        const withMascot = !!(opts.pose && MASCOT[opts.pose]);
        const wrap = $('confirmMascotWrap');
        wrap.classList.toggle('hidden', !withMascot);
        wrap.classList.toggle('flex', withMascot);
        $('confirmTitle').classList.toggle('hidden', withMascot);
        if (withMascot) {
            $('confirmMascot').src = MASCOT[opts.pose];
            $('confirmBubble').textContent = title;
            playAnim($('confirmMascot'), 'mascot-pop');
        } else {
            $('confirmTitle').textContent = title;
        }
        $('confirmText').textContent = text;
        $('confirmOk').textContent = okLabel;
        $('confirmCancel').textContent = opts.cancelLabel || 'Cancelar';
        openModal('confirmModal');
    });
}
function resolveConfirm(value) {
    if (!confirmResolve) return;
    const r = confirmResolve;
    confirmResolve = null;
    hideModal('confirmModal');
    r(value);
}

/* ---------- A PROCESSAR ---------- */
let procCount = 0;
function startProcessing(text = 'A processar', opts = {}) {
    const overlay = $('processingOverlay');
    const h = { text, shown: false, shownAt: 0, finished: false, timer: null };
    const show = () => {
        if (h.finished || h.shown) return;
        h.shown = true; h.shownAt = Date.now(); procCount++;
        $('processingText').textContent = h.text;
        overlay.classList.remove('hidden');
    };
    if (opts.delay) h.timer = setTimeout(show, opts.delay); else show();
    return {
        update(t) { h.text = t; if (h.shown) $('processingText').textContent = t; },
        async done(minMs = 0, beforeHide) {
            if (h.finished) return;
            h.finished = true;
            clearTimeout(h.timer);
            if (h.shown && !prefersReducedMotion()) {
                const wait = minMs - (Date.now() - h.shownAt);
                if (wait > 0) await sleep(wait);
            }
            if (beforeHide) beforeHide();
            if (h.shown) {
                procCount = Math.max(0, procCount - 1);
                if (!procCount) overlay.classList.add('hidden');
            }
        }
    };
}

/* ---------- TOAST ---------- */
let toastTimer = null;
function toast(msg, type = 'ok') {
    const t = $('toast');
    $('toastMsg').textContent = msg;
    $('toastIcon').className = type === 'error'
        ? 'fa-solid fa-triangle-exclamation text-neonPink text-base'
        : 'fa-solid fa-circle-check text-neonCyan text-base';
    t.classList.remove('translate-y-24', 'opacity-0');
    t.classList.add('translate-y-0', 'opacity-100');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        t.classList.remove('translate-y-0', 'opacity-100');
        t.classList.add('translate-y-24', 'opacity-0');
    }, 3200);
}

/* ---------- COMPONENTES VISUAIS ---------- */
function avatarHTML(u, size = 'w-9 h-9', text = 'text-xs') {
    if (!u) {
        return `<div class="${size} rounded-full bg-slate-700 flex items-center justify-center ${text} font-bold text-white shrink-0">?</div>`;
    }
    if (u.avatarUrl) {
        return `<img src="${esc(u.avatarUrl)}" alt="" class="${size} rounded-full object-cover shrink-0 border border-white/10">`;
    }
    return `<div class="${size} rounded-full flex items-center justify-center ${text} font-bold text-white shrink-0" style="background:${esc(u.color)}">${esc(u.handle.charAt(0).toUpperCase())}</div>`;
}

function buildColorPicker(container, getColor, setColor) {
    container.innerHTML = PRESET_COLORS.map(c =>
        `<button type="button" data-color="${c}" class="w-7 h-7 rounded-full border-2 transition-transform" style="background:${c}" aria-label="Cor ${c}"></button>`
    ).join('');
    const paint = () => container.querySelectorAll('button').forEach(b => {
        const on = b.dataset.color === getColor();
        b.style.borderColor = on ? '#fff' : 'rgba(255,255,255,.2)';
        b.style.transform = on ? 'scale(1.2)' : 'scale(1)';
    });
    container.onclick = (e) => {
        const b = e.target.closest('button[data-color]');
        if (!b) return;
        setColor(b.dataset.color);
        paint();
    };
    paint();
}

/* ---------- MASCOTE: fala e poses ---------- */
function mascotSay(pose, text, anim = 'pop') {
    const img = $('authMascot');
    const bubbleText = $('authBubbleText');
    if (!img || !bubbleText) return;
    if (MASCOT[pose] && img.dataset.pose !== pose) {
        img.src = MASCOT[pose];
        img.dataset.pose = pose;
    }
    if (text !== undefined) {
        bubbleText.textContent = text;
        playAnim($('authBubble'), 'bubble-pop');
    }
    playAnim(img, 'mascot-' + anim);
}

const AUTH_HINTS = {
    authUsername: () => authMode === 'signup'
        ? ['right', 'Escolhe um nome único para o teu perfil!']
        : ['right', 'Quem és tu, artista?'],
    authEmail: () => ['right', 'Prometo não enviar spam!'],
    authPassword: () => ['cover', 'Não estou a ver nada, juro!']
};
let skipNextHint = false;

/* ---------- AUTENTICAÇÃO ---------- */
function openAuth(mode = 'login', warning = '', then = null) {
    afterAuth = then;
    setAuthMode(mode);
    $('authLockWarning').classList.toggle('hidden', !warning);
    $('authLockWarning').classList.toggle('flex', !!warning);
    if (warning) {
        $('authLockText').textContent = warning;
        mascotSay('surprised', 'Ei! Precisas de entrar primeiro.', 'shake');
    }
    showError($('authError'), '');
    openModal('authModal');
    setTimeout(() => { skipNextHint = !!warning; $('authUsername').focus(); }, 50);
}

function setAuthMode(mode) {
    authMode = mode;
    const verify = mode === 'verify';
    $('authUserGroup').classList.toggle('hidden', verify);
    $('authPassGroup').classList.toggle('hidden', verify);
    $('authCodeGroup').classList.toggle('hidden', !verify);
    if (verify) {
        $('authEmailGroup').classList.remove('open');
        $('authColorGroup').classList.remove('open');
        $('authModalTitle').textContent = 'Verifica o teu e-mail';
        $('authModalSubtitle').textContent = 'Escreve o código que te enviámos.';
        $('authCodeEmail').textContent = pendingEmail;
        $('authSubmitBtn').textContent = 'Confirmar código';
        $('toggleAuthModeBtn').textContent = 'Voltar para entrar';
        mascotSay('up', 'Vê o teu e-mail! Mandei-te um código.', 'hop');
        setTimeout(() => { const c = $('authCode'); if (c) c.focus(); }, 60);
        return;
    }
    const signup = mode === 'signup';
    $('authModalTitle').textContent = signup ? 'Criar Conta no Bédia' : 'Entrar no Bédia';
    $('authModalSubtitle').textContent = signup
        ? 'Crie seu perfil para publicar seus mangás e artes!'
        : 'Bem-vindo de volta, artista!';
    $('authUsernameLabel').textContent = signup ? 'Nome de utilizador *' : 'Utilizador ou e-mail *';
    $('authUsername').placeholder = signup ? 'Ex: OtakuArtist' : 'Seu utilizador ou e-mail';
    $('authEmailGroup').classList.toggle('open', signup);
    $('authColorGroup').classList.toggle('open', signup);
    $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
    $('authSubmitBtn').textContent = signup ? 'Criar Minha Conta' : 'Entrar';
    $('toggleAuthModeBtn').textContent = signup ? 'Já tem uma conta? Fazer Login' : 'Não tem conta? Criar Conta';
    mascotSay('up', signup
        ? 'Novo por aqui? Vamos criar a tua conta!'
        : 'Bem-vindo de volta, artista! Entra aí.', 'hop');
}

function switchAuthMode(mode) {
    const side = $('authFormSide');
    if (!side || prefersReducedMotion()) return setAuthMode(mode);
    side.classList.remove('flip-in');
    side.classList.add('flip-out');
    setTimeout(() => {
        setAuthMode(mode);
        showError($('authError'), '');
        side.classList.remove('flip-out');
        side.classList.add('flip-in');
        setTimeout(() => side.classList.remove('flip-in'), 320);
    }, 220);
}

function requireLogin(message, then) {
    if (me()) return true;
    openAuth('signup', message || 'Você precisa estar logado para fazer isto.', then);
    return false;
}

async function submitAuth(e) {
    e.preventDefault();
    const btn = $('authSubmitBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    try { await runAuth(); } finally { btn.disabled = false; }
}

async function runAuth() {
    const errEl = $('authError');
    showError(errEl, '');
    const fail = (msg) => { showError(errEl, msg); mascotSay('worried', 'Ops! Confere os dados.', 'shake'); };
    const rawUser = $('authUsername').value.trim();
    const password = $('authPassword').value;
    const signup = authMode === 'signup';
    let proc = null;

    const verify = authMode === 'verify';

    try {
        if (verify) {
            const code = $('authCode').value.replace(/\s/g, '');
            if (!/^\d{6,8}$/.test(code)) return fail('Escreve o código que recebeste por e-mail.');
            proc = startProcessing('A verificar o código');
            const r = await B.verifyCode(pendingEmail, code);
            if (r.error) { await proc.done(350); return fail(r.error); }
        } else if (signup) {
            const handle = rawUser.replace(/^@/, '');
            const email = $('authEmail').value.trim().toLowerCase();
            if (!/^[a-zA-Z0-9_.]{3,20}$/.test(handle)) return fail('O utilizador deve ter 3 a 20 caracteres: letras, números, _ ou .');
            if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Escreva um e-mail válido.');
            if (password.length < 6) return fail('A senha deve ter pelo menos 6 caracteres.');
            proc = startProcessing('A criar a tua conta');
            const r = await B.signUp(handle, email, password, selectedColor);
            if (r.error) { await proc.done(350); return fail(r.error); }
            if (r.needsConfirm) {
                await proc.done(500);
                pendingEmail = email;
                $('authCode').value = '';
                setAuthMode('verify');
                return toast('Enviámos um código para o teu e-mail.');
            }
        } else {
            proc = startProcessing('A entrar');
            const r = await B.signIn(rawUser.replace(/^@/, ''), password);
            if (r.needsVerify) {            // conta existe mas o e-mail ainda não foi confirmado
                pendingEmail = r.email;
                await B.resendCode(r.email);
                await proc.done(350);
                $('authCode').value = '';
                setAuthMode('verify');
                return toast('Falta confirmar o e-mail. Enviámos-te um novo código.');
            }
            if (r.error) { await proc.done(350); return fail(r.error); }
        }

        db = await B.load();
        await proc.done(800);
        const welcome = signup || verify;
        toast(welcome ? `Bem-vindo ao Bédia, @${me().handle}!` : `Olá de novo, @${me().handle}!`);
        mascotSay('happy', welcome ? 'Conta criada! Bem-vindo!' : 'Boa! Estás dentro!', 'hop');
        if (!prefersReducedMotion()) await sleep(650);
        $('authForm').reset();
        hideModal('authModal');
        renderAll();
        const cb = afterAuth; afterAuth = null;
        if (cb) cb();
    } catch (e) {
        console.error(e);
        fail('Sem ligação ao servidor. Tenta de novo.');
    } finally {
        if (proc) proc.done(0);
    }
}

async function confirmLogout() {
    closeMenus();
    const ok = await askConfirm(
        'Tens a certeza que queres sair?',
        'Vais precisar de entrar outra vez para publicar, curtir e comentar.',
        'Sim, sair',
        { pose: 'surprised', cancelLabel: 'Ficar' }
    );
    if (!ok) return;
    const proc = startProcessing('A terminar a sessão');
    await proc.done(750, () => logout());
}

function logout() {
    B.signOut();
    db.session = null;
    db.notifications = [];
    closeMenus();
    if (['following', 'saved'].includes(view.name)) location.hash = '#/';
    renderAll();
    if (selectedPostId) renderDetail();
    toast('Você saiu da conta.');
}

/* ---------- AÇÕES SOBRE OBRAS ---------- */
function toggleLike(id) {
    if (!requireLogin('Entre para curtir esta obra.', () => toggleLike(id))) return;
    const p = getPost(id), m = me();
    if (!p) return;
    const i = p.likes.indexOf(m.key);
    if (i >= 0) p.likes.splice(i, 1); else p.likes.push(m.key);
    B.setLike(id, i < 0).catch(e => { failed(e); resync(); });
    renderGrid();
    if (profileIsShown()) renderProfileHeader();
    if (selectedPostId === id) renderDetail(true);
}

function toggleBookmark(id) {
    if (!requireLogin('Entre para salvar obras.', () => toggleBookmark(id))) return;
    const m = me();
    const i = m.bookmarks.indexOf(id);
    if (i >= 0) m.bookmarks.splice(i, 1); else m.bookmarks.push(id);
    toast(i >= 0 ? 'Removido dos salvos.' : 'Salvo nos seus favoritos!');
    B.setBookmark(id, i < 0).catch(e => { failed(e); resync(); });
    renderGrid();
    if (selectedPostId === id) renderDetail(true);
}

function toggleFollow(key) {
    if (!requireLogin('Entre para seguir artistas.', () => toggleFollow(key))) return;
    const m = me(), target = getUser(key);
    if (!target || m.key === key) return;
    const i = m.following.indexOf(key);
    if (i >= 0) m.following.splice(i, 1); else m.following.push(key);
    B.setFollow(target.id, i < 0).catch(e => { failed(e); resync(); });
    renderAll();
    if (selectedPostId) renderDetail(true);
}

async function addComment(text) {
    const p = getPost(selectedPostId), m = me();
    if (!p || !m) return;
    const parent = replyingTo ? p.comments.find(c => c.id === replyingTo) : null;
    try {
        const id = await B.addComment(p.id, text, parent ? parent.id : null);
        p.comments.push({ id, authorKey: m.key, text, createdAt: Date.now(), replyTo: parent ? parent.id : null });
    } catch (e) { return failed(e); }
    replyingTo = null;
    renderDetail(true);
    renderGrid();
    const list = $('commentsList');
    list.scrollTop = list.scrollHeight;
}

async function deleteComment(commentId) {
    const p = getPost(selectedPostId);
    if (!p) return;
    if (!(await askConfirm('Apagar comentário?', 'Esta ação não pode ser desfeita.', 'Apagar'))) return;
    try { await B.deleteComment(commentId); } catch (e) { return failed(e); }
    // apaga também as respostas (o servidor faz o mesmo em cascata)
    const gone = new Set([commentId]);
    let grew = true;
    while (grew) {
        grew = false;
        p.comments.forEach(c => { if (c.replyTo && gone.has(c.replyTo) && !gone.has(c.id)) { gone.add(c.id); grew = true; } });
    }
    p.comments = p.comments.filter(c => !gone.has(c.id));
    renderDetail(true);
    renderGrid();
}

async function deletePost(id) {
    const p = getPost(id);
    if (!p) return;
    if (!(await askConfirm('Queres mesmo apagar esta obra?', 'A obra e os seus comentários serão removidos para sempre.', 'Apagar', { pose: 'worried', cancelLabel: 'Não, manter' }))) return;
    const proc = startProcessing('A apagar a publicação');
    try { await B.deletePost(p); } catch (e) { await proc.done(0); return failed(e); }
    db.posts = db.posts.filter(x => x.id !== id);
    db.notifications = db.notifications.filter(n => n.postId !== id);
    Object.values(db.users).forEach(u => { u.bookmarks = u.bookmarks.filter(b => b !== id); });
    await proc.done(600);
    toast('Publicação apagada.');
    closeDetail();
    renderAll();
}

function sharePost(id) {
    const url = location.href.split('#')[0] + '#/obra/' + id;
    const p = getPost(id);
    if (navigator.share) {
        navigator.share({ title: p ? p.title : 'Bédia', url }).catch(() => {});
        return;
    }
    const fallback = () => window.prompt('Copie o link:', url);
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(() => toast('Link copiado!'), fallback);
    } else fallback();
}

function openReport(id) {
    if (!requireLogin('Entre para denunciar uma publicação.', () => openReport(id))) return;
    reportPostId = id;
    $('reportForm').reset();
    openModal('reportModal');
}


/* ---------- PUBLICAR / EDITAR ---------- */
function handlePublish() {
    if (!requireLogin('Você precisa estar logado para publicar no Bédia!', handlePublish)) return;
    openPublish(null);
}

function openPublish(postId) {
    editingPostId = postId;
    draft = [];
    editOrder = [];
    $('publishForm').reset();
    showError($('publishError'), '');
    setPublishStatus('');
    const editing = !!postId;
    $('publishTitleText').textContent = editing ? 'Editar publicação' : 'Nova Publicação no Bédia';
    $('publishSubmitBtn').querySelector('span').textContent = editing ? 'Guardar alterações' : 'Publicar no Bédia';
    $('dropZone').classList.toggle('hidden', editing);
    $('termsGroup').classList.toggle('hidden', editing);
    $('imagesLabel').textContent = editing
        ? 'Páginas (clique na estrela ⭐ para escolher a capa)'
        : 'Imagens ou PDF (clique na estrela ⭐ para escolher a capa) *';

    if (editing) {
        const p = getPost(postId);
        editOrder = p.images.slice();
        $('postTitle').value = p.title;
        $('postCategory').value = p.category;
        $('postTags').value = p.tags.join(', ');
        $('postDescription').value = p.description;
        $('postNsfw').checked = !!p.nsfw;
    }
    renderThumbs();
    openModal('publishModal');
}

function renderThumbs() {
    const strip = $('thumbStrip');
    const editing = !!editingPostId;
    const list = editing ? editOrder.map(imgSrc) : draft;
    strip.innerHTML = list.map((src, i) => {
        const star = `<button type="button" data-action="thumb-make-cover" data-idx="${i}" aria-label="Usar como capa" title="Usar como capa" class="star" ${i === 0 ? 'disabled style="opacity:.3"' : ''}><i class="fa-solid fa-star"></i></button>`;
        const bar = editing
            ? star
            : `<button type="button" data-action="thumb-left" data-idx="${i}" aria-label="Mover para a esquerda" ${i === 0 ? 'disabled style="opacity:.3"' : ''}><i class="fa-solid fa-chevron-left"></i></button>
               ${star}
               <button type="button" data-action="thumb-remove" data-idx="${i}" aria-label="Remover" class="danger"><i class="fa-solid fa-trash"></i></button>
               <button type="button" data-action="thumb-right" data-idx="${i}" aria-label="Mover para a direita" ${i === list.length - 1 ? 'disabled style="opacity:.3"' : ''}><i class="fa-solid fa-chevron-right"></i></button>`;
        return `
        <div class="thumb">
            <img src="${esc(src)}" alt="Página ${i + 1}">
            ${i === 0 ? '<span class="thumb-cover">Capa</span>' : ''}
            <div class="thumb-bar ${editing ? 'single' : ''}">${bar}</div>
        </div>`;
    }).join('');
}

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

function setPublishStatus(msg) {
    const el = $('publishStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
}

async function handleFiles(fileList) {
    const files = [...fileList];
    if (!files.length || converting) return;
    const err = $('publishError');
    showError(err, '');
    let skipped = 0, full = false, cut = false, usedPdf = false;
    converting = true;
    const procFiles = startProcessing('A preparar as tuas páginas', { delay: 350 });
    try {
        for (const file of files) {
            if (draft.length >= MAX_IMAGES) { full = true; break; }
            if (isPdf(file)) {
                if (file.size > MAX_PDF_MB * 1024 * 1024) { skipped++; continue; }
                try {
                    const res = await pdfToImages(file, MAX_IMAGES - draft.length,
                        (n, t) => { setPublishStatus(`A converter o PDF… página ${n} de ${t}`); procFiles.update(`A converter o PDF… página ${n} de ${t}`); });
                    draft.push(...res.pages);
                    if (res.cut) cut = true;
                    usedPdf = true;
                    renderThumbs();
                } catch (e) { skipped++; }
                continue;
            }
            if (!file.type.startsWith('image/')) { skipped++; continue; }
            if (file.size > MAX_FILE_MB * 1024 * 1024) { skipped++; continue; }
            try { draft.push(await compressImage(file)); } catch (e) { skipped++; }
        }
    } finally {
        converting = false;
        setPublishStatus('');
        await procFiles.done(400);
    }

    const msgs = [];
    if (full) msgs.push(`Máximo de ${MAX_IMAGES} páginas por publicação.`);
    if (cut) msgs.push(`O PDF tinha mais páginas: só entraram as primeiras (limite de ${MAX_IMAGES}).`);
    if (skipped) msgs.push(`${skipped} ficheiro(s) ignorado(s): use imagens até ${MAX_FILE_MB} MB ou PDF até ${MAX_PDF_MB} MB.`);
    if (msgs.length) showError(err, msgs.join(' '));

    if (usedPdf && draft.length) {
        if ($('postCategory').value === 'Ilustração 2D') $('postCategory').value = 'Mangá / Quadrinhos';
        setPublishStatus('Dica: clique na estrela ⭐ de uma página para a escolher como capa.');
    }
    $('fileInput').value = '';
    renderThumbs();
}

function parseTags(raw) {
    return [...new Set(
        raw.split(/[,\s]+/).map(t => t.replace(/^#/, '').trim().toLowerCase()).filter(t => t && t.length <= 24)
    )].slice(0, 8);
}

async function submitPublish(e) {
    e.preventDefault();
    const err = $('publishError');
    showError(err, '');
    const m = me();
    if (!m) return;

    const title = $('postTitle').value.trim();
    const category = $('postCategory').value;
    const description = $('postDescription').value.trim();
    const tags = parseTags($('postTags').value);
    const nsfw = $('postNsfw').checked;

    if (title.length < 2) return showError(err, 'Escreva um título para a obra.');

    if (editingPostId) {
        const p = getPost(editingPostId);
        if (!p || p.authorKey !== m.key) return;
        const procEdit = startProcessing('A guardar as alterações');
        try {
            const patch = await B.updatePost(p, { title, category, description, tags, nsfw }, editOrder);
            Object.assign(p, { title, category, description, tags, nsfw, editedAt: Date.now() });
            if (patch.images) p.images = patch.images;
            if (patch.thumb) p.thumb = patch.thumb;
        } catch (ex) { await procEdit.done(0); return failed(ex); }
        await procEdit.done(500);
        hideModal('publishModal');
        toast('Alterações guardadas.');
        renderAll();
        if (selectedPostId === p.id) renderDetail();
        return;
    }

    if (converting) return showError(err, 'Aguarde: o PDF ainda está a ser convertido.');
    if (!draft.length) return showError(err, 'Adicione pelo menos uma imagem ou um PDF.');
    if (!$('postTerms').checked) return showError(err, 'Confirme que a arte é sua para publicar.');

    const btn = $('publishSubmitBtn');
    btn.disabled = true;
    const proc = startProcessing('A publicar a tua arte');
    try {
        const post = await B.publish({ title, category, description, tags, nsfw }, draft);
        db.posts.unshift(post);
        draft = [];
        await proc.done(900);
        hideModal('publishModal');
        toast('Sua arte foi publicada no Bédia!');
        if (view.name === 'saved' || view.name === 'following') location.hash = '#/';
        activeCategory = 'Todos';
        searchQuery = '';
        syncSearchInputs();
        renderAll();
    } catch (ex) {
        console.error(ex);
        await proc.done(0);
        showError(err, 'Não foi possível publicar. Verifica a ligação e tenta de novo.');
    } finally {
        proc.done(0);
        btn.disabled = false;
    }
}

/* ---------- PERFIL ---------- */
const profileIsShown = () => view.name === 'profile';

function renderProfileHeader() {
    const box = $('profileHeader');
    const u = getUser(view.arg);
    if (!u) { box.innerHTML = ''; return; }
    const m = me();
    const own = m && m.key === u.key;
    const works = db.posts.filter(p => p.authorKey === u.key);
    const likesTotal = works.reduce((n, p) => n + p.likes.length, 0);
    const followers = Object.values(db.users).filter(x => x.following.includes(u.key)).length;
    const isFollowing = m && m.following.includes(u.key);
    const link = /^https?:\/\//i.test(u.link) ? u.link : '';
    const since = new Date(u.createdAt).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    box.innerHTML = `
        <div class="glass-card rounded-2xl p-5 md:p-7 flex flex-col sm:flex-row gap-5 sm:items-center">
            ${avatarHTML(u, 'w-24 h-24', 'text-3xl')}
            <div class="flex-1 min-w-0">
                <div class="flex items-center flex-wrap gap-3 mb-1">
                    <h1 class="text-xl md:text-2xl font-black text-white truncate">@${esc(u.handle)}</h1>
                    ${own
                        ? `<button data-action="edit-profile" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-gray-200 px-4 py-1.5 rounded-full text-xs font-semibold"><i class="fa-solid fa-pen mr-1"></i> Editar perfil</button>`
                        : `<button data-action="follow" data-user="${esc(u.key)}" class="${isFollowing ? 'bg-slate-800 border border-slate-700 text-gray-200' : 'bg-neonPurple hover:bg-neonPurpleHover text-white'} px-4 py-1.5 rounded-full text-xs font-bold">${isFollowing ? 'A seguir ✓' : '<i class="fa-solid fa-user-plus mr-1"></i> Seguir'}</button>`}
                </div>
                <p class="text-xs text-gray-300 leading-relaxed mb-2 break-words">${u.bio ? esc(u.bio) : '<span class="text-gray-500 italic">Este artista ainda não escreveu uma bio.</span>'}</p>
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 mb-3">
                    <span><i class="fa-regular fa-calendar mr-1"></i>Membro desde ${esc(since)}</span>
                    ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow" class="text-neonCyan hover:underline"><i class="fa-solid fa-link mr-1"></i>${esc(link.replace(/^https?:\/\//i, '').slice(0, 40))}</a>` : ''}
                </div>
                <div class="flex gap-6 text-xs">
                    <div><b class="text-white text-sm">${works.length}</b> <span class="text-gray-400">obras</span></div>
                    <div><b class="text-white text-sm">${followers}</b> <span class="text-gray-400">seguidores</span></div>
                    <div><b class="text-white text-sm">${u.following.length}</b> <span class="text-gray-400">a seguir</span></div>
                    <div><b class="text-white text-sm">${likesTotal}</b> <span class="text-gray-400">curtidas</span></div>
                </div>
            </div>
        </div>`;
}

function openProfileEditor() {
    const m = me();
    if (!m) return openAuth('login');
    closeMenus();
    profileColor = m.color;
    profileAvatarData = undefined;
    $('pfBio').value = m.bio;
    $('pfLink').value = m.link;
    $('pfBioCount').textContent = `${m.bio.length}/160`;
    showError($('pfError'), '');
    buildColorPicker($('pfColors'), () => profileColor, c => { profileColor = c; paintProfilePreview(); });
    paintProfilePreview();
    openModal('profileModal');
}

function paintProfilePreview() {
    const m = me();
    const preview = { ...m, color: profileColor };
    if (profileAvatarData === null) preview.avatarUrl = null;
    let html = avatarHTML(preview, 'w-20 h-20', 'text-2xl');
    if (typeof profileAvatarData === 'string') {
        html = `<img src="${esc(profileAvatarData)}" alt="" class="w-20 h-20 rounded-full object-cover border border-white/10">`;
    }
    $('pfAvatarPreview').innerHTML = html;
}

async function submitProfile(e) {
    e.preventDefault();
    const m = me();
    if (!m) return;
    const err = $('pfError');
    showError(err, '');
    let link = $('pfLink').value.trim();
    if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
    if (link && !/^https?:\/\/\S+\.\S+/i.test(link)) return showError(err, 'O link não parece válido.');

    const bio = $('pfBio').value.trim().slice(0, 160);
    const procPf = startProcessing('A guardar o perfil');
    try {
        const url = await B.saveProfile({ bio, link, color: profileColor, avatarDataUrl: profileAvatarData });
        m.bio = bio; m.link = link; m.color = profileColor;
        if (profileAvatarData === null) m.avatarUrl = null; else if (url) m.avatarUrl = url;
    } catch (ex) { await procPf.done(0); return failed(ex); }
    await procPf.done(500);
    hideModal('profileModal');
    toast('Perfil atualizado.');
    renderAll();
    if (selectedPostId) renderDetail(true);
}

function normalizeDb() {
    db.users = db.users || {};
    db.posts = db.posts || [];
    db.notifications = db.notifications || [];
    db.reports = db.reports || [];
    Object.values(db.users).forEach(u => {
        u.following = u.following || []; u.bookmarks = u.bookmarks || [];
        u.bio = u.bio || ''; u.link = u.link || ''; u.avatarUrl = u.avatarUrl || null;
    });
    db.posts.forEach(p => {
        p.likes = p.likes || []; p.comments = p.comments || [];
        p.tags = p.tags || []; p.images = p.images || []; p.description = p.description || '';
    });
    if (db.session && !db.users[db.session]) db.session = null;
}

/* ---------- APAGAR CONTA ---------- */
async function deleteAccount() {
    const m = me();
    if (!m) return;
    closeMenus();
    const ok = await askConfirm(
        'Queres mesmo apagar a tua conta?',
        'As tuas obras, comentários, curtidas e seguidores serão removidos para sempre. Isto não pode ser desfeito.',
        'Apagar conta',
        { pose: 'worried', cancelLabel: 'Não, ficar' }
    );
    if (!ok) return;
    const proc = startProcessing('A apagar a conta');
    try { await B.deleteAccount(); } catch (e) { await proc.done(0); return failed(e); }
    try { db = await B.load(); } catch (e) { db.session = null; }
    await proc.done(900);
    location.hash = '#/';
    renderAll();
    toast('A tua conta foi apagada.');
}

/* ---------- RESPONDER A COMENTÁRIOS ---------- */
function updateReplyBar() {
    const bar = $('replyBar');
    const p = getPost(selectedPostId);
    const c = replyingTo && p ? p.comments.find(x => x.id === replyingTo) : null;
    if (!c) replyingTo = null;
    setFlex(bar, !!c);
    if (c) {
        const u = getUser(c.authorKey);
        $('replyBarText').textContent = '@' + (u ? u.handle : 'desconhecido');
    }
}

/* ---------- LEITOR ---------- */
const lastPages = LS.get('bedia:lastPage', {});
function lastPageOf(id, total) {
    const n = +lastPages[id];
    return Number.isInteger(n) && n > 0 && n < total ? n : 0;
}
function saveLastPage(id, n) {
    if (n > 0) lastPages[id] = n; else delete lastPages[id];
    LS.set('bedia:lastPage', lastPages);
}

function toggleReaderMode() {
    readerMode = readerMode === 'scroll' ? 'page' : 'scroll';
    LS.set('bedia:readerMode', readerMode);
    renderDetail(true);
    $('detailViewer').scrollTop = 0;
    toast(readerMode === 'scroll' ? 'Leitura vertical.' : 'Leitura página a página.');
}

function enterReaderFull() {
    const pane = $('readerPane');
    if (readerFull || !pane) return;
    readerHome = document.createComment('leitor');
    pane.parentNode.insertBefore(readerHome, pane);
    document.body.appendChild(pane);
    pane.classList.add('reader-full');
    readerFull = true;
    if (pane.requestFullscreen) pane.requestFullscreen().then(() => { readerRealFs = true; }).catch(() => {});
    paintReaderTools();
}

function exitReaderFull() {
    const pane = $('readerPane');
    if (!readerFull || !pane) return;
    readerFull = false;
    pane.classList.remove('reader-full');
    if (readerHome && readerHome.parentNode) readerHome.parentNode.replaceChild(pane, readerHome);
    readerHome = null;
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    readerRealFs = false;
    paintReaderTools();
}

function toggleReaderFull() { if (readerFull) exitReaderFull(); else enterReaderFull(); }

document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && readerRealFs && readerFull) exitReaderFull();
});

function paintReaderTools() {
    const p = getPost(selectedPostId);
    const multi = !!p && p.images.length > 1;
    const modeBtn = $('readerModeBtn');
    setFlex(modeBtn, multi);
    modeBtn.innerHTML = readerMode === 'scroll' ? '<i class="fa-solid fa-book-open"></i>' : '<i class="fa-solid fa-scroll"></i>';
    const label = readerMode === 'scroll' ? 'Ler página a página' : 'Ler na vertical';
    modeBtn.setAttribute('aria-label', label);
    modeBtn.title = label;
    const fullBtn = $('readerFullBtn');
    fullBtn.innerHTML = readerFull ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
    fullBtn.setAttribute('aria-label', readerFull ? 'Sair do ecrã inteiro' : 'Ecrã inteiro');
    fullBtn.title = readerFull ? 'Sair do ecrã inteiro' : 'Ecrã inteiro';
}

(function readerGestures() {
    const viewer = $('detailViewer');
    let sx = 0, sy = 0, swiped = false;
    viewer.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
    viewer.addEventListener('touchend', (e) => {
        if (readerMode !== 'page') return;
        const t = e.changedTouches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swiped = true;
            pageDelta(dx < 0 ? 1 : -1);
            setTimeout(() => { swiped = false; }, 350);
        }
    }, { passive: true });
    viewer.addEventListener('click', (e) => {
        if (swiped || readerMode !== 'page' || e.target.tagName !== 'IMG') return;
        const p = getPost(selectedPostId);
        if (!p || p.images.length < 2) return;
        const r = e.target.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        if (x < 0.3) pageDelta(-1); else if (x > 0.7) pageDelta(1);
    });
})();

/* ---------- CARREGAR MAIS AO ROLAR ---------- */
(function infiniteScroll() {
    const wrap = $('loadMoreWrap');
    if (!wrap || !('IntersectionObserver' in window)) return;
    let busy = false;
    const io = new IntersectionObserver((entries) => {
        if (busy || !entries.some(e => e.isIntersecting)) return;
        busy = true;
        io.unobserve(wrap);
        visibleCount += PAGE_SIZE;
        renderGrid();
        requestAnimationFrame(() => { busy = false; io.observe(wrap); });
    }, { rootMargin: '400px 0px' });
    io.observe(wrap);
})();

/* ---------- NOTIFICAÇÕES ---------- */
function myNotifs() {
    const m = me();
    return m ? db.notifications.filter(n => n.toKey === m.key) : [];
}

function renderNotifBadge() {
    const unread = myNotifs().filter(n => !n.read).length;
    const b = $('notifBadge');
    b.textContent = unread > 9 ? '9+' : unread;
    setFlex(b, unread > 0);
}

function notifText(n) {
    const from = getUser(n.fromKey);
    const who = `<b class="text-white">@${esc(from ? from.handle : 'alguém')}</b>`;
    const p = n.postId ? getPost(n.postId) : null;
    const t = p ? `«${esc(p.title)}»` : '';
    if (n.type === 'like') return `${who} curtiu a sua obra ${t}`;
    if (n.type === 'comment') return `${who} comentou em ${t}`;
    if (n.type === 'reply') return `${who} respondeu ao seu comentário em ${t}`;
    return `${who} começou a seguir você`;
}

function toggleNotifPanel() {
    const panel = $('notifPanel');
    const open = panel.classList.contains('hidden');
    closeMenus();
    if (!open) return;
    const list = myNotifs().slice(0, 25);
    $('notifList').innerHTML = list.length
        ? list.map(n => `
            <button class="notif-item ${n.read ? '' : 'unread'}" data-action="open-notif" data-id="${esc(n.id)}">
                ${avatarHTML(getUser(n.fromKey), 'w-8 h-8', 'text-[11px]')}
                <span class="flex-1 min-w-0"><span class="block leading-snug">${notifText(n)}</span><span class="text-[10px] text-gray-500">${timeAgo(n.createdAt)}</span></span>
            </button>`).join('')
        : '<p class="px-4 py-8 text-center text-xs text-gray-500">Ainda não há notificações.</p>';
    panel.classList.remove('hidden');
    const ids = myNotifs().filter(n => !n.read).map(n => n.id);
    myNotifs().forEach(n => { n.read = true; });
    B.markRead(ids).catch(() => {});
    renderNotifBadge();
}

function closeMenus() {
    $('notifPanel').classList.add('hidden');
    $('userMenu').classList.add('hidden');
}

/* ---------- RENDERIZAÇÃO: CABEÇALHO ---------- */
function renderHeader() {
    const m = me();
    $('loginBtn').classList.toggle('hidden', !!m);
    setFlex($('loggedBox'), !!m);
    if (m) {
        $('userMenuAvatar').innerHTML = avatarHTML(m, 'w-9 h-9', 'text-xs');
        $('userMenuName').textContent = '@' + m.handle;
        $('userMenuEmail').textContent = m.email;
        renderNotifBadge();
    }
}

/* ---------- RENDERIZAÇÃO: FEED ---------- */
function visiblePosts() {
    const m = me();
    let list = db.posts.slice();

    if (view.name === 'following') list = m ? list.filter(p => m.following.includes(p.authorKey)) : [];
    else if (view.name === 'saved') list = m ? list.filter(p => m.bookmarks.includes(p.id)) : [];
    else if (view.name === 'profile') list = list.filter(p => p.authorKey === view.arg);

    if (view.name !== 'profile' && activeCategory !== 'Todos') list = list.filter(p => p.category === activeCategory);

    const q = searchQuery.toLowerCase().replace(/^#/, '');
    if (q) {
        list = list.filter(p => {
            const a = getUser(p.authorKey);
            return p.title.toLowerCase().includes(q)
                || p.description.toLowerCase().includes(q)
                || (a && a.handle.toLowerCase().includes(q))
                || p.tags.some(t => t.includes(q));
        });
    }

    const sort = $('sortSelect').value;
    if (sort === 'popular') list.sort((a, b) => b.likes.length - a.likes.length || b.createdAt - a.createdAt);
    else if (sort === 'discussed') list.sort((a, b) => b.comments.length - a.comments.length || b.createdAt - a.createdAt);
    else list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
}

function postCard(p) {
    const a = getUser(p.authorKey), m = me();
    const liked = m && p.likes.includes(m.key);
    const saved = m && m.bookmarks.includes(p.id);
    const blur = p.nsfw && !revealed.has(p.id);
    return `
    <div class="masonry-item">
        <article class="pin group" data-action="open-post" data-id="${esc(p.id)}" tabindex="0" aria-label="${esc(p.title)}">
            <div class="pin-media">
                <img src="${esc(imgSrc(p.thumb || p.images[0]))}" loading="lazy" decoding="async" alt="${esc(p.title)}" class="pin-img ${seenImgs.has(p.id) ? 'loaded' : ''} ${blur ? 'nsfw-blur' : ''}">

                ${p.images.length > 1 ? `<span class="pin-count"><i class="fa-regular fa-images"></i>${p.images.length}</span>` : ''}

                ${blur ? `
                <div class="pin-nsfw">
                    <i class="fa-solid fa-eye-slash text-xl text-white mb-1"></i>
                    <span class="text-xs font-bold text-white">Conteúdo sensível</span>
                    <span class="text-[10px] text-gray-300">Toque para ver</span>
                </div>` : `
                <div class="pin-hover">
                    <span class="pin-cat">${esc(CATEGORY_LABEL[p.category] || p.category)}</span>
                    <button data-action="bookmark" data-id="${esc(p.id)}" aria-label="${saved ? 'Remover dos salvos' : 'Salvar'}" class="pin-save ${saved ? 'saved' : ''}">
                        <i class="${saved ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i><span>${saved ? 'Salvo' : 'Salvar'}</span>
                    </button>
                </div>`}
            </div>

            <div class="pin-info">
                <h3 class="pin-title">${esc(p.title)}</h3>
                <div class="pin-meta">
                    <button data-action="open-profile" data-user="${esc(p.authorKey)}" class="pin-author">
                        ${avatarHTML(a, 'w-6 h-6', 'text-[10px]')}
                        <span>@${esc(a ? a.handle : 'desconhecido')}</span>
                    </button>
                    <span class="pin-stats">
                        <span><i class="fa-regular fa-comment"></i>${p.comments.length}</span>
                        <button data-action="like" data-id="${esc(p.id)}" aria-label="Curtir" class="pin-like ${liked ? 'liked' : ''}">
                            <i class="${liked ? 'fa-solid' : 'fa-regular'} fa-heart"></i><span>${p.likes.length}</span>
                        </button>
                    </span>
                </div>
            </div>
        </article>
    </div>`;
}

function emptyConfig() {
    const m = me();
    const filtering = searchQuery || (view.name !== 'profile' && activeCategory !== 'Todos');
    if (filtering) return { icon: 'fa-magnifying-glass', title: 'Nada encontrado', text: 'Tente outra pesquisa ou outra categoria.', btn: 'Limpar filtros', act: 'clear-filters' };
    if (view.name === 'following') {
        return m && m.following.length
            ? { icon: 'fa-user-group', title: 'Sem novidades', text: 'Os artistas que você segue ainda não publicaram.', btn: 'Explorar artistas', act: 'go-home' }
            : { icon: 'fa-user-group', title: 'Você ainda não segue ninguém', text: 'Siga artistas para ver aqui as obras deles.', btn: 'Explorar artistas', act: 'go-home' };
    }
    if (view.name === 'saved') return { icon: 'fa-bookmark', title: 'Nada salvo ainda', text: 'Toque no marcador de uma obra para a guardar aqui.', btn: 'Explorar obras', act: 'go-home' };
    if (view.name === 'profile') {
        const own = m && m.key === view.arg;
        return own
            ? { icon: 'fa-pen-nib', title: 'Você ainda não publicou', text: 'Mostre a sua primeira arte à comunidade!', btn: 'Publicar agora', act: 'publish' }
            : { icon: 'fa-ghost', title: 'Sem obras por aqui', text: 'Este artista ainda não publicou nada.', btn: 'Explorar obras', act: 'go-home' };
    }
    return { icon: 'fa-ghost', title: 'Ainda não há publicações', text: 'Seja o primeiro a publicar a sua arte no Bédia!', btn: 'Publicar agora', act: 'publish' };
}

function renderGrid() {
    const list = visiblePosts();
    const shown = list.slice(0, visibleCount);
    $('artMasonryGrid').innerHTML = shown.map(postCard).join('');

    const empty = list.length === 0;
    $('emptyState').classList.toggle('hidden', !empty);
    if (empty) {
        const c = emptyConfig();
        $('emptyIcon').className = `fa-solid ${c.icon}`;
        $('emptyTitle').textContent = c.title;
        $('emptyText').textContent = c.text;
        $('emptyAction').textContent = c.btn;
        $('emptyAction').dataset.action = c.act;
    }
    $('loadMoreWrap').classList.toggle('hidden', list.length <= visibleCount);

    const info = $('filterInfo');
    const bits = [];
    if (searchQuery) bits.push(`pesquisa "<b class="text-white">${esc(searchQuery)}</b>"`);
    if (view.name !== 'profile' && activeCategory !== 'Todos') bits.push(`categoria <b class="text-white">${esc(CATEGORY_LABEL[activeCategory] || activeCategory)}</b>`);
    setFlex(info, bits.length > 0);
    info.innerHTML = bits.length
        ? `<span>${list.length} resultado(s) · ${bits.join(' · ')}</span> <button data-action="clear-filters" class="text-neonCyan hover:underline">limpar</button>`
        : '';
}

function renderChrome() {
    const isHome = view.name === 'home';
    const isProfile = view.name === 'profile';

    $('heroSection').classList.toggle('hidden', !isHome || !!searchQuery || activeCategory !== 'Todos');
    $('profileHeader').classList.toggle('hidden', !isProfile);
    $('viewTabs').classList.toggle('hidden', isProfile);
    $('categoryContainer').classList.toggle('hidden', isProfile);

    document.querySelectorAll('#viewTabs .view-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === view.name));
    document.querySelectorAll('.category-btn').forEach(b => b.classList.toggle('active', b.dataset.category === activeCategory));

    if (isProfile) renderProfileHeader();

    const titles = { home: '', following: 'Seguindo · ', saved: 'Salvos · ' };
    const u = isProfile ? getUser(view.arg) : null;
    document.title = (isProfile && u ? `@${u.handle} · ` : (titles[view.name] || '')) + 'Bédia - Mangá e Arte Otaku';
}

function renderAll() {
    renderHeader();
    renderChrome();
    renderGrid();
}

function syncSearchInputs() {
    $('searchInput').value = searchQuery;
    $('mobileSearchInput').value = searchQuery;
    hideSuggestions();
    updateClearBtn();
}

/* ---------- RENDERIZAÇÃO: DETALHE DA OBRA ---------- */
function openDetail(id) {
    const p = getPost(id);
    if (!p) return;
    selectedPostId = id;
    replyingTo = null;
    const last = lastPageOf(id, p.images.length);
    pageIndex = last;
    renderDetail(true);
    openModal('detailModal');
    $('detailViewer').scrollTop = 0;
    if (last > 0 && readerMode === 'page') toast(`Continuas de onde ficaste: página ${last + 1}.`);
    document.title = p.title + ' · Bédia';
}

let afterDetailClose = null;
let detailBackPending = false;

function openPostRoute(id) {
    const target = '#/obra/' + id;
    if (location.hash === target) return;
    history.pushState({ bedia: 'obra' }, '', target);
    route();
}

function closeDetail(after) {
    const wasOpen = selectedPostId !== null || !$('detailModal').classList.contains('hidden');
    if (!$('detailModal').classList.contains('hidden')) hideModal('detailModal');
    selectedPostId = null;

    if (wasOpen && location.hash.startsWith('#/obra/')) {
        if (history.state && history.state.bedia === 'obra') {
            afterDetailClose = after || null;
            detailBackPending = true;
            history.back();
            renderChrome();
            return;
        }
        history.replaceState(null, '', lastRouteHash);
        renderChrome();
    }
    if (after) after();
}

function renderDetail(keepPage = false) {
    const p = getPost(selectedPostId);
    if (!p) return closeDetail();
    const m = me();
    const a = getUser(p.authorKey);
    if (!keepPage) pageIndex = 0;
    pageIndex = Math.min(pageIndex, p.images.length - 1);

    $('detailBadgeCategory').textContent = CATEGORY_LABEL[p.category] || p.category;
    $('detailTitle').textContent = p.title;
    $('detailDescription').textContent = p.description || 'Sem descrição.';
    $('detailMeta').textContent = timeAgo(p.createdAt) + (p.editedAt ? ' · editado' : '');

    const iFollow = m && a && m.following.includes(a.key);
    $('detailAuthor').innerHTML = `
        <div class="flex items-center gap-2.5">
            <button data-action="open-profile" data-user="${esc(p.authorKey)}" class="flex items-center gap-2.5 min-w-0 hover:opacity-80 text-left">
                ${avatarHTML(a, 'w-9 h-9', 'text-xs')}
                <span class="min-w-0"><span class="block font-bold text-white text-xs truncate">@${esc(a ? a.handle : 'desconhecido')}</span><span class="text-[11px] text-neonCyan">Ver perfil</span></span>
            </button>
            ${a && (!m || m.key !== a.key) ? `<button data-action="follow" data-user="${esc(a.key)}" class="${iFollow ? 'bg-slate-800 border border-slate-700 text-gray-200' : 'bg-neonPurple text-white'} px-3 py-1 rounded-full text-[11px] font-bold">${iFollow ? 'A seguir ✓' : 'Seguir'}</button>` : ''}
        </div>`;

    $('detailTags').innerHTML = p.tags.map(t =>
        `<button data-action="tag" data-tag="${esc(t)}" class="text-[10px] bg-slate-800 hover:bg-slate-700 text-purple-300 px-2 py-0.5 rounded-full border border-slate-700">#${esc(t)}</button>`
    ).join('');

    const blur = p.nsfw && !revealed.has(p.id);
    const multi = p.images.length > 1;
    const scrollMode = multi && readerMode === 'scroll' && !blur;
    const viewer = $('detailViewer');
    viewer.classList.toggle('scroll-mode', scrollMode);
    const revealBtn = blur ? `<button data-action="reveal" class="absolute inset-0 flex flex-col items-center justify-center bg-black/50 text-white">
            <i class="fa-solid fa-eye-slash text-2xl mb-2"></i><span class="text-sm font-bold">Conteúdo sensível</span><span class="text-xs text-gray-300">Clique para ver</span></button>` : '';
    viewer.innerHTML = scrollMode
        ? `<div class="reader-strip">${p.images.map((imgUrl, i) => `<img src="${esc(imgSrc(imgUrl))}" alt="${esc(p.title)} - página ${i + 1}" loading="lazy" decoding="async">`).join('')}</div>`
        : `<img src="${esc(imgSrc(p.images[pageIndex]))}" alt="${esc(p.title)} - página ${pageIndex + 1}" class="max-h-[70vh] max-w-full object-contain ${blur ? 'nsfw-blur' : ''}">${revealBtn}`;

    setFlex($('detailPager'), multi && !scrollMode);
    if (multi && !scrollMode) {
        $('pageIndicator').textContent = `Página ${pageIndex + 1} de ${p.images.length}`;
        $('pagePrev').disabled = pageIndex === 0;
        $('pageNext').disabled = pageIndex === p.images.length - 1;
    }

    const liked = m && p.likes.includes(m.key);
    const saved = m && m.bookmarks.includes(p.id);
    const own = m && m.key === p.authorKey;
    $('detailActions').innerHTML = `
        <div class="flex items-center gap-4">
            <button data-action="like" data-id="${esc(p.id)}" class="flex items-center gap-1.5 text-gray-400 hover:text-neonPink transition-colors" aria-label="Curtir">
                <i class="${liked ? 'fa-solid text-neonPink pop' : 'fa-regular'} fa-heart text-base"></i>
                <span class="text-xs font-bold text-gray-300">${p.likes.length}</span>
            </button>
            <button data-action="bookmark" data-id="${esc(p.id)}" class="flex items-center gap-1.5 text-gray-400 hover:text-neonCyan transition-colors">
                <i class="${saved ? 'fa-solid text-neonCyan' : 'fa-regular'} fa-bookmark text-base"></i>
                <span class="text-xs font-semibold text-gray-300">${saved ? 'Salvo' : 'Salvar'}</span>
            </button>
            <button data-action="share" data-id="${esc(p.id)}" class="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors">
                <i class="fa-solid fa-share-nodes text-base"></i><span class="text-xs font-semibold text-gray-300">Partilhar</span>
            </button>
        </div>
        <div class="flex items-center gap-3 text-xs">
            ${own
                ? `<button data-action="edit-post" data-id="${esc(p.id)}" class="text-gray-300 hover:text-white"><i class="fa-solid fa-pen mr-1"></i>Editar</button>
                   <button data-action="delete-post" data-id="${esc(p.id)}" class="text-pink-300 hover:text-pink-200"><i class="fa-solid fa-trash mr-1"></i>Apagar</button>`
                : `<button data-action="report" data-id="${esc(p.id)}" class="text-gray-500 hover:text-pink-300" title="Denunciar"><i class="fa-regular fa-flag mr-1"></i>Denunciar</button>`}
        </div>`;

    $('commentCount').textContent = p.comments.length;
    $('commentsList').innerHTML = p.comments.length
        ? p.comments.map(c => {
            const ca = getUser(c.authorKey);
            const canDelete = m && (m.key === c.authorKey || m.key === p.authorKey);
            const parent = c.replyTo ? p.comments.find(x => x.id === c.replyTo) : null;
            const pa = parent ? getUser(parent.authorKey) : null;
            return `
            <div class="bg-slate-950/70 p-2.5 rounded-xl border border-slate-800 flex gap-2 ${parent ? 'ml-5' : ''}">
                ${avatarHTML(ca, 'w-6 h-6', 'text-[10px]')}
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-2 mb-0.5">
                        <button data-action="open-profile" data-user="${esc(c.authorKey)}" class="text-xs font-bold text-neonCyan hover:underline truncate">@${esc(ca ? ca.handle : 'desconhecido')}</button>
                        <span class="text-[9px] text-gray-500 shrink-0">${timeAgo(c.createdAt)}${canDelete ? ` <button data-action="delete-comment" data-id="${esc(c.id)}" aria-label="Apagar comentário" class="ml-1 text-gray-500 hover:text-pink-300"><i class="fa-solid fa-trash-can"></i></button>` : ''}</span>
                    </div>
                    ${parent ? `<div class="text-[10px] text-gray-500 mb-0.5"><i class="fa-solid fa-reply mr-1"></i>em resposta a @${esc(pa ? pa.handle : 'desconhecido')}</div>` : ''}
                    <p class="text-xs text-gray-300 leading-snug break-words">${esc(c.text)}</p>
                    <button type="button" data-action="reply-comment" data-id="${esc(c.id)}" class="text-[10px] text-gray-500 hover:text-neonCyan mt-1">Responder</button>
                </div>
            </div>`;
        }).join('')
        : '<p class="text-xs text-gray-500 italic py-2">Ainda ninguém comentou. Seja a primeira pessoa!</p>';

    const input = $('commentInput');
    input.placeholder = m ? 'Escreva seu comentário...' : 'Entre para comentar...';
    input.readOnly = !m;
    updateReplyBar();
    paintReaderTools();
}

function pageDelta(d) {
    const p = getPost(selectedPostId);
    if (!p) return;
    if (readerMode === 'scroll' && p.images.length > 1) return;
    const n = pageIndex + d;
    if (n < 0 || n >= p.images.length) return;
    pageIndex = n;
    saveLastPage(p.id, n === p.images.length - 1 ? 0 : n);   // ao chegar ao fim, recomeça da capa
    renderDetail(true);
}

/* ---------- TEXTOS LEGAIS ---------- */
const LEGAL = {
    termos: {
        title: 'Termos de Uso',
        html: `
            <p><b class="text-white">1. A sua arte é sua.</b> Só publique trabalhos que criou ou que tem autorização para partilhar. Arte roubada ou copiada será removida e a conta pode ser suspensa.</p>
            <p><b class="text-white">2. Respeito.</b> Não é permitido ódio, assédio, ameaças, conteúdo ilegal ou qualquer conteúdo que envolva menores de forma imprópria.</p>
            <p><b class="text-white">3. Conteúdo sensível.</b> Obras com nudez ou violência explícita devem ser marcadas como "conteúdo sensível". Quem não marcar pode ter a obra removida.</p>
            <p><b class="text-white">4. Direitos.</b> Você mantém todos os direitos sobre a sua arte. Ao publicar, autoriza o Bédia a exibi-la na plataforma.</p>
            <p><b class="text-white">5. Remoções.</b> Se acredita que uma obra viola os seus direitos, use o botão "Denunciar" ou fale com o suporte.</p>
            <p class="text-gray-500">Versão provisória · Atualizado em outubro de 2026.</p>`
    },
    privacidade: {
        title: 'Política de Privacidade',
        html: `
            <p><b class="text-white">Que dados guardamos.</b> Nome de utilizador, e-mail, bio, foto e as obras, comentários e curtidas que você faz.</p>
            <p><b class="text-white">Para que servem.</b> Para criar o seu perfil, mostrar o seu trabalho e enviar notificações dentro do site.</p>
            <p><b class="text-white">Partilha.</b> Não vendemos os seus dados. O e-mail não é mostrado a outros utilizadores.</p>
            <p><b class="text-white">Os seus direitos.</b> Pode editar o perfil e apagar as suas publicações quando quiser. Pode apagar a sua conta no menu do perfil, em “Apagar conta”.</p>
            <p class="text-gray-500">Os dados ficam guardados num servidor seguro (Supabase). Versão provisória · Outubro de 2026.</p>`
    },
    suporte: {
        title: 'Suporte',
        html: `
            <p>Precisa de ajuda, quer reportar um problema ou pedir a remoção de uma obra?</p>
            <p>Escreva para <a class="text-neonCyan hover:underline" href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
            <p>Para denunciar uma publicação, abra-a e use o botão <b class="text-white">Denunciar</b>.</p>`
    }
};

/* ---------- ROTAS (hash) ---------- */
function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
        .map(s => { try { return decodeURIComponent(s); } catch (e) { return ''; } });
    const [a, b] = parts;

    if (a === 'obra' && b) {
        if (firstRender) { view = { name: 'home', arg: null }; renderAll(); firstRender = false; }
        if (!getPost(b)) {
            toast('Obra não encontrada.', 'error');
            history.replaceState(null, '', lastRouteHash);
            return;
        }
        openDetail(b);
        return;
    }

    firstRender = false;
    lastRouteHash = location.hash || '#/';
    const fromDetail = detailBackPending;
    detailBackPending = false;
    let hadDetail = false;
    if ($('detailModal') && !$('detailModal').classList.contains('hidden')) { hideModal('detailModal'); selectedPostId = null; hadDetail = true; }

    let next = { name: 'home', arg: null };
    if (a === 'seguindo' || a === 'salvos') {
        if (!me()) {
            history.replaceState(null, '', '#/');
            lastRouteHash = '#/';
            openAuth('login', 'Entre para ver esta página.');
        } else next = { name: a === 'seguindo' ? 'following' : 'saved', arg: null };
    } else if (a === 'u' && b) {
        const key = keyOf(b);
        if (getUser(key)) next = { name: 'profile', arg: key };
        else { toast('Artista não encontrado.', 'error'); history.replaceState(null, '', '#/'); lastRouteHash = '#/'; }
    }

    const changed = next.name !== view.name || next.arg !== view.arg;
    view = next;
    if (changed) visibleCount = PAGE_SIZE;
    closeMenus();
    if (changed || !(fromDetail || hadDetail)) renderAll(); else renderChrome();
    if (changed) window.scrollTo({ top: 0 });

    if (afterDetailClose) { const f = afterDetailClose; afterDetailClose = null; f(); }
}

/* ---------- AÇÕES (delegação de eventos) ---------- */
const actions = {
    'go': (el) => { location.hash = el.dataset.hash; closeMenus(); },
    'go-home': () => { location.hash = '#/'; },
    'open-post': (el) => {
        const p = getPost(el.dataset.id);
        if (!p) return;
        if (p.nsfw && !revealed.has(p.id)) { revealed.add(p.id); renderGrid(); return; }
        openPostRoute(p.id);
    },
    'open-profile': (el) => { location.hash = '#/u/' + el.dataset.user; },
    'like': (el) => toggleLike(el.dataset.id),
    'bookmark': (el) => toggleBookmark(el.dataset.id),
    'follow': (el) => toggleFollow(el.dataset.user),
    'share': (el) => sharePost(el.dataset.id),
    'report': (el) => openReport(el.dataset.id),
    'edit-post': (el) => openPublish(el.dataset.id),
    'delete-post': (el) => deletePost(el.dataset.id),
    'delete-comment': (el) => deleteComment(el.dataset.id),
    'reveal': () => { revealed.add(selectedPostId); renderDetail(true); renderGrid(); },
    'publish': () => handlePublish(),
    'login': () => openAuth('login'),
    'logout': () => confirmLogout(),
    'my-profile': () => { closeMenus(); if (me()) location.hash = '#/u/' + me().key; },
    'edit-profile': () => openProfileEditor(),
    'toggle-notif': () => toggleNotifPanel(),
    'toggle-user-menu': () => { const open = $('userMenu').classList.contains('hidden'); closeMenus(); if (open) $('userMenu').classList.remove('hidden'); },
    'open-notif': (el) => {
        const n = db.notifications.find(x => x.id === el.dataset.id);
        closeMenus();
        if (!n) return;
        if (n.postId && getPost(n.postId)) openPostRoute(n.postId);
        else location.hash = '#/u/' + n.fromKey;
    },
    'toggle-auth-mode': () => switchAuthMode(authMode === 'login' ? 'signup' : 'login'),
    'toggle-password': (el) => {
        const inp = $('authPassword');
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        el.innerHTML = `<i class="fa-regular ${show ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
        if (show) mascotSay('surprised', 'Ei! Agora vejo tudo!');
        else mascotSay('cover', 'Não estou a ver nada, juro!');
    },
    'close-modal': (el) => closeModal(el.dataset.modal),
    'legal': (el) => {
        const d = LEGAL[el.dataset.doc];
        $('infoTitle').textContent = d.title;
        $('infoBody').innerHTML = d.html;
        openModal('infoModal');
    },
    'category': (el) => { activeCategory = el.dataset.category; visibleCount = PAGE_SIZE; renderAll(); },
    'tag': (el) => {
        searchQuery = '#' + el.dataset.tag;
        syncSearchInputs();
        visibleCount = PAGE_SIZE;
        const go = () => { if (view.name !== 'home') location.hash = '#/'; else renderAll(); };
        if (selectedPostId) closeDetail(go); else go();
    },
    'clear-search': () => { searchQuery = ''; syncSearchInputs(); visibleCount = PAGE_SIZE; renderAll(); },
    'suggest': (el) => { const s = suggestItems[+el.dataset.i]; if (s) runSearch(s.value); },
    'search-now': (el) => runSearch($(el.dataset.input).value),
    'thumb-make-cover': (el) => {
        const i = +el.dataset.idx;
        if (!(i > 0)) return;
        const arr = editingPostId ? editOrder : draft;
        arr.unshift(arr.splice(i, 1)[0]);
        renderThumbs();
        $('thumbStrip').scrollLeft = 0;
    },
    'clear-filters': () => { searchQuery = ''; activeCategory = 'Todos'; syncSearchInputs(); visibleCount = PAGE_SIZE; renderAll(); },
    'load-more': () => { visibleCount += PAGE_SIZE; renderGrid(); },
    'page-prev': () => pageDelta(-1),
    'page-next': () => pageDelta(1),
    'thumb-left': (el) => { const i = +el.dataset.idx; if (i > 0) { [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; renderThumbs(); } },
    'thumb-right': (el) => { const i = +el.dataset.idx; if (i < draft.length - 1) { [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]; renderThumbs(); } },
    'thumb-remove': (el) => { draft.splice(+el.dataset.idx, 1); renderThumbs(); },
    'pf-pick-avatar': () => $('pfAvatarInput').click(),
    'pf-remove-avatar': () => { profileAvatarData = null; paintProfilePreview(); },
    'delete-account': () => deleteAccount(),
    'reply-comment': (el) => {
        if (!requireLogin('Entre para responder.')) return;
        replyingTo = el.dataset.id;
        updateReplyBar();
        $('commentInput').focus();
    },
    'cancel-reply': () => { replyingTo = null; updateReplyBar(); },
    'resend-code': async () => {
        if (!pendingEmail) return;
        try {
            const r = await B.resendCode(pendingEmail);
            if (r.error) toast(r.error, 'error'); else toast('Código reenviado. Vê o teu e-mail.');
        } catch (e) { failed(e); }
    },
    'reader-mode': () => toggleReaderMode(),
    'reader-full': () => toggleReaderFull()
};

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) {
        if (el.tagName === 'BUTTON' && el.disabled) return;
        actions[el.dataset.action](el, e);
        return;
    }
    if (!e.target.closest('.search-wrap')) hideSuggestions();
    if (!e.target.closest('#notifPanel, #userMenu')) closeMenus();
});

/* ---------- EVENTOS DE FORMULÁRIOS E TECLADO ---------- */
$('authForm').addEventListener('submit', submitAuth);
$('publishForm').addEventListener('submit', submitPublish);
$('profileForm').addEventListener('submit', submitProfile);

$('authForm').addEventListener('focusin', (e) => {
    if (skipNextHint) { skipNextHint = false; return; }
    const hint = AUTH_HINTS[e.target.id];
    if (!hint) return;
    const [pose, text] = hint();
    mascotSay(pose, text);
});
$('colorPickerContainer').addEventListener('click', (e) => {
    if (e.target.closest('button[data-color]')) mascotSay('right', 'Boa escolha! Essa cor fica linda.');
});

$('commentForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!requireLogin('Entre para comentar.')) return;
    const text = $('commentInput').value.trim();
    if (!text) return;
    $('commentInput').value = '';
    addComment(text);
});
$('commentInput').addEventListener('focus', () => {
    if (!me()) { $('commentInput').blur(); requireLogin('Entre para comentar.'); }
});

$('reportForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = me();
    if (!m || !reportPostId) return;
    B.report(reportPostId, $('reportReason').value, $('reportDetails').value.trim()).catch(failed);
    hideModal('reportModal');
    toast('Obrigado. A denúncia foi enviada.');
});

$('confirmOk').addEventListener('click', () => resolveConfirm(true));
$('confirmCancel').addEventListener('click', () => resolveConfirm(false));

$('pfBio').addEventListener('input', () => { $('pfBioCount').textContent = `${$('pfBio').value.length}/160`; });
$('pfAvatarInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!f.type.startsWith('image/') || f.size > MAX_FILE_MB * 1024 * 1024) return showError($('pfError'), 'Escolha uma imagem até 20 MB.');
    try {
        profileAvatarData = await compressImage(f, 256, 0.85, true);
        showError($('pfError'), '');
        paintProfilePreview();
    } catch (err) { showError($('pfError'), 'Não foi possível ler essa imagem.'); }
    e.target.value = '';
});

const dropZone = $('dropZone');
dropZone.addEventListener('click', () => $('fileInput').click());
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
$('fileInput').addEventListener('change', (e) => handleFiles(e.target.files));
['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('border-neonPurple'); }));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('border-neonPurple'); }));
dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

/* ---------- PESQUISA ---------- */
const searchUI = [
    { input: 'searchInput', box: 'suggestBox' },
    { input: 'mobileSearchInput', box: 'mobileSuggestBox' }
];
const SUGGEST_ICON = { tag: 'fa-hashtag', user: 'fa-user', post: 'fa-image' };
let suggestItems = [];
let suggestIndex = -1;

const suggestOpen = () => searchUI.some(u => $(u.box) && !$(u.box).classList.contains('hidden'));

function updateClearBtn() {
    setFlex($('clearSearchBtn'), !!($('searchInput').value || searchQuery));
}

function hideSuggestions() {
    searchUI.forEach(u => {
        const b = $(u.box);
        if (b) { b.classList.add('hidden'); b.innerHTML = ''; }
    });
    suggestItems = [];
    suggestIndex = -1;
}

function buildSuggestions(raw) {
    const q = raw.trim().toLowerCase().replace(/^[#@]/, '');
    const out = [];
    const seen = new Set();
    const count = { tag: 0, user: 0, post: 0 };
    const add = (type, label, value) => {
        const k = type + '|' + value.toLowerCase();
        if (seen.has(k) || count[type] >= 3 || out.length >= 8) return;
        seen.add(k); count[type]++;
        out.push({ type, label, value });
    };

    if (!q) {
        const uses = {};
        db.posts.forEach(p => p.tags.forEach(t => { uses[t] = (uses[t] || 0) + 1; }));
        Object.entries(uses).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([t]) => {
            count.tag = 0; add('tag', '#' + t, '#' + t);
        });
        return out;
    }

    Object.values(db.users).forEach(u => { if (u.handle.toLowerCase().includes(q)) add('user', '@' + u.handle, u.handle); });
    const tags = new Set();
    db.posts.forEach(p => p.tags.forEach(t => tags.add(t)));
    tags.forEach(t => { if (t.includes(q)) add('tag', '#' + t, '#' + t); });
    db.posts.forEach(p => { if (p.title.toLowerCase().includes(q)) add('post', p.title, p.title); });
    return out;
}

function showSuggestions(inputId) {
    const ui = searchUI.find(u => u.input === inputId);
    const input = $(inputId);
    if (!ui || !input || !$(ui.box)) return;
    const typed = input.value.trim();
    const items = buildSuggestions(input.value);
    hideSuggestions();
    if (!items.length) return;
    suggestItems = items;
    $(ui.box).innerHTML =
        (typed ? '' : '<div class="suggest-title">Tags em destaque</div>') +
        items.map((s, i) => `
            <button type="button" class="suggest-item" data-action="suggest" data-i="${i}">
                <i class="fa-solid ${SUGGEST_ICON[s.type]}"></i><span class="truncate">${esc(s.label)}</span>
            </button>`).join('') +
        (typed ? '<div class="suggest-hint">Prima Enter ou toque na lupa para pesquisar</div>' : '');
    $(ui.box).classList.remove('hidden');
}

function runSearch(value) {
    searchQuery = String(value || '').trim();
    visibleCount = PAGE_SIZE;
    syncSearchInputs();
    renderAll();
    if (document.activeElement && /INPUT/.test(document.activeElement.tagName)) document.activeElement.blur();
}

function paintSuggestIndex() {
    const box = searchUI.map(u => $(u.box)).find(b => b && !b.classList.contains('hidden'));
    if (!box) return;
    box.querySelectorAll('.suggest-item').forEach((b, i) => b.classList.toggle('active', i === suggestIndex));
}

function onSearchKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const picked = suggestIndex >= 0 ? suggestItems[suggestIndex] : null;
        runSearch(picked ? picked.value : e.target.value);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestItems.length) {
        e.preventDefault();
        const n = suggestItems.length;
        suggestIndex = e.key === 'ArrowDown' ? (suggestIndex + 1) % n : (suggestIndex <= 0 ? n - 1 : suggestIndex - 1);
        paintSuggestIndex();
    }
}

searchUI.forEach(u => {
    const input = $(u.input);
    input.addEventListener('input', () => { updateClearBtn(); showSuggestions(u.input); });
    input.addEventListener('focus', () => showSuggestions(u.input));
    input.addEventListener('keydown', onSearchKey);
});
$('sortSelect').addEventListener('change', () => { visibleCount = PAGE_SIZE; renderGrid(); });

document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(modal.id); });
});

document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('article.pin')) {
        e.preventDefault(); e.target.click(); return;
    }
    if (e.key === 'Escape') {
        if (procCount) return;
        if (readerFull) return exitReaderFull();
        if (suggestOpen()) return hideSuggestions();
        if (!$('notifPanel').classList.contains('hidden') || !$('userMenu').classList.contains('hidden')) return closeMenus();
        const top = modalStack[modalStack.length - 1];
        if (top) closeModal(top);
        return;
    }
    if (e.key === 'Tab' && modalStack.length) {   // prende o foco dentro do modal aberto
        const top = $(modalStack[modalStack.length - 1]);
        const items = [...top.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])')]
            .filter(x => x.offsetParent !== null);
        if (items.length) {
            const first = items[0], last = items[items.length - 1];
            if (!top.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
        return;
    }
    if (modalStack[modalStack.length - 1] === 'detailModal' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        if (e.key === 'ArrowLeft') pageDelta(-1);
        if (e.key === 'ArrowRight') pageDelta(1);
    }
});

window.addEventListener('hashchange', route);

/* ---------- PARTÍCULAS DE FUNDO (mais leves) ---------- */
(function particles() {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = $('bgCanvas');
    const ctx = canvas.getContext('2d');
    let list = [];
    const resize = () => { canvas.width = innerWidth; canvas.height = innerHeight; };
    const init = () => {
        list = Array.from({ length: 18 }, () => ({
            x: Math.random() * canvas.width, y: Math.random() * canvas.height,
            r: Math.random() * 2 + 1,
            c: Math.random() > 0.5 ? '#a855f7' : '#06b6d4',
            vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4
        }));
    };
    const tick = () => {
        if (!document.hidden && !modalStack.length) {   // pára quando há um modal aberto ou o separador está escondido
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            for (const p of list) {
                p.x += p.vx; p.y += p.vy;
                if (p.x < 0) p.x = canvas.width; if (p.x > canvas.width) p.x = 0;
                if (p.y < 0) p.y = canvas.height; if (p.y > canvas.height) p.y = 0;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = p.c;
                ctx.fill();
            }
        }
        requestAnimationFrame(tick);
    };
    addEventListener('resize', () => { resize(); init(); });
    resize(); init(); tick();
})();

/* ---------- ARRANQUE ---------- */
(async function init() {
    try { db = await B.load(); } catch (e) { failed(e); }
    normalizeDb();

    setInterval(async () => {          // notificações novas a cada 30 s
        if (!me() || document.hidden) return;
        try { db.notifications = await B.notifs(); renderNotifBadge(); } catch (e) { /* ignora */ }
    }, 30000);

    $('processingMascot').src = MASCOT.sleepy;
    buildColorPicker($('colorPickerContainer'), () => selectedColor, c => { selectedColor = c; });
    setAuthMode('login');
    syncSearchInputs();
    route();
})();