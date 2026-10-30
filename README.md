# CD Wishlist

Kleine self-hosted webapp om je CD-collectie en wishlist bij te houden: per band zie je wat je hebt en wat nog ontbreekt. Draait als Docker-container op Unraid en is alleen bereikbaar via Tailscale.

- Backend: Python / FastAPI, data in SQLite (`/mnt/user/appdata/cd-wishlist/wishlist.db`)
- Excel importeren (samenvoegen of vervangen) en exporteren
- Hoezen worden automatisch opgehaald via MusicBrainz / Cover Art Archive en lokaal bewaard
- Statussen: Gezocht → Gespot → Besteld → In bezit

## Installatie via GitHub (aanbevolen)

GitHub Actions bouwt bij elke push naar `main` de image `ghcr.io/planernl/wishlist:latest`. Unraid installeert die via de template in `unraid/cd-wishlist.xml`.

1. Repo `PlanerNL/wishlist` aanmaken en deze bestanden pushen.
2. Na de eerste build (tab *Actions*): op GitHub → *Packages* → `wishlist` → *Package settings* → visibility **Public** (anders moet Unraid inloggen bij ghcr.io).
3. Op Unraid (terminal):
   ```
   wget -O /boot/config/plugins/dockerMan/templates-user/my-cd-wishlist.xml \
     https://raw.githubusercontent.com/PlanerNL/wishlist/main/unraid/cd-wishlist.xml
   ```
4. Docker-tab → *Add Container* → template **cd-wishlist** kiezen.
5. Bij **Extra Parameters** (zet rechtsboven *Advanced View* aan) `100.x.y.z` vervangen door je Tailscale-IP → *Apply*.

Updaten: push naar GitHub, wacht tot de Action klaar is, dan in de Docker-tab *Check for Updates* → *Apply update*.

## Installatie op Unraid zonder GitHub (zelf bouwen)

1. **Bestanden op de server zetten**
   Pak de zip uit naar `/mnt/user/appdata/cd-wishlist-src/` (bijv. via de share of `scp`).

2. **Tailscale-IP opzoeken** (in de Unraid-terminal):
   ```
   tailscale ip -4
   ```
   Bijv. `100.101.102.103`.

3. **Image bouwen:**
   ```
   cd /mnt/user/appdata/cd-wishlist-src
   docker build -t cd-wishlist:latest .
   ```

4. **Container starten**, alleen gebonden aan het Tailscale-IP:
   ```
   docker run -d --name cd-wishlist --restart unless-stopped \
     -p 100.101.102.103:8080:8080 \
     -v /mnt/user/appdata/cd-wishlist:/data \
     -e TZ=Europe/Amsterdam \
     cd-wishlist:latest
   ```
   (Of met de Compose Manager-plugin: zet `TS_IP=100.101.102.103` in een `.env` naast `docker-compose.yml` en `docker compose up -d --build`.)

5. **Openen** op een apparaat in je tailnet: `http://100.101.102.103:8080`
   (of `http://<unraid-naam>:8080` als MagicDNS aan staat).

6. **Excel importeren:** klik op *Importeer* en kies `Wishlist_CDs.xlsx`.
   - `Check` in de eerste kolom → **In bezit**
   - een andere waarde (bijv. `Vinted`) → **Gespot**, met die waarde als bron
   - leeg → **Gezocht**
   - rijen zonder band of album (zoals de *Total*-rij) worden overgeslagen

## Controleren dat het alleen via Tailscale werkt

```
docker port cd-wishlist        # moet 100.x.x.x:8080 tonen, niet 0.0.0.0
curl -m 3 http://<LAN-IP-unraid>:8080   # moet falen
```

## Bekend aandachtspunt: opstartvolgorde

Als Docker na een reboot start voordat Tailscale zijn IP heeft, kan de container niet starten (`cannot assign requested address`). Oplossing: met de **User Scripts**-plugin een script *At Startup of Array*:
```
#!/bin/bash
for i in $(seq 1 30); do tailscale ip -4 >/dev/null 2>&1 && break; sleep 5; done
docker start cd-wishlist
```

## Updaten

```
cd /mnt/user/appdata/cd-wishlist-src
docker build -t cd-wishlist:latest .
docker rm -f cd-wishlist
# daarna het docker run-commando uit stap 4 opnieuw
```
Je data in `/mnt/user/appdata/cd-wishlist` blijft behouden.

## Backup

Alles staat in `/mnt/user/appdata/cd-wishlist` (database + hoezen). Via *Exporteer* in de app krijg je ook een Excel-bestand.

## Lokaal ontwikkelen

```
pip install -r requirements.txt
DATA_DIR=./data uvicorn app.main:app --reload --port 8080
```
