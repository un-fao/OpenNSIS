# OpenNSIS — news

A chronological record of user-visible features and notable changes, newest
first. Entries describe what changed for people using or administering an
instance; implementation detail stays in the git history. Dates are the day
the change landed on `main`.

## November 2026

### 2026-11-13 — Three more workshop presentations in Portuguese
Three further Portuguese presentations sit in `docs/presentations/`,
prepared for the Mozambique workshop: `pt-glosis.html` (what GloSIS is,
the shared vocabulary, and how a national system joins the federation),
`pt-partilha-de-dados-e-licencas.html` (data-sharing principles, the
Creative Commons licences, and the sharing and licence controls in
OpenNSIS) and `pt-alojamento-do-servidor.html` (hosting options, server
requirements, installation, routine operation and the people needed).
Their examples and figures come from the Mozambique demonstration
instance.

### 2026-11-13 — Workshop presentation in Portuguese
The standards presentation, *Open Standards for Soil Data*, gained a
Portuguese edition next to the English and Spanish ones:
`docs/presentations/pt-normas-abertas-para-dados-de-solo.html`. Its live
examples (the metadata record, the WMS request and the QGIS connection)
use the Mozambique demonstration instance, and it presents the system as
it stands this month, including the public website, laboratory (LIMS)
imports, sampling designs, the catalogue page and cached raster tiles.

### 2026-11-13 — Account lockout now takes effect
The lock after five failed sign-ins, documented since May, never engaged:
the failed-attempt count was discarded together with the "incorrect
username or password" answer, so it never rose above one. It is now
recorded, and an account is locked for 15 minutes after five consecutive
failures, as described; attempts arriving in parallel cannot get more
than five passwords tested. Signing in with a user name that does not
exist used to answer with a server error, which told real user names
from invented ones; it now gets the same generic answer as a wrong
password and is written to the audit log. Administrators should know
that a locked account unlocks only by waiting: there is no manual
unlock.

The raster tile cache introduced the day before no longer forwards
cookies to MapServer. MapServer reads cookies as request parameters, so
a crafted request could have made nginx store a different image under a
genuine tile's address for every visitor. The stored tiles on all
instances were compared with fresh renders and none had been altered.
The admin panel's "Check WMS" button now asks MapServer directly instead
of being answered from that cache.

### 2026-11-12 — Faster map, second pass
Raster layers are now drawn from fixed 512-pixel tiles instead of one
image per view, and nginx keeps a server-side copy of every tile and
legend it has served. Panning loads only the tiles that come into view,
and returning to an area or zoom level already seen loads nothing; a
tile is rendered by MapServer once and then served to every visitor from
the cache (kept 30 days, renewed automatically when a layer's pixels or
styling change). Click values are unchanged: a click still returns the
raster value under the pointer.

nginx also keeps TCP's sending window open across idle moments on a
reused connection. Linux resets it by default, which made every image,
tile and API answer start slowly again; for a visitor 190 ms away this
alone cut raster loading time by about 40 %. It needs a Linux kernel of
4.15 or newer; `update.sh` checks, and on an older kernel keeps the
running nginx and says so.

Pages are lighter. The admin panel's code is fetched only when someone
signs in, and only the language in use is downloaded, not all six: the
map page went from 242 KB to 140 KB of compressed JavaScript and the
landing page from 79 KB to 20 KB.

### 2026-11-12 — Faster map page
The map opens two to three times faster. Its start-up requests (settings,
layers, profiles, boundaries, sampling designs) are now sent together
instead of one after another; each used to wait a full network round trip
for the previous one, which is why even an instance with no data took
almost two seconds on a distant connection. Raster images and legends are
now kept by the browser for 30 days: their addresses already carried a
version token that changes whenever a layer's pixels or styling change,
but the map server's blanket `no-store` header defeated it, so a
one-megabyte image was downloaded again on every visit. The OpenLayers
stylesheet is served by the instance itself instead of a third-party CDN.
Measured against the workshop server over a 190 ms connection, a repeat
visit drops from about 1.8 s to 0.7 s on an empty instance and from 2.6 s
to 1.2 s on one with data; a first visit from about 3.0 s to 2.1 s and
from 4.2 s to 2.7 s.

`update.sh` now applies nginx changes properly: it recreates the nginx
container when its service definition changed and restarts it when
`nginx.conf` changed, after validating the new file. It used to only
reload nginx, which never picked up a pulled configuration. Servers
updated with the older script should run `./update.sh` twice once — see
the README's update section.

