# M.IRIS Cockpit — Admin-Dienst

Schlanker, zustandsloser Node/Express-Dienst für das [M.IRIS Cockpit](https://seryscmi.github.io/miris-cockpit/).
Alle Geheimnisse liegen **serverseitig**; das Cockpit-Frontend authentifiziert sich mit
einem Bearer-Token, CORS ist auf die Cockpit-Origin beschränkt.

Ausbaustufen (alle live): Bestellungen/Bilder · Anliegen + Chats aus der Neon-DB ·
Bestell-Aktionen (Mahnung, mark-paid, fulfill, cancel, Farbvorschau, Erstattung) ·
DSGVO-Löschung · Bank-Zahlungsabgleich (Enable Banking) · Produkte/Bestand/Rabatte/
Kunden lesen + bearbeiten · Direktverkauf (Draft Order → Bezahllink).
Die Tabelle unten zeigt nur die Kern-Endpoints; vollständige Liste in `server.js`.

## Endpoints

| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/health` | – | Uptime-Check |
| GET | `/admin/orders` | Bearer | Bestellungen (+ `miris`-Metafelder, Line-Item-Props, Tracking) in Cockpit-Form |
| GET | `/admin/images` | Bearer | Augenbilder je Bestellung (Cloudinary-public_id + Alter) |
| POST | `/admin/images/delete` | Bearer | Cloudinary-Asset löschen. Body: `{ "publicId": "...", "orderName": "B1027" }` |
| GET | `/admin/anliegen` | Bearer | Kundenanliegen aus der Neon-DB (+ PATCH/DELETE, POST `/:id/reply`) |
| GET | `/admin/chats` | Bearer | Chat-Verläufe aus der Neon-DB (+ Suche, DELETE) |

## Deploy auf Render (empfohlen, ~5 Min)

1. Dieses Repo (`seryscmi/miris-cockpit-api`) in Render als **Blueprint** öffnen
   (Dashboard → **New +** → **Blueprint** → Repo wählen). Render liest `render.yaml`.
2. Die **Secrets** eintragen (Dashboard → Service → *Environment*):
   - `SHOPIFY_SHOP` = `9zjzs5-ri.myshopify.com`
   - `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` – siehe unten
   - `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` – aus dem Cloudinary-Dashboard
3. `ADMIN_TOKEN` wird von Render **automatisch generiert** – kopiere den Wert
   (Environment → `ADMIN_TOKEN` → *Reveal*).
4. Nach dem Deploy hast du eine URL wie `https://miris-cockpit-api.onrender.com`.
5. Im **Cockpit → Einstellungen**: **Backend-URL** = diese URL, **Admin-Token** = der `ADMIN_TOKEN`.
   Fertig – „Live aktualisieren" holt jetzt echte Bestellungen.

> Hinweis Free-Tier: Der Dienst schläft nach ~15 Min Inaktivität ein; der erste Request danach
> dauert ~30–50 s. Für sofortige Antworten entweder den bezahlten Tarif nutzen oder `/health`
> alle 10 Min von einem kostenlosen Uptime-Pinger (z. B. cron-job.org) aufrufen lassen.

### Shopify-Zugang besorgen (client_credentials)
Seit Frühjahr 2026 gibt es keine statischen `shpat_…`-Token mehr. Stattdessen:
Shopify **Dev Dashboard** → App „Cockpit" → **Client ID + Client Secret** kopieren und als
`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` in Render eintragen. Der Dienst holt sich
damit selbst einen Access-Token (`client_credentials`-Grant, auto-erneuert alle 24 h).
Voraussetzung: Die App ist im Shop installiert und App + Shop gehören zur **selben
Organisation**. Als Fallback wird ein evtl. vorhandener `SHOPIFY_ADMIN_TOKEN` weiter
akzeptiert (`shopify.js`).

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
