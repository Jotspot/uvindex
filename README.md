# UV Index

A little PWA that shows the UV index for wherever you are (or wherever you search), plus a chart of how it changes over the day. Started as a Figma mockup and turned into an actual working app.

Live at: https://jotspot.github.io/uvindex/

## What it does

- Current UV index + category (Low / Moderate / High / Very High / Extreme), color-coded to the real WHO scale
- A curve of today's UV by hour, colored by actual severity at each point — not just decoration
- Today's peak UV, and roughly how long until you'd burn (fair skin, not medical advice, just a rough guide)
- Search any city, or tap the locate button to use wherever you are
- Installable to your home screen on iOS/Android, works offline once it's loaded at least once
- Refreshes itself every 10 minutes so it doesn't go stale if you leave it open

## Running it locally

No build step, no dependencies — it's just HTML/CSS/JS. You can open `index.html` straight in a browser, but the service worker and geolocation need a real origin to work, so it's better to serve the folder:

```
python3 -m http.server
```

then visit `localhost:8000`.

## Where the data comes from

UV numbers come from [currentuvindex.com](https://currentuvindex.com/) — free, no API key. Open-Meteo fills in the timezone name and today's real sunrise/sunset (currentuvindex.com doesn't provide either), and its geocoding API powers city search. "Use my location" reverse-geocodes through [BigDataCloud](https://www.bigdatacloud.com/). All free, all keyless.

## Deploying

Pushes to `main` auto-deploy to GitHub Pages through the workflow in `.github/workflows/pages.yml`.