### 2026-11-12 — Public website live by default
A fresh instance now serves the public website out of the box — header
and footer with every page (Home, About, News, Map, Catalogue,
Statistics, People, Contact), the default hero image and built-in
texts — instead of hiding everything behind the first Publish. All
pages are published by default, even when empty: About falls back to
the standard system description and People/Contact to a short default
line until real content is written, and a page disappears only when
explicitly unpublished from its Website sub-tab. Instances that had
never published a website go live with these defaults (migration 039);
anything an admin has published or unpublished is left exactly as it
was, and the site can still be taken offline by unpublishing Home from
Website → Home. The header also gained
an **Admin Panel** entry while signed in (it disappears on logout), and
About, People, Contact and the Admin Panel now share the same page
heading style as the rest of the site.

### 2026-11-12 — News page
The public website gained a blog: a **News** page listing posts newest
first, each with its title, author, editable ISO date (YYYY-MM-DD), body
and lowercase **tags** (suggested from the tags already in use). Posts are
written from a new Website → News sub-tab: the editor opens only from the
**New post** button or a row's **Edit**, and each row carries its own
**Edit / Publish / Delete** actions, independent of the site's
draft/publish flow. The Markdown body has a formatting toolbar — bold,
italic, heading, list, link and three image buttons that upload a picture
through the site media pipeline and insert it inline at full width or
floated left/right at a third of the column with the text wrapping around
it. The public page offers a search box with the matched text highlighted
in the posts, plus multi-select **Year** and **Tag** filter pills, all in
a sticky sidebar on the right; the same highlighting and sidebar layout
now also apply to the Catalogue page's search and filters. Like every
other page, News is published by default; its header and footer link can
be hidden from the Website → News sub-tab (migrations 037 and 038).

### 2026-11-11 — Catalogue page
The metadata catalogue became a proper public page at `/catalogue`, replacing
the link out to pyCSW's bare records UI. Every record of the instance is
listed as a card — thumbnail, title, resource type, theme, licence, year and
keyword chips, with the GeoTIFF download and WMS links attached — in the
site's own design and all six interface languages, fed live from the pyCSW
OGC API Records endpoint (the same ISO records held in `soil_data.mapset`).
A search box plus multi-select **Year** and **Keyword** filter pills narrow
the list (choices within a row combine as OR, rows and search as AND), and
the keyword chips on each card toggle the same selection. Clicking a record
opens the map view's metadata popup — abstract, preview, identification,
spatial details, statistics, contacts, online resources and the XML
download — now shared between the two pages; records without a raster
behind them render from the catalogue record itself. The header, footer,
landing quick-card and hero button all point at the new page, and its
visibility stays controlled from Website → Catalogue.

### 2026-11-10 → 11-11 — Landing page redesign and single-language content
The public landing page was rebuilt: a full-width hero over the uploaded
image, quick-link cards (map, catalogue, statistics), an About band, and a
shared footer that now closes every public page. The header shows the
current language code on the globe button, with a consistent control order
(sign-in, theme, language). The public Dashboard page was renamed
**Statistics** in all six interface languages (the `/dashboard` address is
unchanged), and the Sampling design tab reads **Pontos de amostragem** in
Portuguese and **Puntos de muestreo** in Spanish. Website content became
**single-language**: text is published exactly as entered — an address or
a phone number is content, not something to translate — and existing
per-language values are flattened to the instance language on the next
publish. Public pages now open in the instance's configured language
rather than defaulting to English, and selected text is readable in dark
mode.

