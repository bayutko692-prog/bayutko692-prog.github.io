# MaskPhish — Web

Static web port of [jaykali/maskphish](https://github.com/jaykali/maskphish) (MIT).

**Everything runs in the browser.** There is no backend server, no API key,
and no telemetry. The target URL is sent directly from your browser to the
shortener.

## How the masking works

The original script builds a link shaped like:

```
https://masking-domain-words@short-host/alias
```

The segment before `@` is the URL *user-info* field. Browsers hide it in
the address bar and display only the real host, while the raw string still
reads like the masking domain.

## Fix vs. the original script

The original passes the target URL to the shortener unquoted:

```bash
short=$(curl -s https://is.gd/create.php\?format\=simple\&url\=${phish})
```

Any `&` in the target breaks it — `?user=test&pass=123` gets truncated to
`?user=test`. This port URL-encodes the target, so the full query string
survives.

## Deploy

Push the contents of `gh-pages` to a GitHub Pages branch. No build step.

## Credits

Original concept and bash implementation: **jaykali** — MIT License.
