const REPO = "riptidesim/riptide";
const RELEASE_ORIGIN = `https://github.com/${REPO}/releases`;
const ASSET_BASENAMES = [
  "riptide-x86_64-unknown-linux-gnu.tar.gz",
  "riptide-x86_64-apple-darwin.tar.gz",
  "riptide-aarch64-apple-darwin.tar.gz",
  "riptide-x86_64-pc-windows-msvc.zip",
];
const ALLOWED_ASSETS = new Set(
  ASSET_BASENAMES.flatMap((asset) => [asset, `${asset}.sha256`]),
);
const TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function upstreamForPath(pathname) {
  const parts = pathname.replace(/^\/releases\/?/, "").split("/").filter(Boolean);
  if (
    parts.length === 3 &&
    parts[0] === "latest" &&
    parts[1] === "download" &&
    ALLOWED_ASSETS.has(parts[2])
  ) {
    return `${RELEASE_ORIGIN}/latest/download/${parts[2]}`;
  }

  if (
    parts.length === 3 &&
    parts[0] === "download" &&
    TAG_RE.test(parts[1]) &&
    ALLOWED_ASSETS.has(parts[2])
  ) {
    return `${RELEASE_ORIGIN}/download/${parts[1]}/${parts[2]}`;
  }

  return null;
}

async function proxyReleaseAsset(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const upstream = upstreamForPath(new URL(request.url).pathname);
  if (!upstream) {
    return new Response("Not found\n", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const upstreamResponse = await fetch(upstream, {
    method: request.method,
    redirect: "follow",
  });
  const headers = new Headers(upstreamResponse.headers);

  for (const header of [
    "content-security-policy",
    "server",
    "set-cookie",
    "strict-transport-security",
    "transfer-encoding",
  ]) {
    headers.delete(header);
  }

  const path = new URL(request.url).pathname;
  headers.set(
    "cache-control",
    path.startsWith("/releases/download/") ? "public, max-age=86400" : "public, max-age=300",
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-riptide-release-proxy", "github");

  return new Response(request.method === "HEAD" ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/releases/")) {
      return proxyReleaseAsset(request);
    }
    return env.ASSETS.fetch(request);
  },
};
