/* =====================================================
   BÉDIA - Ligação à base de dados (Supabase)
   Fica na mesma pasta do index.html. Carrega ANTES do script.js.
   ===================================================== */
'use strict';

const SUPABASE_URL = 'https://xnrmfpuhktabeqlcraaw.supabase.co';
const SUPABASE_ANON_KEY = 'COLA-AQUI-A-CHAVE-COMPLETA';   // <<< Project Settings > API Keys > Publishable key (copiar)
const BUCKET = 'art';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const must = (r) => { if (r.error) throw r.error; return r.data; };
const ts = (v) => (v ? new Date(v).getTime() : null);
const idToKey = new Map();   // uuid -> chave (nome de utilizador em minúsculas)

// caminho dentro do bucket, a partir do URL público
const pathOf = (url) => {
    const m = String(url || '').split('/object/public/' + BUCKET + '/')[1];
    return m ? decodeURIComponent(m.split('?')[0]) : null;
};

async function upload(path, blob) {
    must(await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' }));
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// miniatura (~500 px) a partir de um dataURL ou URL de objeto
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
    me: null,   // { id, key } do utilizador com sessão

    /* ---------- LER TUDO (mesmo formato que o script.js já usa) ---------- */
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

    /* ---------- CONTA ---------- */
    async signUp(handle, email, password, color) {
        const free = await sb.rpc('handle_free', { h: handle });
        if (free.error) return { error: 'Sem ligação ao servidor.' };
        if (!free.data) return { error: 'Esse nome de utilizador já está em uso.' };
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { handle, color } } });
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
        return error ? { error: 'Utilizador ou senha incorretos.' } : {};
    },

    async signOut() { await sb.auth.signOut(); this.me = null; },

    async saveProfile({ bio, link, color, avatarDataUrl }) {   // avatarDataUrl: undefined = igual, null = remover, string = nova
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
        // apaga os ficheiros diretos e as subpastas (uma por obra)
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

    /* ---------- OBRAS ---------- */
    async publish(meta, pages) {   // meta: {title, category, description, tags, nsfw} · pages: dataURLs
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
            if (done.length) await sb.storage.from(BUCKET).remove(done);   // não deixa imagens órfãs
            throw e;
        }
    },

    async updatePost(post, meta, newOrder) {   // newOrder: URLs das páginas pela nova ordem (a 1.ª é a capa)
        const patch = { ...meta, edited_at: new Date().toISOString() };
        if (newOrder && newOrder.length === post.images.length) {
            patch.images = newOrder;
            if (newOrder[0] !== post.images[0]) {   // capa mudou: nova miniatura
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

    /* ---------- INTERAÇÕES ---------- */
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