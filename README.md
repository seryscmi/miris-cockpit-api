# M.IRIS Cockpit — Admin-Dienst (Phase 2)

Schlanker, zustandsloser Node/Express-Dienst für das [M.IRIS Cockpit](https://seryscmi.github.io/miris-cockpit/).
Er liest Bestellungen **live aus Shopify** und löscht Augenbilder **echt aus Cloudinary** –
und hält dabei alle Geheimnisse **serverseitig**. Das Cockpit-Frontend authentifiziert sich mit
einem Bearer-Token; CORS ist auf die Cockpit-Origin beschränkt.

## Endpoints

| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/health` | – | Uptime-Check |
| GET | `/admin/orders` | Bearer | Bestellungen (+ `miris`-Metafelder, Line-Item-Props, Tracking) in Cockpit-Form |
| GET | `/admin/images` | Bearer | Augenbilder je Bestellung (Cloudinary-public_id + Alter) |
| POST | `/admin/images/delete` | Bearer | Cloudinary-Asset löschen. Body: `{ "publicId": "...", "orderName": "B1027" }` |
| GET | `/admin/anliegen` | Bearer | Phase 3 (aktuell leer) |
| GET | `/admin/chats` | Bearer | Phase 3 (aktuell leer) |

## Deploy auf Render (empfohlen, ~5 Min)

1. Dieses Repo (`seryscmi/miris-cockpit-api`) in Render als **Blueprint** öffnen
   (Dashboard → **New +** → **Blueprint** → Repo wählen). Render liest `render.yaml`.
2. Die vier **Secrets** eintragen (Dashboard → Service → *Environment*):
   - `SHOPIFY_SHOP` = `9zjzs5-ri.myshopify.com`
   - `SHOPIFY_ADMIN_TOKEN` = dein Admin-API-Token (`shpat_…`) – siehe unten
   - `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` – aus dem Cloudinary-Dashboard
3. `ADMIN_TOKEN` wird von Render **automatisch generiert** – kopiere den Wert
   (Environment → `ADMIN_TOKEN` → *Reveal*).
4. Nach dem Deploy hast du eine URL wie `https://miris-cockpit-api.onrender.com`.
5. Im **Cockpit → Einstellungen**: **Backend-URL** = diese URL, **Admin-Token** = der `ADMIN_TOKEN`.
   Fertig – „Live aktualisieren" holt jetzt echte Bestellungen.

> Hinweis Free-Tier: Der Dienst schläft nach ~15 Min Inaktivität ein; der erste Request danach
> dauert ~30–50 s. Für sofortige Antworten entweder den bezahlten Tarif nutzen oder `/health`
> alle 10 Min von einem kostenlosen Uptime-Pinger (z. B. cron-job.org) aufrufen lassen.

### Shopify Admin-API-Token besorgen
Shopify-Admin → **Einstellungen → Apps und Vertriebskanäle → Apps entwickeln → App erstellen**
→ *Admin API access scopes*: `read_orders`, `write_orders` (für das Audit-Tag) →
*Install* → **Admin API access token** (`shpat_…`) kopieren.

## Lokal starten
```bash
npm install
cp .env.example .env   # Werte eintragen
npm start              # http://localhost:8080/health
```

## Tests
```bash
npm test               # Auth, CORS, Shopify-Mapping, Delete-Pfad (ohne echte Secrets)
```

## Sicherheit
- Secrets nur in ENV, nie im Code/Repo (`.env` ist ge-`.gitignore`-t).
- `/admin/*` erfordert `Authorization: Bearer <ADMIN_TOKEN>` (timing-safe geprüft).
- CORS strikt auf `ALLOWED_ORIGIN`. `helmet` + Rate-Limit (60/min).
