---
sidebar_position: 6
---

# Running the Server

static-nix-cache can also run as a standalone HTTP server, implementing the full Nix binary cache API.

## Starting the Server

```bash
npm install
npm start          # listens on port 8080 by default
```

The server exposes the standard Nix binary cache HTTP endpoints:

- `GET /nix-cache-info` — cache metadata
- `GET /:hash.narinfo` — store path metadata
- `GET /nar/:filename` — NAR file download
- `PUT /:hash.narinfo` / `PUT /nar/:filename` — upload endpoints

## Push Store Paths

Use `nix copy` to push store paths to the running server:

```bash
nix copy --to 'http://localhost:8080?compression=none' /nix/store/<hash>-<name>
```

## Authentication

Set `UPLOAD_SECRET` to require a bearer token for PUT (upload) requests:

```bash
UPLOAD_SECRET=mysecret npm start
```

Then push with:

```bash
nix copy --to 'http://localhost:8080?secret=mysecret&compression=none' /nix/store/<hash>-<name>
```

## Running Tests

```bash
npm test
```