### 2026-11-10 — Website tab: pages, per-page publishing, unified header
The Website admin tab grew into a full site editor with a sub-tab per
page: Home, About, People (team cards with photos and per-person publish),
Contact (structured address / e-mail / phone with obfuscation, plus a
Markdown body), Catalogue, Statistics and Map — each with its own Preview
and Publish/Unpublish (the Map page's publish toggles its header link).
Saving a page that is already live republishes it immediately; page order
is configurable and the top navigation follows it, with unpublished pages
simply absent. Version history was replaced by a single published copy
(migration 036). The admin panel moved to `/admin` (no map flash,
back-button support), and instance settings — title, language, logo,
colours, map position / zoom / base map — moved from Administration to the
Website tab's General and Map sub-tabs, where a view editor frames exactly
the extent the public map will show and mirrors latitude / longitude /
zoom live as the map moves. One shared header now spans the landing page,
sub-pages, Statistics and the map.

### 2026-11-09 → 11-10 — Sampling design (SoilFER three-stage CSC)
A new admin tab generates SoilFER three-stage cell-stratified sampling
designs (migrations 034–035): draw the region of interest as polygons on
the map (with erase; an equal-area LAEA projection replaces UTM), covariates
are fetched ephemerally — nothing is stored beyond a per-unit snapshot
shown in map popups — and a live run log reports progress and failures.
Finished designs are publishable map layers with a per-layer symbology
editor (targets, replacements, PSU and SSU cells), clickable features,
editable names, an auto-generated abstract, and point / cell export. The
method follows the SoilFER sampling-design implementation
(github.com/un-fao/SoilFER), linked from the tab.

## October 2026

### 2026-10-28 — Public landing page (issue #13, v1)
Each instance can now publish a public website at its root address, edited
from a new admin **Website** tab: headline, subtitle, hero image, an About
section and footer written in Markdown, logo and theme colours — all
per-language with the same fallback as the rest of the interface. Content is
edited as a draft, published as an immutable version and restorable with one
click; Markdown is rendered and sanitised server-side, and uploaded images
are re-encoded before being served. The map lives permanently at `/map`;
while the landing page is disabled (the default), the root address simply
forwards there. The page ships with a stylised soil-profile artwork so it
looks presentable before any image is uploaded. This feature is in active
development: news, partners and navigation editing are planned follow-ups.

### 2026-10-27 — Laboratory measurement quality
The database and the LIMS connector now carry per-procedure measurement
quality: uncertainty (with coverage factor), limit of detection and limit of
quantification, stored on the observation catalogue in canonical units and
republished through the GloSIS API. Censored laboratory results (below
detection or quantification, above range) are ingested as explicit `<LOD` /
`<LOQ` / `>RANGE` markers with no substituted numbers — previously they were
silently dropped.

### 2026-10-21 — Catalogue licences for harvesters
Every record's licence now appears in the OGC API Records JSON that
harvesters such as the GloSIS Discovery Hub read (an upstream pyCSW bug
dropped it from list responses; patched in our image). The map layer panel
also adopted the Discovery Hub's document glyph for metadata links.

### 2026-10-19 — ETL and raster publishing improvements
- **Errors-only review**: after validation, a user-activated filter shows
  every row of each soil profile that has an error anywhere in it — whole
  profiles, because the flagged cell is not always the one holding the
  mistake. Depth-continuity breaks now flag both adjacent layers.
- **Upload template**: a ready-made spreadsheet for soil profile CSVs, with
  all validation rules documented on a second sheet
  (`docs/templates/`, also served from the project website).
- **Categorical legends**: uploading a raster for a categorical property
  seeds a legend from the values actually present in the raster (never a
  min–max fill), ready to rename and recolour in the legend editor.
- **Licences spelt out**: dropdowns show the full licence names
  (e.g. "CC BY 4.0 - Attribution 4.0 International") and link to
  creativecommons.org.

### 2026-10-16 — One-click GloSIS Discovery Hub connection
Joining the GloSIS federation became a single **Connect** button: the node
registers itself with the Discovery Hub, the hub administrator approves, and
the panel shows the live status. **Disconnect** pauses sharing without
losing the listing or approval. The old manual flow (enable, copy the token
and endpoint URLs to the hub by hand) is gone. Supporting fixes: federation
API filters (`bbox`, `property`, `profile_code`), nginx routing for `/csw`
and `/glosis/`, and restored read grants for the federation role.

### 2026-10-13 — Terroir interface restyle
A full visual redesign of the map and admin interface — typography, colour
tokens, light and dark themes — together with the keyword-pill map dialogue
(accumulative property and year filters with derived keyword hierarchy),
grouped raster layer panel with per-year tabs, a floating/dockable profile
data table with a per-profile report view, and fixes for user deletion with
staged uploads and dark-mode legends.

## September 2026

### 2026-09-30 — LIMS connector and ETL robustness
Fetching released samples from a laboratory (LIMS) into the ETL became more
forgiving and better documented: laboratory context shown beside the mapping
dropdowns, re-ingesting the same samples updates rather than fails, one bad
row no longer aborts a whole ingest, and a "Partial" dataset status records
incomplete runs. Licence fields across the admin gained Creative Commons
links.

### 2026-09-23 — Chain-of-custody identifiers
Specimens carry field and laboratory sample identifiers end to end (CSV →
database → API), and datasets fetched from a laboratory API must map the lab
sample ID — legacy CSVs are not burdened with that requirement.

### 2026-09-21 — Dark mode
The whole web application gained a dark theme: a sun/moon toggle, tokenised
colours across the map, popups, admin tables and form controls, and the
visitor's choice remembered. The ETL also learnt to treat NA/NaN/N/A/null as
missing values in numeric columns.

### 2026-09-03 → 09-10 — Map chrome, symbology and boundary layers
A broad map-view polish: stroke-drawn control icons (north arrow, zoom,
scale bar, login), a floating header, per-project soil-profile symbology
(the brown profile-bar marker as default, clusters included), admin-defined
layer ordering, profile clicks opening the attribute table, and a
collapsed-by-default layer panel option. Administrative division boundary
layers became fully styleable: KML/KMZ accepted alongside GeoJSON, zipped
Shapefile and GeoPackage, with text labels from an uploaded attribute, fill
opacity, zoom thresholds and default-on toggles. Workshop presentations
(EN+ES) joined the repository.

### 2026-09-02 — Dynamic legends and the legend editor
Rasters gained a live map legend with a value cursor that streams the pixel
value under the pointer, and an admin legend editor: per-class colours and
labels for categorical rasters, custom class breaks for quantitative ones,
per-layer default opacity, and the EOX Terrain Light hillshade base map.

## August 2026

### 2026-08-27 — OpenNSIS, officially
The project moved to the official UN-FAO organisation as
**un-fao/OpenNSIS** (renamed from SIS-dev), with a GitHub Pages showcase
site, contribution guidelines and issue templates. `update.sh` re-points
stale clones to the new home automatically.

### 2026-08-24 — Six languages and safer administration
Internationalisation landed in two phases and five new languages: Spanish,
French, Portuguese, Russian and Chinese alongside English, with a globe
switcher on the map and in the admin panel and a per-instance default
language setting. User management gained guardrails (admin-rights toggle,
protected default admin, honest error reporting), and deployments an
optional automatic-HTTPS front (Caddy) for single-country servers.

### 2026-08-09 → 08-11 — Boundary layers and data integrity
First release of **Administrative divisions**: upload boundary files, style
them, and publish them as map layers (with on-the-fly reprojection and clear
refusal of unknown CRSes). Plot/profile identity moved from codes to ids,
stopping cross-project capture of same-named profiles, and single-instant
mapset time periods became legal (real single-date surveys exist).

## July 2026

### 2026-07-03 — Projects tab, COGs and licensing
Project management became a first-class admin tab (create, edit, delete,
reassign). A licence became compulsory before soil profiles can be
validated and ingested. All rasters — uploads and raster-calculator outputs
alike — are stored as true Cloud-Optimised GeoTIFFs (DEFLATE, tiled, with
**nearest-neighbour** overviews, deliberately chosen so categorical values
survive resampling). ETL ingest gained per-row savepoints and friendlier
CSV handling.

## June 2026

### 2026-06-29 — In-place updates and privacy controls
The update mechanism arrived: `update.sh` (git pull + idempotent migrations +
app-only rebuild, data preserved) with the `sis-database/migrations/` ledger,
and a read-only **Software update** panel comparing the running version with
GitHub. Soil-profile privacy controls followed: per-project publication
caps, spatial blur with a map warning (radius never exposed), and a
"share locations only" mode that publishes points but withholds
observations. The DST tab was renamed **Raster calculator**.

### 2026-06-08 → 06-26 — Raster calculator, hardened
The raster calculator (DST engine) was completed and then hardened for real
workloads: streamed inputs with bounded memory, orphaned-run recovery,
structured error reporting, an HSV green→red colour ramp, and upload limits
raised to 1 GB. Multi-country workshop installs got dedicated fixes
(country resolved from the project, not the environment) and the first
workshop landing page went up.

## May 2026

### 2026-05-06 → 05-20 — Raster publishing and federation foundations
Raster upload arrived end to end: GeoTIFF upload with metadata capture, an
ISO 19139 record in the catalogue and a generated mapfile per layer, plus
automatic unit conversion against the canonical observation units. The
GloSIS federation connection got its first token mechanism, and security
hardening landed: secrets generated per deployment and `.env` removed from
tracking. ETL validation grew depth, coordinate and country-boundary rules.

## April 2026

### 2026-04-14 → 04-20 — Foundations
The core of the system took shape: the REST API (`sis-api`) and the
read-only federation API (`sis-api-glosis`), a fully functional soil-profile
ETL (upload → preview → describe → map columns → validate → ingest), the
statistics dashboard, publication caps and spatial blur, metadata keywords
flowing into the catalogue, and the default admin bootstrap. Earlier
foundations (the ISO 28258 database derived from ISRIC's iso-28258, the map
viewer and the pyCSW catalogue) date from the project's first months in
late 2025.
