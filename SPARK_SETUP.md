# Настройка Fa1roxx Chat на бесплатном плане Spark

На Spark нельзя развернуть Cloud Functions, поэтому папка `functions/` **не используется**
(она нужна только на плане Blaze). Таблица лидеров и админ-панель владельца работают напрямую
через Firestore, а защиту дают правила ниже.

## Как добавить правила

1. Открой [Firebase Console](https://console.firebase.google.com/) → проект `discord-1641a`.
2. **Firestore Database → Rules**.
3. **Ничего не удаляй.** Вставь блок ниже внутрь `match /databases/{database}/documents { ... }`,
   прямо перед его закрывающей `}`.
4. Нажми **Publish**.

Правила Firestore складываются по принципу «ИЛИ»: новые блоки только *добавляют* разрешения
и не ломают то, что у тебя уже работает.

```
    // ---------- Fa1roxx: Spark plan (без Cloud Functions) ----------
    function isAppOwner() {
      return request.auth != null && request.auth.uid == "TyCwwKPAAQcjPI6pxCxHU693Ylj1";
    }

    // Таблица лидеров: каждый пишет только свой документ,
    // ровно +10 XP за запись и не чаще одного раза в 30 секунд.
    match /leaderboard/{uid} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.auth.uid == uid
        && request.resource.data.keys().hasOnly(["uid", "name", "xp", "level", "messages", "lastAwardAt"])
        && request.resource.data.uid == uid
        && request.resource.data.name is string && request.resource.data.name.size() <= 64
        && request.resource.data.xp == 10
        && request.resource.data.level == 1
        && request.resource.data.messages == 1
        && request.resource.data.lastAwardAt == request.time;
      allow update: if request.auth != null && request.auth.uid == uid
        && request.resource.data.keys().hasOnly(["uid", "name", "xp", "level", "messages", "lastAwardAt", "updatedAt"])
        && request.resource.data.uid == uid
        && request.resource.data.name is string && request.resource.data.name.size() <= 64
        && request.resource.data.xp == resource.data.xp + 10
        && request.resource.data.messages == resource.data.messages + 1
        && request.resource.data.level is int && request.resource.data.level >= 1 && request.resource.data.level <= 1000
        && request.resource.data.lastAwardAt == request.time
        && (!("lastAwardAt" in resource.data) || request.time > resource.data.lastAwardAt + duration.value(30, "s"));
    }

    // Админ-панель владельца приложения.
    match /servers/{sid} {
      allow read, update: if isAppOwner();
    }
    match /servers/{sid}/memberPermissions/{uid} {
      allow delete: if isAppOwner();
    }
    match /users/{uid}/achievements/{aid} {
      allow read: if request.auth != null;
      allow write: if isAppOwner();
    }
    match /globalBans/{uid} {
      allow read: if request.auth != null && (request.auth.uid == uid || isAppOwner());
      allow write: if isAppOwner();
    }
    match /adminAudit/{id} {
      allow read, create: if isAppOwner();
    }
    // ---------- конец блока Fa1roxx ----------
```

> Если в старых правилах уже есть `match /leaderboard/{uid}` с `allow write: if true` или похожим,
> удали его, иначе защита от накрутки XP работать не будет.

## Глобальный бан

Без Cloud Functions нельзя отключить аккаунт в Firebase Authentication. Поэтому сейчас глобальный бан
работает так: заблокированного пользователя **выкидывает из приложения при входе**.

Чтобы бан действовал и на уровне базы (даже если кто-то обойдёт сайт), добавь в свои правила
**записи** (`allow create`, `allow update`) сообщений и серверов условие:

```
&& !exists(/databases/$(database)/documents/globalBans/$(request.auth.uid))
```

## Лимиты Spark

Примерно 50 000 чтений и 20 000 записей в сутки. XP записывается не чаще раза в 30 секунд на человека,
так что сильно лимиты не тратит.

## Перенос старого XP

Раньше XP хранился только в браузере. Теперь он общий и начинается с нуля в таблице лидеров.
Купленные рамки в магазине сохраняются.
