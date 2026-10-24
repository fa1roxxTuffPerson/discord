const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("node:crypto");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 5 });
const db = admin.firestore();
const OWNER_UID = "TyCwwKPAAQcjPI6pxCxHU693Ylj1";

function requireOwner(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Войдите в аккаунт.");
  if (request.auth.uid !== OWNER_UID) throw new HttpsError("permission-denied", "Только владелец приложения может выполнить это действие.");
}
function str(value, label, max = 128) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpsError("invalid-argument", `Некорректное поле: ${label}`);
  return value.trim();
}
async function targetUser(uid) {
  if (uid === OWNER_UID) throw new HttpsError("failed-precondition", "Нельзя применять модерацию к владельцу приложения.");
  try { return await admin.auth().getUser(uid); }
  catch (e) { if (e.code === "auth/user-not-found") throw new HttpsError("not-found", "Аккаунт Firebase Authentication не найден."); throw e; }
}

exports.ownerLookupUser = onCall(async request => {
  requireOwner(request);
  const uid = str(request.data?.uid, "uid", 128);
  let authUser;
  try { authUser = await admin.auth().getUser(uid); }
  catch (e) { if (e.code === "auth/user-not-found") throw new HttpsError("not-found", "Аккаунт не найден."); throw e; }
  const [profileSnap, achSnap, banSnap, serverSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(), db.collection(`users/${uid}/achievements`).get(),
    db.doc(`globalBans/${uid}`).get(), db.collection("servers").where("members", "array-contains", uid).get()
  ]);
  const profile = profileSnap.exists ? profileSnap.data() : {};
  return {
    uid, name: profile.name || authUser.displayName || "", email: authUser.email || "",
    disabled: authUser.disabled, globalBanned: banSnap.exists,
    achievements: achSnap.docs.map(d => { const a = d.data(); return { id: d.id, name: a.name || "", icon: a.icon || "🏆", description: a.description || "" }; }).slice(0, 50),
    servers: serverSnap.docs.map(d => ({ id: d.id, name: d.data().name || "Сервер" }))
  };
});

exports.ownerListServers = onCall(async request => {
  requireOwner(request);
  const snap = await db.collection("servers").get();
  return { servers: snap.docs.map(d => ({ id: d.id, name: d.data().name || "Сервер", members: Array.isArray(d.data().members) ? d.data().members.length : 0 })).slice(0, 500) };
});

