<div align="center">
  <h1>Surge Geosite & GeoIP</h1>
  <p>Automatically converts <code>plsy1/v2ray-rules-dat</code> datasets and <code>Loyalsoldier/geoip</code> classical rules into ready-to-use Surge rules.</p>
  <p>
    English | <a href="./README.zh-CN.md">中文</a>
  </p>
  <p>
    <a href="https://surge.chisan1230.workers.dev"><strong>Open Dashboard</strong></a>
  </p>
</div>

<p align="center">
  <img src="./docs/assets/panel-dashboard.png" alt="Surge Geosite Dashboard" />
</p>

## Direct Use

1. Open the dashboard: https://surge.chisan1230.workers.dev.
2. Search and select a dataset (Geosite or GeoIP).
3. Copy the generated raw URL.
4. Paste it into your Surge rules.

If you want to use rule URLs directly, the format is:

- Geosite rules path: `https://surge.chisan1230.workers.dev/geosite/:name_with_filter`
- GeoIP rules path: `https://surge.chisan1230.workers.dev/geoip/:country` (e.g. `/geoip/cn`)

`name_with_filter` has two forms:

- Without filter: `apple`
  Returns the full rules for the `apple` dataset.
- With filter: `apple@cn`
  Returns only rules tagged with `@cn`.

Surge example:

```ini
[Rule]
RULE-SET,https://surge.chisan1230.workers.dev/geosite/apple@cn,DIRECT
RULE-SET,https://surge.chisan1230.workers.dev/geosite/strict/category-ads-all,REJECT
RULE-SET,https://surge.chisan1230.workers.dev/geoip/cn,DIRECT
```

## Advanced Usage

### API

#### Geosite
- `GET /geosite`
- `GET /geosite/:name_with_filter` (default mode: `balanced`)
- `GET /geosite/:mode/:name_with_filter`

#### GeoIP
- `GET /geoip`
- `GET /geoip/:country` (returns raw rules list for country code)

### Mode Guide

- `strict`: only lossless regex conversion
- `balanced`: controlled downgrade (default)
- `full`: most permissive conversion (widest coverage, highest over-match risk)

## For Maintainers

Local dev:

```bash
pnpm install
pnpm build
pnpm test
pnpm panel:dev
pnpm worker:dev
```

Deploy:

```bash
pnpm panel:deploy
pnpm worker:deploy
```

Technical architecture: [docs/architecture.md](./docs/architecture.md)