exports.ownerSetAchievement = onCall(async request => {
  requireOwner(request);
  const uid = str(request.data?.uid, "uid", 128);
  await targetUser(uid);
  const name = str(request.data?.name, "name", 60);
  const icon = typeof request.data?.icon === "string" ? request.data.icon.slice(0, 12) : "🏆";
  const description = typeof request.data?.description === "string" ? request.data.description.slice(0, 160) : "";
  const id = crypto.randomUUID();
  await db.doc(`users/${uid}/achievements/${id}`).set({ name, icon: icon || "🏆", description, grantedBy: OWNER_UID, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await db.collection("adminAudit").add({ actor: OWNER_UID, action: "achievement_grant", targetUid: uid, achievementId: id, name, at: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, id };
});

exports.ownerRemoveAchievement = onCall(async request => {
  requireOwner(request);
  const uid = str(request.data?.uid, "uid", 128);
  const achievementId = str(request.data?.achievementId, "achievementId", 128);
  await targetUser(uid);
  await db.doc(`users/${uid}/achievements/${achievementId}`).delete();
  await db.collection("adminAudit").add({ actor: OWNER_UID, action: "achievement_revoke", targetUid: uid, achievementId, at: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});

exports.ownerBanServer = onCall(async request => {
  requireOwner(request);
  const uid = str(request.data?.uid, "uid", 128), serverId = str(request.data?.serverId, "serverId", 128);
  const target = await targetUser(uid);
  const ref = db.doc(`servers/${serverId}`), snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Сервер не найден.");
  const s = snap.data();
  if (s.owner === uid) throw new HttpsError("failed-precondition", "Нельзя забанить владельца сервера.");
  await ref.update({ members: admin.firestore.FieldValue.arrayRemove(uid), [`names.${uid}`]: admin.firestore.FieldValue.delete(), [`bn.${uid}`]: target.displayName || target.email || uid });
  await db.collection("adminAudit").add({ actor: OWNER_UID, action: "server_ban", targetUid: uid, serverId, at: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});

exports.ownerUnbanServer = onCall(async request => {
  requireOwner(request);
  const uid = str(request.data?.uid, "uid", 128), serverId = str(request.data?.serverId, "serverId", 128);
  await targetUser(uid);
  const ref = db.doc(`servers/${serverId}`), snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Сервер не найден.");
  await ref.update({ [`bn.${uid}`]: admin.firestore.FieldValue.delete() });
  await db.collection("adminAudit").add({ actor: OWNER_UID, action: "server_unban", targetUid: uid, serverId, at: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});

exports.ownerGlobalBan = onCall(async request => {
  requireOwner(request);
  const uid = str(request.data?.uid, "uid", 128), reason = typeof request.data?.reason === "string" ? request.data.reason.slice(0, 240) : "";
  const target = await targetUser(uid);
  await db.doc(`globalBans/${uid}`).set({ uid, reason, actor: OWNER_UID, wasDisabled: target.disabled, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await admin.auth().updateUser(uid, { disabled: true });
  await admin.auth().revokeRefreshTokens(uid);
  await db.collection("adminAudit").add({ actor: OWNER_UID, action: "global_ban", targetUid: uid, reason, at: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});

exports.ownerGlobalUnban = onCall(async request => {
  requireOwner(request);
  const uid = str(request.data?.uid, "uid", 128);
  if (uid === OWNER_UID) throw new HttpsError("failed-precondition", "Недопустимый UID.");
  const ref = db.doc(`globalBans/${uid}`), snap = await ref.get();
  if (!snap.exists) return { ok: true, alreadyUnbanned: true };
  const wasDisabled = snap.data().wasDisabled === true;
  await ref.delete();
  if (!wasDisabled) await admin.auth().updateUser(uid, { disabled: false });
  await db.collection("adminAudit").add({ actor: OWNER_UID, action: "global_unban", targetUid: uid, at: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});


// XP is awarded server-side; browser clients cannot grant themselves experience.
async function awardMessageXp(event) {
  const m = event.data?.data();
  if (!m || typeof m.uid !== "string" || !m.uid || m.uid === "system") return;
  const meaningful = (typeof m.text === "string" && m.text.trim().length >= 2) || !!m.img || !!m.vid || !!m.file || !!m.aud;
  if (!meaningful || m.threadRoot) return;
  const uid = m.uid;
  const lbRef = db.doc(`leaderboard/${uid}`);
  const statsRef = db.doc(`users/${uid}/stats/progress`);
  const profileRef = db.doc(`users/${uid}`);
  const profile = await profileRef.get();
  const name = (profile.exists && profile.data().name) || m.name || "Пользователь";
  await db.runTransaction(async tx => {
    const snap = await tx.get(lbRef);
    const old = snap.exists ? snap.data() : {};
    const now = Date.now();
    const last = old.lastAwardAt?.toMillis ? old.lastAwardAt.toMillis() : 0;
    if (now - last < 30000) return;
    const xp = Number(old.xp || 0) + 10;
    const level = Math.floor(Math.sqrt(xp / 100)) + 1;
    const payload = { uid, name, xp, level, messages: Number(old.messages || 0) + 1, lastAwardAt: admin.firestore.Timestamp.fromMillis(now), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    tx.set(lbRef, payload, { merge: true });
    tx.set(statsRef, { xp, level, messages: payload.messages, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
}
exports.awardServerMessageXp = onDocumentCreated("servers/{serverId}/channels/{channelId}/messages/{messageId}", awardMessageXp);
exports.awardDirectMessageXp = onDocumentCreated("friends/{friendId}/messages/{messageId}", awardMessageXp);
